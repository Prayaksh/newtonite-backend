import { EventEmitter } from "node:events";

class WorkItemEventBus extends EventEmitter {
  public broadcast(event: { type: string; workItemId?: string; data?: any }) {
    this.emit("work-item-event", event);
  }
}

export const eventBus = new WorkItemEventBus();
// Increase listener limit for multiple SSE clients
eventBus.setMaxListeners(100);

