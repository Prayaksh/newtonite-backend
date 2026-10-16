import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import { z } from "zod";
import type { AuthRequest } from "../middlewares/authenticate.js";
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  listWorkItemsSchema,
} from "../lib/schema.js";

const router: Router = Router();

const idSchema = z.string().min(1);
const editableRoles = ["ADMIN", "TEAM_LEAD", "MEMBER"] as const;

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

    const teamIds = memberships.map((membership) => membership.teamId);
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

    const item = await db.$transaction(async (tx) => {
      const created = await tx.workItem.create({
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
          workItemId: created.id,
          actorId: userId,
          type: "CREATED",
          changes: {
            title: created.title,
            status: created.status,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          workItemId: created.id,
          type: "WORK_ITEM_CREATED",
          payload: {
            workItemId: created.id,
            actorId: userId,
          },
        },
      });

      return created;
    });

    return res.status(201).json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

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

    return res.json({ item });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.patch("/:id", (async (req: AuthRequest, res, next) => {
  try {
    const id = idSchema.parse(req.params.id);
    const input = updateWorkItemSchema.parse(req.body);
    const userId = req.userId;

    if (!userId) {
      return fail(res, 401, "Authentication required");
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

    const { version, ...fields } = input;

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

export default router;
