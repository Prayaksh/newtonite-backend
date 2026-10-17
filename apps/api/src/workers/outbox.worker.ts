import { processOutboxBatch, type OutboxHandler } from "../services/outbox.service.js";

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
}

