import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { markOutboxFailed } from "../services/outbox.service.js";

export const OUTBOX_QUEUE_NAME = "outbox-events";

export type OutboxQueueEvent = {
  id: string;
  type: string;
  payload: unknown;
  workItemId: string | null;
  teamId: string | null;
};

function createConnection(connectionName: string): Redis {
  return new Redis(env.redisUrl, {
    maxRetriesPerRequest: null,
    connectionName,
  });
}

export const outboxQueue = new Queue<OutboxQueueEvent>(OUTBOX_QUEUE_NAME, {
  connection: createConnection("newtonite-outbox-producer"),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  },
});

export function createOutboxQueueWorker(
  processor: (job: Job<OutboxQueueEvent>) => Promise<void>,
): Worker<OutboxQueueEvent> {
  const worker = new Worker<OutboxQueueEvent>(
    OUTBOX_QUEUE_NAME,
    processor,
    {
      connection: createConnection("newtonite-outbox-worker"),
      concurrency: 5,
    },
  );

  worker.on("error", (error) => {
    console.error("[OutboxQueue] Worker error:", error);
  });
  worker.on("failed", (job, error) => {
    console.error(`[OutboxQueue] Job ${job?.id ?? "unknown"} failed:`, error);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markOutboxFailed(job.data.id, error.message).catch((markError: unknown) => {
        console.error(`[OutboxQueue] Failed to record terminal job failure ${job.id}:`, markError);
      });
    }
  });

  return worker;
}
