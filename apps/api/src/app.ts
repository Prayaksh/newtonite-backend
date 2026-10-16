import express, { Express } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import cookieParser from "cookie-parser";

import { db } from "@repo/db";
const app: Express = express();

app.use(
  cors({
    origin: env.webUrl,
    credentials: true,
  }),
);
app.use(express.json());

app.use(cookieParser(env.sessionSecret));

app.get("/", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "home",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "working..",
  });
});

app.get("/db", async (req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;

    return res.status(200).json({
      success: true,
      message: "Database connection successful",
    });
  } catch (error) {
    console.error("Database connection error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to connect to the database",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: `Route ${req.originalUrl} not found`,
  });
});

export default app;
