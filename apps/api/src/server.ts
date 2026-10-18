import app from "./app.js";
import { db } from "@repo/db";
import { OutboxWorker } from "./workers/outbox.worker.js";
import { eventBus } from "./lib/events.js";
import { createOutboxQueueWorker, outboxQueue } from "./queues/outbox.queue.js";
import {
  closeRateLimitStore,
  connectRateLimitStore,
} from "./middlewares/rate-limiter.js";
import { purgeExpiredRecords } from "./services/idempotency.service.js";
import { markOutboxProcessed } from "./services/outbox.service.js";

const PORT = Number(process.env.PORT) || 3000;

async function startServer(): Promise<void> {
  await Promise.all([eventBus.connect(), connectRateLimitStore()]);
  await outboxQueue.waitUntilReady();

  const queueWorker = createOutboxQueueWorker(async (job) => {
    const event = job.data;
    const teamId =
      event.teamId ??
      (event.workItemId
        ? (
            await db.workItem.findUnique({
              where: { id: event.workItemId },
              select: { teamId: true },
            })
          )?.teamId
        : undefined);
    if (teamId && event.workItemId) {
      await eventBus.publish({
        type: "OUTBOX_EVENT_PROCESSED",
        teamId,
        workItemId: event.workItemId,
        data: event,
      });
    }
    await markOutboxProcessed(event.id);
  });
  await queueWorker.waitUntilReady();

  const outboxPoller = new OutboxWorker(3000, async (event) => {
    await outboxQueue.add("dispatch", event, { jobId: event.id });
  });
  outboxPoller.start();
  console.log("[OutboxWorker] Database poller and Redis queue worker started");

  const purgeExpiredIdempotencyRecords = () => {
    void purgeExpiredRecords().catch((error: unknown) => {
      console.error("[Idempotency] Failed to purge expired keys:", error);
    });
  };
  purgeExpiredIdempotencyRecords();
  const idempotencyCleanupTimer = setInterval(
    purgeExpiredIdempotencyRecords,
    60 * 60 * 1000,
  );

  const server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}. Gracefully shutting down...`);
    outboxPoller.stop();
    clearInterval(idempotencyCleanupTimer);

    server.close(async () => {
      console.log("HTTP server closed.");
      try {
        await queueWorker.close();
        await outboxQueue.close();
        await eventBus.close();
        await closeRateLimitStore();
        await db.$disconnect();
        console.log("Redis and database connections closed.");
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exitCode = 1;
      }
      process.exit();
    });

    setTimeout(() => {
      console.error("Shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

startServer().catch(async (error: unknown) => {
  console.error("Failed to start API server:", error);
  await Promise.allSettled([
    outboxQueue.close(),
    eventBus.close(),
    closeRateLimitStore(),
    db.$disconnect(),
  ]);
  process.exitCode = 1;
});
