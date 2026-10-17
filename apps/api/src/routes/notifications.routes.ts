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

// GET /api/v1/notifications - Get notifications for updates and actions on user's work items
router.get("/", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const { page, limit } = querySchema.parse(req.query);

    // Get user's teams
    const memberships = await db.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });

    const teamIds = memberships.map((m) => m.teamId);

    if (teamIds.length === 0) {
      return res.json({ notifications: [], total: 0, page, limit });
    }

    // Notifications are derived from activities on items assigned to the user or in user's teams
    const where = {
      workItem: {
        teamId: { in: teamIds },
      },
      actorId: { not: userId }, // Don't notify of user's own actions
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

export default router;

