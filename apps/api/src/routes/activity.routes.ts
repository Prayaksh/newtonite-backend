import { Router, type RequestHandler } from "express";
import { db, type Prisma } from "@repo/db";
import { z } from "zod";
import type { AuthRequest } from "../middlewares/authenticate.js";
import { generalLimiter } from "../middlewares/rate-limiter.js";

const router: Router = Router();

const teamIdSchema = z.string().min(1).optional();
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
const beforeIdSchema = z.string().min(1).optional();
const workItemIdSchema = z.string().min(1).optional();

/**
 * GET /activity  —  global activity feed across all teams the user belongs to.
 *
 * Query params:
 *   team_id?    – filter to a specific team
 *   work_item_id? – filter to a specific work item
 *   limit?      – max rows (1-100, default 20)
 *   before_id?  – cursor for keyset pagination (activity id)
 */
router.get("/", generalLimiter, (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res
        .status(401)
        .json({ status: "error", error: "Authentication required" });
    }

    const teamId = teamIdSchema.parse(req.query.team_id);
    const workItemId = workItemIdSchema.parse(req.query.work_item_id);
    const limit = limitSchema.parse(req.query.limit);
    const beforeId = beforeIdSchema.parse(req.query.before_id);

    // Scope to teams the user belongs to
    const memberships = await db.teamMembership.findMany({
      where: { userId, ...(teamId ? { teamId } : {}) },
      select: { teamId: true },
    });

    const teamIds = memberships.map((m) => m.teamId);

    if (!teamIds.length) {
      return res.json({ activities: [], hasMore: false });
    }

    const where: Prisma.ActivityWhereInput = {
      workItem: {
        teamId: { in: teamIds },
        ...(workItemId ? { id: workItemId } : {}),
      },
      ...(beforeId ? { id: { lt: beforeId } } : {}),
    };

    const activities = await db.activity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1, // fetch one extra to determine hasMore
      include: {
        actor: { select: { id: true, name: true } },
        workItem: {
          select: {
            id: true,
            title: true,
            status: true,
            team: { select: { id: true, name: true } },
          },
        },
      },
    });

    const hasMore = activities.length > limit;
    if (hasMore) activities.pop();

    return res.json({ activities, hasMore });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;
