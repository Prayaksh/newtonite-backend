import type { Request, Response, NextFunction } from "express";
import { ZodType, ZodError } from "zod";

/**
 * Validate middleware factory — wraps a Zod schema and attaches parsed data
 * to `req.validated` so downstream handlers don't repeat parsing.
 *
 * Usage:
 *   router.post("/", validate(mySchema, "body"), handler);
 */
export function validate(
  schema: ZodType,
  source: "body" | "query" | "params" = "body",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      res.status(400).json({
        status: "error",
        error: "Validation failed",
        details: (result.error as ZodError).flatten().fieldErrors,
      });
      return;
    }

    // Attach to a well-typed property on the request
    (req as any).validated = result.data;
    next();
  };
}
