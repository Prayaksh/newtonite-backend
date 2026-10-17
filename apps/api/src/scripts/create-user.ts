import bcrypt from "bcryptjs";
import { db } from "@repo/db";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.argv[3];
  const name = process.argv[4]?.trim() || "Admin User";
  const teamName = process.argv[5]?.trim() || "Engineering";

  if (!email || !password) {
    console.error(
      "Usage: pnpm tsx src/scripts/create-user.ts <email> <password> [name] [teamName]",
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Error: Password must be at least 8 characters.");
    process.exit(1);
  }

  console.log(`Creating user: ${email}...`);

  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.$transaction(async (tx) => {
    let team = await tx.team.findFirst({
      where: { name: teamName },
    });

    function slugify(text: string): string {
      return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }

    if (!team) {
      team = await tx.team.create({
        data: {
          name: teamName,
          slug: slugify(teamName),
        },
      });
    }

    const user = await tx.user.upsert({
      where: { email },
      update: {
        passwordHash,
        isActive: true,
        name,
      },
      create: {
        email,
        name,
        passwordHash,
        isActive: true,
      },
    });

    await tx.teamMembership.upsert({
      where: {
        userId_teamId: {
          userId: user.id,
          teamId: team.id,
        },
      },
      update: { role: "ADMIN" },
      create: {
        userId: user.id,
        teamId: team.id,
        role: "ADMIN",
      },
    });

    return { user, team };
  });

  console.log("Bootstrap completed successfully!");
  console.log(`User ID: ${result.user.id}`);
  console.log(`Team ID: ${result.team.id} (${result.team.name})`);
}

main()
  .catch((e) => {
    console.error("Bootstrap failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
