import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import type { AuthRequest } from "../middlewares/authenticate.js";

const router: Router = Router();

// GET /api/v1/dashboard/stats - High-level metrics for management & operational overview
router.get("/stats", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Get user's accessible teams
    const memberships = await db.teamMembership.findMany({
      where: { userId },
      select: { teamId: true },
    });

    const teamIds = memberships.map((m) => m.teamId);

    if (teamIds.length === 0) {
      return res.json({
        total: 0,
        byStatus: {},
        byPriority: {},
        urgentCount: 0,
        overdueCount: 0,
        pendingApprovalCount: 0,
        recentActivities: [],
      });
    }

    const teamFilter = { teamId: { in: teamIds } };
    const now = new Date();

    const [
      total,
      openCount,
      inProgressCount,
      pendingApprovalCount,
      resolvedCount,
      closedCount,
      urgentCount,
      highCount,
      overdueCount,
      recentActivities,
    ] = await Promise.all([
      db.workItem.count({ where: teamFilter }),
      db.workItem.count({ where: { ...teamFilter, status: "OPEN" } }),
      db.workItem.count({ where: { ...teamFilter, status: "IN_PROGRESS" } }),
      db.workItem.count({ where: { ...teamFilter, status: "PENDING_APPROVAL" } }),
      db.workItem.count({ where: { ...teamFilter, status: "RESOLVED" } }),
      db.workItem.count({ where: { ...teamFilter, status: "CLOSED" } }),
      db.workItem.count({ where: { ...teamFilter, priority: "URGENT", status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      db.workItem.count({ where: { ...teamFilter, priority: "HIGH", status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      db.workItem.count({
        where: {
          ...teamFilter,
          status: { in: ["OPEN", "IN_PROGRESS", "PENDING_APPROVAL"] },
          dueAt: { lt: now },
        },
      }),
      db.activity.findMany({
        where: {
          workItem: teamFilter,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
        include: {
          actor: { select: { id: true, name: true } },
          workItem: { select: { id: true, title: true, status: true, priority: true } },
        },
      }),
    ]);

    return res.json({
      total,
      byStatus: {
        OPEN: openCount,
        IN_PROGRESS: inProgressCount,
        PENDING_APPROVAL: pendingApprovalCount,
        RESOLVED: resolvedCount,
        CLOSED: closedCount,
      },
      byPriority: {
        URGENT: urgentCount,
        HIGH: highCount,
      },
      urgentCount,
      overdueCount,
      pendingApprovalCount,
      recentActivities,
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;

