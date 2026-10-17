import { db } from "@repo/db";
import type { TeamMembership } from "@repo/db";

/**
 * Authorization service — thin helpers to check team membership / roles
 * without coupling the check to HTTP layer concerns.
 */

export type MemberRole = TeamMembership["role"];

export interface MembershipResult {
  role: MemberRole;
  teamId: string;
  userId: string;
}

/**
 * Fetch a user's membership in a specific team.
 * Returns `null` if the user is not a member.
 */
export async function getTeamMembership(
  userId: string,
  teamId: string,
): Promise<TeamMembership | null> {
  return db.teamMembership.findUnique({
    where: { userId_teamId: { userId, teamId } },
  });
}

/**
 * Assert that a user belongs to the team AND has one of the allowed roles.
 * Returns the membership record on success.
 * Throws a descriptive error object (not HTTP-specific) on failure.
 */
export async function requireTeamRole(
  userId: string,
  teamId: string,
  allowedRoles: MemberRole[],
): Promise<TeamMembership> {
  const member = await getTeamMembership(userId, teamId);

  if (!member) {
    throw Object.assign(new Error("Not a team member"), {
      code: "NOT_MEMBER",
      statusCode: 403,
    });
  }

  if (!allowedRoles.includes(member.role)) {
    throw Object.assign(
      new Error(
        `Role '${member.role}' is not allowed; required: ${allowedRoles.join(", ")}`,
      ),
      { code: "INSUFFICIENT_ROLE", statusCode: 403 },
    );
  }

  return member;
}

/**
 * Check whether a user is an active member of ANY of the given teams.
 */
export async function getUserTeamIds(userId: string): Promise<string[]> {
  const memberships = await db.teamMembership.findMany({
    where: { userId },
    select: { teamId: true },
  });
  return memberships.map((m) => m.teamId);
}
