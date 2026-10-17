import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import { z } from "zod";
import type { AuthRequest } from "../middlewares/authenticate.js";

const router: Router = Router();
const idSchema = z.string().min(1);

// GET /teams - List operational teams
router.get("/", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Get user's memberships to include their roles
    const memberships = await db.teamMembership.findMany({
      where: { userId },
      include: {
        team: {
          include: {
            _count: {
              select: {
                memberships: true,
                workItems: true,
              },
            },
          },
        },
      },
    });

    const teams = memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      slug: m.team.slug,
      description: m.team.description,
      myRole: m.role,
      memberCount: m.team._count.memberships,
      workItemCount: m.team._count.workItems,
      createdAt: m.team.createdAt,
    }));

    return res.json({ teams });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

// GET /teams/:id/members - List members of a specific team
router.get("/:id/members", (async (req: AuthRequest, res, next) => {
  try {
    const teamId = idSchema.parse(req.params.id);
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // 1. Check if the team exists first to ensure 404 for non-existent teams
    const team = await db.team.findUnique({
      where: { id: teamId },
      select: { id: true },
    });

    if (!team) {
      return res.status(404).json({ error: "Team not found" });
    }

    // 2. Check if the calling user is a member of the team
    const myMembership = await db.teamMembership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });

    if (!myMembership) {
      return res.status(403).json({ error: "Access denied to team" });
    }

    // 3. Fetch team members with user details
    const members = await db.teamMembership.findMany({
      where: { teamId },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
          },
        },
      },
    });

    // 4. Return formatted member list
    return res.json({
      members: members.map((m) => ({
        id: m.id,
        role: m.role,
        user: m.user,
        userId: m.userId, // Explicitly exposed for assertion checks
        joinedAt: m.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;
