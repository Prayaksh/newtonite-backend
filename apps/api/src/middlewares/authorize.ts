import type { RequestHandler } from "express";
import { db } from "@repo/db";

type Role = "ADMIN" | "TEAM_LEAD" | "MEMBER" | "VIEWER";

export function authorizeTeam(roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    try {
      const userId = (req as typeof req & { userId?: string }).userId;
      const teamId = req.params.teamId;

      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      if (typeof teamId !== "string") {
        res.status(400).json({ error: "Invalid team ID" });
        return;
      }

      const membership = await db.teamMembership.findUnique({
        where: {
          userId_teamId: { userId, teamId },
        },
        select: { role: true },
      });

      if (!membership || !roles.includes(membership.role as Role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
