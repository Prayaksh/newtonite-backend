import { db } from "@repo/db";
import type { WorkItem, Activity, Prisma } from "@repo/db";
import { eventBus } from "../lib/events.js";

/**
 * Work-item service — thin domain layer between route handlers and the DB.
 * Handles OCC (version-based optimistic concurrency) and side-effects
 * (activity log entries, outbox events, SSE broadcast).
 */

export type WorkItemWithRelations = WorkItem & {
  team: { id: string; name: string };
  reporter: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
};

const includeRelations = {
  team: { select: { id: true, name: true } },
  reporter: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemInclude;

/** Result for any OCC-guarded mutation */
export type OccResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "VERSION_CONFLICT"; current: WorkItem | null };

// ─── Read helpers ─────────────────────────────────────────────────────────────

export async function findWorkItem(
  id: string,
): Promise<WorkItemWithRelations | null> {
  return db.workItem.findUnique({
    where: { id },
    include: includeRelations,
  }) as Promise<WorkItemWithRelations | null>;
}

// ─── Mutation helpers ─────────────────────────────────────────────────────────

/** Generic OCC update — returns null if version mismatch */
async function occUpdate(
  id: string,
  version: number,
  data: Prisma.WorkItemUpdateInput,
  actorId: string,
  activityType: Activity["type"],
  activityChanges: Prisma.InputJsonValue,
  outboxType: string,
  outboxPayload: Prisma.InputJsonValue,
): Promise<OccResult<WorkItemWithRelations>> {
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.workItem.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });

    if (updated.count !== 1) return null;

    const item = await tx.workItem.findUniqueOrThrow({
      where: { id },
      include: includeRelations,
    });

    await tx.activity.create({
      data: {
        workItemId: id,
        actorId,
        type: activityType,
        changes: activityChanges,
      },
    });

    await tx.outboxEvent.create({
      data: {
        workItemId: id,
        type: outboxType,
        payload: outboxPayload,
      },
    });

    return item;
  });

  if (!result) {
    const current = await db.workItem.findUnique({ where: { id } });
    return { ok: false, reason: "VERSION_CONFLICT", current };
  }

  // Broadcast immediately over SSE (outbox worker also dispatches async)
  eventBus.broadcast({ type: outboxType, workItemId: id, data: result });
  return { ok: true, data: result as WorkItemWithRelations };
}

/** PATCH — update editable fields */
export async function updateWorkItem(
  id: string,
  version: number,
  actorId: string,
  fields: Partial<
    Pick<WorkItem, "title" | "description" | "category" | "priority" | "dueAt">
  >,
  before: WorkItem,
): Promise<OccResult<WorkItemWithRelations>> {
  return occUpdate(
    id,
    version,
    fields as Prisma.WorkItemUpdateInput,
    actorId,
    fields.priority && fields.priority !== before.priority
      ? "PRIORITY_CHANGED"
      : "UPDATED",
    {
      before: {
        title: before.title,
        description: before.description,
        priority: before.priority,
        dueAt: before.dueAt?.toISOString() ?? null,
      },
      after: fields,
    },
    "WORK_ITEM_UPDATED",
    { workItemId: id, actorId },
  );
}

/** Assign / claim */
export async function assignWorkItem(
  id: string,
  version: number,
  actorId: string,
  assigneeId: string | null,
  previousAssigneeId: string | null,
): Promise<OccResult<WorkItemWithRelations>> {
  return occUpdate(
    id,
    version,
    {
      assignee: assigneeId
        ? { connect: { id: assigneeId } }
        : { disconnect: true },
    },
    actorId,
    "ASSIGNED",
    { before: { assigneeId: previousAssigneeId }, after: { assigneeId } },
    "WORK_ITEM_ASSIGNED",
    { workItemId: id, actorId, assigneeId },
  );
}

/** Transition status */
export async function transitionWorkItem(
  id: string,
  version: number,
  actorId: string,
  fromStatus: WorkItem["status"],
  toStatus: WorkItem["status"],
): Promise<OccResult<WorkItemWithRelations>> {
  const resolvedAt =
    toStatus === "RESOLVED" || toStatus === "CLOSED" ? new Date() : null;

  return occUpdate(
    id,
    version,
    { status: toStatus, ...(resolvedAt ? { resolvedAt } : {}) },
    actorId,
    "STATUS_CHANGED",
    { before: { status: fromStatus }, after: { status: toStatus } },
    "WORK_ITEM_STATUS_CHANGED",
    { workItemId: id, actorId, from: fromStatus, to: toStatus },
  );
}

/** Approve (PENDING_APPROVAL → RESOLVED) */
export async function approveWorkItem(
  id: string,
  version: number,
  actorId: string,
  reason: string | undefined,
): Promise<OccResult<WorkItemWithRelations>> {
  return occUpdate(
    id,
    version,
    { status: "RESOLVED", resolvedAt: new Date() },
    actorId,
    "STATUS_CHANGED",
    {
      before: { status: "PENDING_APPROVAL" },
      after: { status: "RESOLVED" },
      reason: reason ?? null,
    },
    "WORK_ITEM_APPROVED",
    { workItemId: id, actorId, reason: reason ?? null },
  );
}

/** Reject (PENDING_APPROVAL → IN_PROGRESS) */
export async function rejectWorkItem(
  id: string,
  version: number,
  actorId: string,
  reason: string | undefined,
): Promise<OccResult<WorkItemWithRelations>> {
  return occUpdate(
    id,
    version,
    { status: "IN_PROGRESS" },
    actorId,
    "STATUS_CHANGED",
    {
      before: { status: "PENDING_APPROVAL" },
      after: { status: "IN_PROGRESS" },
      reason: reason ?? null,
    },
    "WORK_ITEM_REJECTED",
    { workItemId: id, actorId, reason: reason ?? null },
  );
}
