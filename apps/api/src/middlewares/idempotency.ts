import type { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "./authenticate.js";
import { withIdempotency } from "../lib/idempotency.js";

/**
 * Idempotency middleware — can be used as a standalone middleware in the chain
 * OR you can call `withIdempotency()` directly in your handler.
 *
 * This middleware version wraps the NEXT handler automatically.
 * The handler result must be `{ status: number; body: unknown }`.
 */
export function idempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // If no Idempotency-Key header, skip and proceed normally
  const key = req.header("Idempotency-Key");
  if (!key) {
    next();
    return;
  }

  // Hand off to lib implementation — it will call res.json() / res.status()
  withIdempotency(req as AuthRequest, res, async (tx) => {
    // Store the original json function so we can intercept the response
    let capturedStatus = 200;
    let capturedBody: unknown;

    const origStatus = res.status.bind(res);
    const origJson = res.json.bind(res);

    // Monkey-patch temporarily to capture what the handler sends
    (res as any).status = (code: number) => {
      capturedStatus = code;
      return res;
    };
    (res as any).json = (body: unknown) => {
      capturedBody = body;
      return res;
    };

    // Run remaining middleware/handler
    await new Promise<void>((resolve) => next(resolve as any));

    // Restore originals
    (res as any).status = origStatus;
    (res as any).json = origJson;

    return { status: capturedStatus, body: capturedBody };
  }).catch(next);
}

