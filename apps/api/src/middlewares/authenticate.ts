import type { Request, Response, NextFunction } from "express";
import { createHash } from "node:crypto";
import { db } from "@repo/db";

export type AuthRequest = Request & {
  userId?: string;
  sessionId?: string;
};

export async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.sid;

  if (typeof token !== "string" || !token) {
    res.status(401).json({
      status: "error",
      message: "Authentication required",
    });
    return;
  }

  try {
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const session = await db.authSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        user: {
          select: {
            id: true,
            isActive: true,
          },
        },
      },
    });

    if (!session || session.expiresAt <= new Date() || !session.user.isActive) {
      res.clearCookie("sid", {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
      });

      res.status(401).json({
        status: "error",
        message: "Invalid or expired session",
      });
      return;
    }

    req.userId = session.user.id;
    req.sessionId = session.id;

    next();
  } catch (error) {
    next(error);
  }
}
