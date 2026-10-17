/**
 * AppError — structured application error with HTTP status code.
 *
 * Throw this anywhere in the request pipeline; the global error handler in
 * `middlewares/error-handler.ts` will serialise it as JSON automatically.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string | undefined;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    // Restore the prototype chain so `instanceof AppError` works after transpilation
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Convenience factories ────────────────────────────────────────────────────

export const badRequest = (message: string, code?: string) =>
  new AppError(400, message, code);

export const unauthorized = (message = "Authentication required") =>
  new AppError(401, message, "UNAUTHORIZED");

export const forbidden = (message: string) =>
  new AppError(403, message, "FORBIDDEN");

export const notFound = (resource = "Resource") =>
  new AppError(404, `${resource} not found`, "NOT_FOUND");

export const conflict = (message: string) =>
  new AppError(409, message, "CONFLICT");

export const unprocessable = (message: string) =>
  new AppError(422, message, "UNPROCESSABLE");

export const internalError = (message = "Internal server error") =>
  new AppError(500, message, "INTERNAL_ERROR");

