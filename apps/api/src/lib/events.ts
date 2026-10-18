import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

import { env } from "../config/env.js";

const CHANNEL = "work-item-events";

export type WorkItemEvent = {
  type: string;
  teamId: string;
  workItemId?: string;
  data?: unknown;
};

class WorkItemEventBus extends EventEmitter {
  private readonly publisher = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectionName: "newtonite-events-publisher",
  });
  private readonly subscriber = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectionName: "newtonite-events-subscriber",
  });

  constructor() {
    super();
    this.publisher.on("error", (error) => {
      console.error("[Redis] Event publisher error:", error);
    });
    this.subscriber.on("error", (error) => {
      console.error("[Redis] Event subscriber error:", error);
    });
    this.subscriber.on("message", (_channel, message) => {
      let event: unknown;
      try {
        event = JSON.parse(message);
      } catch (error) {
        console.error("[Redis] Ignoring invalid work-item event:", error);
        return;
      }
      if (
        typeof event !== "object" ||
        event === null ||
        !("type" in event) ||
        typeof event.type !== "string" ||
        !("teamId" in event) ||
        typeof event.teamId !== "string"
      ) {
        console.error("[Redis] Ignoring unscoped work-item event");
        return;
      }
      this.emit("work-item-event", event as WorkItemEvent);
    });
  }

  public async connect(): Promise<void> {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(CHANNEL);
  }

  public async publish(event: WorkItemEvent): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify(event));
  }

  public broadcast(event: WorkItemEvent): void {
    void this.publish(event).catch((error: unknown) => {
      console.error("[Redis] Failed to publish work-item event:", error);
    });
  }

  public async close(): Promise<void> {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}

export const eventBus = new WorkItemEventBus();
eventBus.setMaxListeners(100);
