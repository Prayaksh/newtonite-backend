import { db } from "@repo/db";
import type { Prisma } from "@repo/db";

/**
 * Idempotency service — wraps the idempotency key table with convenience
 * methods so route handlers don't need direct DB access for this concern.
 */

export interface IdempotencyRecord {
  id: string;
  userId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Prisma.JsonValue;
  expiresAt: Date;
  createdAt: Date;
}

/** Retrieve an existing idempotency record by user + key */
export async function findIdempotencyRecord(
  userId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  return db.idempotencyKey.findUnique({
    where: { userId_key: { userId, key } },
  }) as Promise<IdempotencyRecord | null>;
}

/** Store a completed idempotency record */
export async function saveIdempotencyRecord(
  userId: string,
  key: string,
  requestHash: string,
  responseStatus: number,
  responseBody: unknown,
  ttlMs = 86_400_000, // 24 h default
): Promise<void> {
  await db.idempotencyKey.create({
    data: {
      userId,
      key,
      requestHash,
      responseStatus,
      responseBody: responseBody as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
}

/** Delete one bounded batch of expired idempotency records. */
export async function purgeExpiredRecords(batchSize = 500): Promise<number> {
  const expired = await db.idempotencyKey.findMany({
    where: { expiresAt: { lt: new Date() } },
    orderBy: { expiresAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
  if (expired.length === 0) return 0;

  const result = await db.idempotencyKey.deleteMany({
    where: { id: { in: expired.map(({ id }) => id) } },
  });
  return result.count;
}
