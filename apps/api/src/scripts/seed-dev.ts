import { db } from "@repo/db";
import bcrypt from "bcryptjs";

async function main() {
  const password = process.env.DEV_USER_PASSWORD;
  if (!password) {
    throw new Error("Set DEV_USER_PASSWORD before seeding the development user");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await db.user.upsert({
    where: { email: "dev@example.com" },
    update: { isActive: true, passwordHash },
    create: {
      email: "dev@example.com",
      name: "Development User",
      isActive: true,
      passwordHash,
    },
  });

  const team = await db.team.upsert({
    where: { slug: "engineering" },
    update: {},
    create: {
      name: "Engineering",
      slug: "engineering",
      description: "Development team for testing",
    },
  });

  await db.teamMembership.upsert({
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

  console.log("\nDevelopment seed completed\n");
  console.log("User ID:", user.id);
  console.log("Team ID:", team.id);
  console.log("User email:", user.email);
  console.log("Team name:", team.name);
  console.log("Role: ADMIN");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
