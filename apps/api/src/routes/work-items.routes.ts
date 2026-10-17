import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import { z } from "zod";
import type { AuthRequest } from "../middlewares/authenticate.js";
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  listWorkItemsSchema,
  transitionSchema,
  assignSchema,
  approveRejectSchema,
  commentSchema,
  timelineQuerySchema,
} from "../lib/schema.js";

import { withIdempotency } from "../lib/idempotency.js";

const router: Router = Router();

const idSchema = z.string().min(1);
const editableRoles = ["ADMIN", "TEAM_LEAD", "MEMBER"] as const;

const VALID_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["PENDING_APPROVAL", "RESOLVED", "OPEN", "CLOSED"],
  PENDING_APPROVAL: ["RESOLVED", "IN_PROGRESS", "OPEN", "CLOSED"],
  RESOLVED: ["CLOSED", "OPEN"],
  CLOSED: ["OPEN"],
};

const fail = (
  res: Parameters<RequestHandler>[1],
  status: number,
  error: string,
) => res.status(status).json({ error });

async function membership(userId: string, teamId: string) {
  return db.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
  });
}

function extractVersion(req: AuthRequest, bodyVersion?: number): number | undefined {
  const ifMatch = req.header("If-Match");
  if (ifMatch) {
    const raw = ifMatch.replace(/["']/g, "").trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return bodyVersion;
}

// 1. List work items with search, filter, pagination
router.get("/", (async (req: AuthRequest, res, next) => {
  try {
    const q = listWorkItemsSchema.parse(req.query);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const memberships = await db.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });

    const teamIds = memberships.map((m) => m.teamId);
    const accessibleTeamIds = q.teamId
      ? teamIds.filter((id) => id === q.teamId)
      : teamIds;

    if (!accessibleTeamIds.length) {
      return res.json({
        items: [],
        total: 0,
        page: q.page,
        limit: q.limit,
      });
    }

    const where = {
      teamId: { in: accessibleTeamIds },
      ...(q.assigneeId ? { assigneeId: q.assigneeId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.priority ? { priority: q.priority } : {}),
      ...(q.search
        ? {
            OR: [
              {
                title: {
                  contains: q.search,
                  mode: "insensitive" as const,
                },
              },
              {
                description: {
                  contains: q.search,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await db.$transaction([
      db.workItem.findMany({
        where,
        orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: {
          team: { select: { id: true, name: true } },
          reporter: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      }),
      db.workItem.count({ where }),
    ]);

    return res.json({
      items,
      total,
      page: q.page,
      limit: q.limit,
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 2. Create work item (Idempotency supported)
router.post("/", (async (req: AuthRequest, res, next) => {
  try {
    const input = createWorkItemSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const member = await membership(userId, input.teamId);

    if (!member || member.role === "VIEWER") {
      return fail(res, 403, "Insufficient team permissions");
    }

    if (input.assigneeId) {
      const [assigneeMembership, assignee] = await Promise.all([
        membership(input.assigneeId, input.teamId),
        db.user.findFirst({
          where: { id: input.assigneeId, isActive: true },
          select: { id: true },
        }),
      ]);

      if (!assigneeMembership || !assignee) {
        return fail(res, 400, "Assignee must be an active team member");
      }
    }

    await withIdempotency(req, res, async (tx) => {
      const item = await tx.workItem.create({
        data: {
          title: input.title,
          description: input.description,
          category: input.category,
          priority: input.priority,
          teamId: input.teamId,
          reporterId: userId,
          assigneeId: input.assigneeId,
          dueAt: input.dueAt,
        },
      });

      await tx.activity.create({
        data: {
          workItemId: item.id,
          actorId: userId,
          type: "CREATED",
          changes: {
            title: item.title,
            status: item.status,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: item.id,
          type: "WORK_ITEM_CREATED",
          payload: {
            workItemId: item.id,
            actorId: userId,
          },
        },
      });

      return {
        status: 201,
        body: { item },
      };
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 3. Get single work item (returns ETag / version)
router.get("/:id", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const item = await db.workItem.findUnique({
      where: { id },
      include: {
        team: { select: { id: true, name: true } },
        reporter: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
      },
    });

    if (!item) {
      return fail(res, 404, "Work item not found");
    }

    if (!(await membership(userId, item.teamId))) {
      return fail(res, 403, "Access denied");
    }

    res.setHeader("ETag", `"${item.version}"`);
    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 4. Update work item fields (OCC via If-Match or body version)
router.patch("/:id", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = updateWorkItemSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const version = extractVersion(req, input.version);
    if (!version) {
      return fail(res, 400, "Version is required (via If-Match header or body version)");
    }

    const current = await db.workItem.findUnique({ where: { id } });

    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);

    if (
      !member ||
      !editableRoles.includes(member.role as (typeof editableRoles)[number])
    ) {
      return fail(res, 403, "Insufficient team permissions");
    }

    const { version: _v, ...fields } = input;

    const item = await db.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id, version },
        data: {
          ...fields,
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        return null;
      }

      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id },
      });

      const priorityChanged =
        fields.priority !== undefined && fields.priority !== current.priority;

      await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: priorityChanged ? "PRIORITY_CHANGED" : "UPDATED",
          changes: {
            before: {
              title: current.title,
              description: current.description,
              priority: current.priority,
              dueAt: current.dueAt?.toISOString() ?? null,
            },
            after: {
              title: updated.title,
              description: updated.description,
              priority: updated.priority,
              dueAt: updated.dueAt?.toISOString() ?? null,
            },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "WORK_ITEM_UPDATED",
          payload: {
            workItemId: id,
            actorId: userId,
            version: updated.version,
          },
        },
      });

      return updated;
    });

    if (!item) {
      const latest = await db.workItem.findUnique({
        where: { id },
      });

      return res.status(409).json({
        error: "Work item changed; refresh before retrying",
        current: latest,
      });
    }

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 5. Claim or reassign work item (OCC)
router.post("/:id/assign", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = assignSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const version = extractVersion(req, input.version);
    if (!version) {
      return fail(res, 400, "Version is required (via If-Match header or body version)");
    }

    const current = await db.workItem.findUnique({ where: { id } });
    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);
    if (
      !member ||
      !editableRoles.includes(member.role as (typeof editableRoles)[number])
    ) {
      return fail(res, 403, "Insufficient team permissions");
    }

    if (input.assigneeId) {
      const [assigneeMembership, assignee] = await Promise.all([
        membership(input.assigneeId, current.teamId),
        db.user.findFirst({
          where: { id: input.assigneeId, isActive: true },
          select: { id: true },
        }),
      ]);

      if (!assigneeMembership || !assignee) {
        return fail(res, 400, "Assignee must be an active team member");
      }
    }

    const item = await db.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id, version },
        data: {
          assigneeId: input.assigneeId,
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        return null;
      }

      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id },
        include: {
          team: { select: { id: true, name: true } },
          reporter: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      });

      await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: "ASSIGNED",
          changes: {
            before: { assigneeId: current.assigneeId },
            after: { assigneeId: updated.assigneeId },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "WORK_ITEM_ASSIGNED",
          payload: {
            workItemId: id,
            actorId: userId,
            assigneeId: updated.assigneeId,
            version: updated.version,
          },
        },
      });

      return updated;
    });

    if (!item) {
      const latest = await db.workItem.findUnique({ where: { id } });
      return res.status(409).json({
        error: "Work item changed; refresh before retrying",
        current: latest,
      });
    }

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 6. State machine transition (OCC)
router.post("/:id/transition", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = transitionSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const version = extractVersion(req, input.version);
    if (!version) {
      return fail(res, 400, "Version is required (via If-Match header or body version)");
    }

    const current = await db.workItem.findUnique({ where: { id } });
    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);
    if (
      !member ||
      !editableRoles.includes(member.role as (typeof editableRoles)[number])
    ) {
      return fail(res, 403, "Insufficient team permissions");
    }

    const allowed = VALID_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(input.status)) {
      return res.status(422).json({
        error: `Cannot transition status from ${current.status} to ${input.status}`,
      });
    }

    const item = await db.$transaction(async (tx) => {
      const resolvedAt =
        input.status === "RESOLVED" || input.status === "CLOSED"
          ? new Date()
          : null;

      const result = await tx.workItem.updateMany({
        where: { id, version },
        data: {
          status: input.status,
          resolvedAt,
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        return null;
      }

      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id },
        include: {
          team: { select: { id: true, name: true } },
          reporter: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      });

      await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: "STATUS_CHANGED",
          changes: {
            before: { status: current.status },
            after: { status: updated.status },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "WORK_ITEM_STATUS_CHANGED",
          payload: {
            workItemId: id,
            actorId: userId,
            from: current.status,
            to: updated.status,
            version: updated.version,
          },
        },
      });

      return updated;
    });

    if (!item) {
      const latest = await db.workItem.findUnique({ where: { id } });
      return res.status(409).json({
        error: "Work item changed; refresh before retrying",
        current: latest,
      });
    }

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 7. Approve work item (ADMIN or TEAM_LEAD only, OCC)
router.post("/:id/approve", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = approveRejectSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const version = extractVersion(req, input.version);
    if (!version) {
      return fail(res, 400, "Version is required (via If-Match header or body version)");
    }

    const current = await db.workItem.findUnique({ where: { id } });
    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);
    if (!member || (member.role !== "ADMIN" && member.role !== "TEAM_LEAD")) {
      return fail(res, 403, "Only team leads and admins can approve work items");
    }

    if (current.status !== "PENDING_APPROVAL") {
      return res.status(422).json({
        error: `Cannot approve item in ${current.status} status; must be PENDING_APPROVAL`,
      });
    }

    const item = await db.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id, version },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        return null;
      }

      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id },
        include: {
          team: { select: { id: true, name: true } },
          reporter: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      });

      await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: "STATUS_CHANGED",
          message: input.reason ?? "Work item approved",
          changes: {
            before: { status: current.status },
            after: { status: "RESOLVED" },
            reason: input.reason,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "WORK_ITEM_APPROVED",
          payload: {
            workItemId: id,
            actorId: userId,
            reason: input.reason,
            version: updated.version,
          },
        },
      });

      return updated;
    });

    if (!item) {
      const latest = await db.workItem.findUnique({ where: { id } });
      return res.status(409).json({
        error: "Work item changed; refresh before retrying",
        current: latest,
      });
    }

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 8. Reject work item (ADMIN or TEAM_LEAD only, OCC)
router.post("/:id/reject", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = approveRejectSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const version = extractVersion(req, input.version);
    if (!version) {
      return fail(res, 400, "Version is required (via If-Match header or body version)");
    }

    const current = await db.workItem.findUnique({ where: { id } });
    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);
    if (!member || (member.role !== "ADMIN" && member.role !== "TEAM_LEAD")) {
      return fail(res, 403, "Only team leads and admins can reject work items");
    }

    if (current.status !== "PENDING_APPROVAL") {
      return res.status(422).json({
        error: `Cannot reject item in ${current.status} status; must be PENDING_APPROVAL`,
      });
    }

    const item = await db.$transaction(async (tx) => {
      const result = await tx.workItem.updateMany({
        where: { id, version },
        data: {
          status: "IN_PROGRESS",
          version: { increment: 1 },
        },
      });

      if (result.count !== 1) {
        return null;
      }

      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id },
        include: {
          team: { select: { id: true, name: true } },
          reporter: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
        },
      });

      await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: "STATUS_CHANGED",
          message: input.reason ?? "Changes requested / rejected",
          changes: {
            before: { status: current.status },
            after: { status: "IN_PROGRESS" },
            reason: input.reason,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "WORK_ITEM_REJECTED",
          payload: {
            workItemId: id,
            actorId: userId,
            reason: input.reason,
            version: updated.version,
          },
        },
      });

      return updated;
    });

    if (!item) {
      const latest = await db.workItem.findUnique({ where: { id } });
      return res.status(409).json({
        error: "Work item changed; refresh before retrying",
        current: latest,
      });
    }

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 9. Post a comment (Idempotency supported)
router.post("/:id/comments", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = commentSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const current = await db.workItem.findUnique({
      where: { id },
      select: { id: true, teamId: true },
    });
    if (!current) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, current.teamId);
    if (
      !member ||
      !editableRoles.includes(member.role as (typeof editableRoles)[number])
    ) {
      return fail(res, 403, "Insufficient team permissions");
    }

    const executeComment = async (
      tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    ) => {
      const activity = await tx.activity.create({
        data: {
          workItemId: id,
          actorId: userId,
          type: "COMMENT_ADDED",
          message: input.body,
          changes: { isInternal: input.isInternal },
        },
        include: {
          actor: { select: { id: true, name: true } },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: id,
          type: "COMMENT_ADDED",
          payload: {
            workItemId: id,
            actorId: userId,
            message: input.body,
            isInternal: input.isInternal,
          },
        },
      });

      return {
        status: 201,
        body: { activity },
      };
    };

    if (req.header("Idempotency-Key")) {
      await withIdempotency(req, res, executeComment);
    } else {
      const result = await db.$transaction(executeComment);
      return res.status(result.status).json(result.body);
    }
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// 10. Retrieve immutable timeline / audit trail
const getTimelineHandler: RequestHandler = async (
  req: AuthRequest,
  res,
  next,
) => {
  try {
    const id = idSchema.parse(req.params.id);
    const query = timelineQuerySchema.parse(req.query);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
    }

    const item = await db.workItem.findUnique({
      where: { id },
      select: { id: true, teamId: true },
    });

    if (!item) {
      return fail(res, 404, "Work item not found");
    }

    const member = await membership(userId, item.teamId);
    if (!member) {
      return fail(res, 403, "Access denied");
    }

    const where: any = { workItemId: id };
    if (query.before_id) {
      where.id = { lt: query.before_id };
    }

    const activities = await db.activity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit,
      include: {
        actor: {
          select: { id: true, name: true },
        },
      },
    });

    return res.json({ activities, timeline: activities });
  } catch (error) {
    next(error);
  }
};

router.get("/:id/timeline", getTimelineHandler);
router.get("/:id/activities", getTimelineHandler);

export default router;

