import rateLimit from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { Redis } from "ioredis";

import { env } from "../config/env.js";

const rateLimitRedis = new Redis(env.redisUrl, {
  lazyConnect: true,
  connectionName: "newtonite-rate-limits",
});

rateLimitRedis.on("error", (error) => {
  console.error("[Redis] Rate-limit store error:", error);
});

export async function connectRateLimitStore(): Promise<void> {
  await rateLimitRedis.ping();
}

export async function closeRateLimitStore(): Promise<void> {
  await rateLimitRedis.quit();
}

// General API Rate Limiter: Allows 100 requests per 15 minutes per IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    status: "error",
    error: "Too many requests, please try again later.",
  },
});

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many requests. Please try again later.",
  },
});

// Strict Rate Limiter: For sensitive operations (e.g., Auth, Idempotent creation)
export const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Limit each IP to 15 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many attempts. Please wait before trying again.",
  },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: new RedisStore({
    prefix: "rate-limit:login:",
    sendCommand: async (...args): Promise<RedisReply> => {
      const reply: unknown = await rateLimitRedis.call(
        args[0]!,
        ...args.slice(1),
      );
      if (typeof reply === "boolean" || typeof reply === "number" || typeof reply === "string") {
        return reply;
      }
      if (
        Array.isArray(reply) &&
        reply.every(
          (value) =>
            typeof value === "boolean" ||
            typeof value === "number" ||
            typeof value === "string",
        )
      ) {
        return reply;
      }
      throw new Error("Redis rate-limit command returned an invalid response");
    },
  }),
  message: {
    success: false,
    message: "Too many login attempts. Please wait before trying again.",
  },
});

export const sseLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "error",
    error: "Too many connection attempts. Please try again later.",
  },
});
