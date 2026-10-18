import { db } from "@repo/db";

export type OutboxHandler = (event: {
  id: string;
  type: string;
  payload: any;
  workItemId: string | null;
  teamId: string | null;
}) => Promise<void>;

// Default handler for outbox events (simulates external dispatch: email, Slack, webhooks)
export const defaultEventHandler: OutboxHandler = async (event) => {
  // In production, dispatch to Slack, webhooks, or notification queues
  // For demo/system integration, log structured delivery
  console.log(`[Outbox] Dispatched event ${event.id} of type ${event.type} for work item ${event.workItemId}`);
};

export async function processOutboxBatch(
  handler: OutboxHandler = defaultEventHandler,
  batchSize: number = 20,
): Promise<number> {
  const now = new Date();

  // Find candidate events that are pending and available for processing
  const candidates = await db.outboxEvent.findMany({
    where: {
      status: "PENDING",
      availableAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    include: { workItem: { select: { teamId: true } } },
  });

  if (candidates.length === 0) {
    return 0;
  }

  let processedCount = 0;

  for (const event of candidates) {
    // Claim the event
    const claimed = await db.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: "PENDING",
      },
      data: {
        status: "PROCESSING",
        lockedAt: now,
        attempts: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      continue; // Claimed by another worker
    }

    try {
      await handler({
        id: event.id,
        type: event.type,
        payload: event.payload,
        workItemId: event.workItemId,
        teamId: event.workItem?.teamId ?? null,
      });

      processedCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const attempts = event.attempts + 1;
      const maxAttempts = 5;

      // Exponential backoff: 2^attempts * 1000ms
      const backoffMs = Math.min(Math.pow(2, attempts) * 1000, 60_000);
      const nextAvailable = new Date(Date.now() + backoffMs);

      await db.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: attempts >= maxAttempts ? "FAILED" : "PENDING",
          availableAt: nextAvailable,
          lockedAt: null,
          lastError: errorMessage,
        },
      });
    }
  }

  return processedCount;
}

export async function markOutboxProcessed(id: string): Promise<void> {
  await db.outboxEvent.updateMany({
    where: { id, status: "PROCESSING" },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      lockedAt: null,
      lastError: null,
    },
  });
}

export async function markOutboxFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  await db.outboxEvent.updateMany({
    where: { id, status: "PROCESSING" },
    data: {
      status: "FAILED",
      lockedAt: null,
      lastError: errorMessage,
    },
  });
}
