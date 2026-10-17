import { Router, type RequestHandler } from "express";
import { db } from "@repo/db";
import type { AuthRequest } from "../middlewares/authenticate.js";

const router: Router = Router();

// GET /users/me - Fetch authenticated user, roles, and team scopes
router.get("/me", (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        createdAt: true,
        memberships: {
          select: {
            id: true,
            role: true,
            teamId: true,
            team: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isActive: user.isActive,
        createdAt: user.createdAt,
        memberships: user.memberships.map((m) => ({
          id: m.id,
          role: m.role,
          teamId: m.teamId,
          teamName: m.team.name,
          teamSlug: m.team.slug,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}) as RequestHandler);

export default router;

