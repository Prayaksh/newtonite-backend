import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { db } from "@repo/db";

type IdempotentResult<T> = {
  status: number;
  body: T;
};

type IdempotentOperation<T> = (
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
) => Promise<IdempotentResult<T>>;

export async function withIdempotency<T>(
  req: Request & { userId?: string },
  res: Response,
  operation: IdempotentOperation<T>,
): Promise<void> {
  const userId = req.userId;
  const key = req.header("Idempotency-Key");

  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!key || key.length > 255) {
    res.status(400).json({
      error: "A valid Idempotency-Key header is required",
    });
    return;
  }

  const requestHash = createHash("sha256")
    .update(JSON.stringify({ method: req.method, body: req.body }))
    .digest("hex");

  try {
    const result = await db.$transaction(async (tx) => {
      let existing = await tx.idempotencyKey.findUnique({
        where: { userId_key: { userId, key } },
      });

      if (existing && existing.expiresAt <= new Date()) {
        await tx.idempotencyKey.deleteMany({ where: { id: existing.id } });
        existing = null;
      }

      if (existing) {
        if (existing.requestHash !== requestHash) {
          return {
            conflict: true as const,
          };
        }

        if (existing.statusCode === null || existing.response === null) {
          return { inProgress: true as const };
        }

        return {
          replay: true as const,
          status: existing.statusCode,
          body: existing.response,
        };
      }

      await tx.idempotencyKey.create({
        data: {
          userId,
          key,
          requestHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      const operationResult = await operation(tx);

      await tx.idempotencyKey.update({
        where: { userId_key: { userId, key } },
        data: {
          statusCode: operationResult.status,
          response: JSON.parse(JSON.stringify(operationResult.body)),
        },
      });

      return {
        replay: false as const,
        status: operationResult.status,
        body: operationResult.body,
      };
    });

    if ("conflict" in result) {
      res.status(409).json({
        error: "Idempotency key was reused with a different request",
      });
      return;
    }

    if ("inProgress" in result) {
      res.status(409).json({
        error: "Request with this idempotency key is still processing",
      });
      return;
    }

    res.status(result.status).json(result.body);
  } catch (error) {
    const existing = await db.idempotencyKey
      .findUnique({
        where: { userId_key: { userId, key } },
      })
      .catch(() => null);

    if (existing && existing.expiresAt > new Date()) {
      if (existing.requestHash !== requestHash) {
        res.status(409).json({
          error: "Idempotency key was reused with a different request",
        });
        return;
      }

      if (existing.statusCode !== null && existing.response !== null) {
        res.status(existing.statusCode).json(existing.response);
        return;
      }
    }

    throw error;
  }
}
