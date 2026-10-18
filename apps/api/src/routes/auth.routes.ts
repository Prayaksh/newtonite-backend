import crypto from "node:crypto";
import { Router, Request, Response, CookieOptions } from "express";
import bcrypt from "bcryptjs";

import { env } from "../config/env.js";
import { db, TeamRole } from "@repo/db";
import { authenticate, AuthRequest } from "../middlewares/authenticate.js";
import { loginLimiter } from "../middlewares/rate-limiter.js";
import { createInvitationSchema } from "../lib/schema.js";

const router: Router = Router();

const isProduction = env.nodeEnv === "production";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction,
  path: "/",
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createSessionAndSetCookie(
  res: Response,
  userId: string,
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.authSession.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  res.cookie("sid", rawToken, {
    ...cookieOptions,
    maxAge: SESSION_TTL_MS,
  });

  return rawToken;
}

router.post("/login", loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const normalizedEmail = normalizeEmail(email);

    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
    });

    const dummyHash =
      "$2a$12$eImiTXuWVxfM37uY4JANjO20E.S2P3H/96p/B410f9tC4Y6JvRz2a";
    const passwordHash = user?.passwordHash ?? dummyHash;

    const passwordMatches = await bcrypt.compare(password, passwordHash);

    if (!user || !user.passwordHash || !user.isActive || !passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    await createSessionAndSetCookie(res, user.id);

    return res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("[Auth] Login failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to login",
    });
  }
});

router.post("/accept-invite", async (req: Request, res: Response) => {
  try {
    const { token, password, name } = req.body;

    if (!token || !password) {
      return res.status(400).json({
        success: false,
        message: "Invitation token and password are required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }

    const tokenHash = hashToken(token);

    const invitation = await db.invitation.findUnique({
      where: { tokenHash },
    });

    if (
      !invitation ||
      invitation.acceptedAt !== null ||
      invitation.expiresAt <= new Date()
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired invitation token",
      });
    }

    const normalizedEmail = normalizeEmail(invitation.email);
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.$transaction(async (tx) => {
      let targetUser = await tx.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!targetUser) {
        targetUser = await tx.user.create({
          data: {
            email: normalizedEmail,
            name: name?.trim() || normalizedEmail.split("@")[0],
            passwordHash,
            isActive: true,
          },
        });
      } else {
        targetUser = await tx.user.update({
          where: { id: targetUser.id },
          data: {
            passwordHash,
            isActive: true,
            ...(name ? { name: name.trim() } : {}),
          },
        });
      }

      await tx.teamMembership.create({
        data: {
          userId: targetUser.id,
          teamId: invitation.teamId,
          role: invitation.role,
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      return targetUser;
    });

    await createSessionAndSetCookie(res, user.id);

    return res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    console.error("[Auth] Invitation acceptance failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to accept invitation",
    });
  }
});

router.get("/me", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await db.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        name: true,
        memberships: {
          select: {
            id: true,
            teamId: true,
            role: true,
            team: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      res.clearCookie("sid", cookieOptions);
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    return res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error("[Auth] /me failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify session",
    });
  }
});

router.post(
  "/logout",
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      if (req.sessionId) {
        await db.authSession
          .delete({
            where: { id: req.sessionId },
          })
          .catch(() => {
            // Ignore errors if session was already deleted
          });
      }

      res.clearCookie("sid", cookieOptions);

      return res.json({
        success: true,
        message: "Successfully logged out",
      });
    } catch (error) {
      console.error("[Auth] Logout failed:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to logout",
      });
    }
  },
);
router.post(
  "/invitations",
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const parseResult = createInvitationSchema.safeParse(req.body);

      if (!parseResult.success) {
        return res.status(400).json({
          success: false,
          message: "Invalid invitation data",
          errors: parseResult.error.flatten(),
        });
      }

      const { email, teamId, role } = parseResult.data;

      // Verify caller belongs to the target team and has permission (e.g. ADMIN or TEAM_LEAD)
      const callerMembership = await db.teamMembership.findUnique({
        where: {
          userId_teamId: {
            userId: req.userId!,
            teamId,
          },
        },
      });

      if (
        !callerMembership ||
        (callerMembership.role !== "ADMIN" &&
          callerMembership.role !== "TEAM_LEAD")
      ) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to invite members to this team",
        });
      }

      const rawInviteToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(rawInviteToken);
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48-hour expiration

      const invitation = await db.invitation.create({
        data: {
          email,
          tokenHash,
          teamId,
          role: role as TeamRole, // Casts safely after Zod validation
          invitedByUserId: req.userId!,
          expiresAt,
        },
      });

      return res.status(201).json({
        success: true,
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
          inviteToken: rawInviteToken,
        },
      });
    } catch (error) {
      console.error("[Auth] Invitation creation failed:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create invitation",
      });
    }
  },
);

export default router;
