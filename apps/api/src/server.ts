import app from "./app.js";
import { db } from "@repo/db";
import { OutboxWorker } from "./workers/outbox.worker.js";
import { eventBus } from "./lib/events.js";

const PORT = Number(process.env.PORT) || 3000;

// Start background Transactional Outbox worker
const outboxWorker = new OutboxWorker(3000, async (event) => {
  console.log(`[OutboxWorker] Processing ${event.type} for workItem ${event.workItemId}`);
  eventBus.broadcast({
    type: "OUTBOX_EVENT_PROCESSED",
    workItemId: event.workItemId ?? undefined,
    data: event,
  });
});

outboxWorker.start();
console.log("[OutboxWorker] Background worker started");

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// Graceful shutdown handling
const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Gracefully shutting down...`);
  outboxWorker.stop();

  server.close(async () => {
    console.log("HTTP server closed.");
    try {
      await db.$disconnect();
      console.log("Database disconnected.");
    } catch (err) {
      console.error("Error disconnecting database:", err);
    }
    process.exit(0);
  });

  // Force exit if shutdown hangs
  setTimeout(() => {
    console.error("Shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10_000);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
