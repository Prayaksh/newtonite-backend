import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import { z } from "zod";
import type { AuthRequest } from "../middlewares/authenticate.js";

const router: Router = Router();

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread_only: z.coerce.boolean().optional(),
});

const markReadSchema = z
  .object({
    activityIds: z.array(z.string().min(1)).min(1).max(100),
  })
  .strict();

// GET /api/v1/notifications - Get notifications for updates and actions on user's work items
router.get("/", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { page, limit, unread_only: unreadOnly = false } = querySchema.parse(
      req.query,
    );

    // Get user's teams
    const memberships = await db.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });

    const teamIds = memberships.map((m) => m.teamId);

    if (teamIds.length === 0) {
      return res.json({ notifications: [], total: 0, page, limit });
    }

    const where = {
      workItem: {
        teamId: { in: teamIds },
      },
      actorId: { not: userId },
      ...(unreadOnly
        ? { notificationReads: { none: { userId } } }
        : {}),
    };

    const [activities, total] = await db.$transaction([
      db.activity.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { id: true, name: true } },
          workItem: { select: { id: true, title: true, status: true, priority: true } },
          notificationReads: {
            where: { userId },
            select: { readAt: true },
          },
        },
      }),
      db.activity.count({ where }),
    ]);

    const notifications = activities.map((a) => ({
      id: a.id,
      type: a.type,
      message: a.message,
      changes: a.changes,
      actor: a.actor,
      workItem: a.workItem,
      createdAt: a.createdAt,
      isRead: a.notificationReads.length > 0,
      readAt: a.notificationReads[0]?.readAt ?? null,
    }));

    return res.json({
      notifications,
      total,
      page,
      limit,
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

router.post("/read", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { activityIds } = markReadSchema.parse(req.body);
    const memberships = await db.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const teamIds = memberships.map(({ teamId }) => teamId);
    if (teamIds.length === 0) {
      return res.json({ markedRead: 0 });
    }

    const accessibleActivities = await db.activity.findMany({
      where: {
        id: { in: activityIds },
        actorId: { not: userId },
        workItem: { teamId: { in: teamIds } },
      },
      select: { id: true },
    });

    const result = await db.notificationRead.createMany({
      data: accessibleActivities.map(({ id }) => ({ userId, activityId: id })),
      skipDuplicates: true,
    });
    return res.json({ markedRead: result.count });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;
