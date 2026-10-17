import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors.js";
import { Prisma } from "@repo/db";

/**
 * Global Express error handler — must be registered LAST in the middleware
 * chain (4-argument signature tells Express this is an error handler).
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Structured application errors (thrown with AppError)
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      status: "error",
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return;
  }

  // Zod validation errors → 400 Bad Request
  if (error instanceof ZodError) {
    res.status(400).json({
      status: "error",
      error: "Validation failed",
      details: error.flatten().fieldErrors,
    });
    return;
  }

  // Prisma known request errors (e.g. unique constraint violations)
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaError = error as Prisma.PrismaClientKnownRequestError;
    if (prismaError.code === "P2002") {
      res.status(409).json({
        status: "error",
        error: "A record with this value already exists",
        code: "DUPLICATE",
      });
      return;
    }

    if (prismaError.code === "P2025") {
      res.status(404).json({
        status: "error",
        error: "Record not found",
        code: "NOT_FOUND",
      });
      return;
    }
  }

  // Unknown / unexpected errors → 500
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred";

  console.error("[error-handler]", error);

  res.status(500).json({
    status: "error",
    error: message,
    code: "INTERNAL_ERROR",
  });
}
