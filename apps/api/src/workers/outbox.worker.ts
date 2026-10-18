import { processOutboxBatch, type OutboxHandler } from "../services/outbox.service.js";
import { db } from "@repo/db";
import { outboxQueue } from "../queues/outbox.queue.js";

export class OutboxWorker {
  private intervalTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isRunning = false;

  constructor(
    private readonly pollIntervalMs: number = 3000,
    private readonly handler?: OutboxHandler,
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.intervalTimer = setInterval(() => {
      this.poll();
    }, this.pollIntervalMs);

    // Initial tick
    this.poll();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.isProcessing || !this.isRunning) return;
    this.isProcessing = true;

    try {
      await this.reconcileStaleClaims();
      let count: number;
      do {
        count = await processOutboxBatch(this.handler);
      } while (count > 0 && this.isRunning);
    } catch (err) {
      console.error("[OutboxWorker] Error processing outbox events:", err);
    } finally {
      this.isProcessing = false;
    }
  }

  private async reconcileStaleClaims(): Promise<void> {
    const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
    const staleEvents = await db.outboxEvent.findMany({
      where: {
        status: "PROCESSING",
        lockedAt: { lt: staleBefore },
      },
      orderBy: { lockedAt: "asc" },
      take: 50,
      select: { id: true, lockedAt: true },
    });

    for (const event of staleEvents) {
      const job = await outboxQueue.getJob(event.id);
      if (job) {
        const state = await job.getState();
        if (state === "completed") {
          await db.outboxEvent.updateMany({
            where: { id: event.id, status: "PROCESSING" },
            data: {
              status: "PROCESSED",
              processedAt: job.finishedOn ? new Date(job.finishedOn) : new Date(),
              lockedAt: null,
              lastError: null,
            },
          });
        } else if (state === "failed") {
          await db.outboxEvent.updateMany({
            where: { id: event.id, status: "PROCESSING" },
            data: {
              status: "FAILED",
              lockedAt: null,
              lastError: job.failedReason || "Queue job failed",
            },
          });
        }
        continue;
      }

      await db.outboxEvent.updateMany({
        where: {
          id: event.id,
          status: "PROCESSING",
          lockedAt: event.lockedAt,
        },
        data: {
          status: "PENDING",
          availableAt: new Date(),
          lockedAt: null,
          lastError: "Recovered stale outbox claim without a queue job",
        },
      });
    }
  }
}
