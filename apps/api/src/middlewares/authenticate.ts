import type { Request, Response, NextFunction } from "express";
import { db } from "@repo/db";
import { env } from "../config/env.js";

export type AuthRequest = Request & {
  userId?: string;
};

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (env.nodeEnv !== "development") {
    res.status(401).json({
      error: "Authentication is not configured for this environment",
    });
    return;
  }

  const userId = req.header("X-User-Id");

  if (!userId) {
    res.status(401).json({
      error: "Authentication required",
    });
    return;
  }

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(401).json({
        error: "Invalid or inactive user",
      });
      return;
    }

    req.userId = user.id;
    next();
  } catch (error) {
    next(error);
  }
}
