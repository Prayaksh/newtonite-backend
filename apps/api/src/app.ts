import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { env } from "./config/env.js";
import { db } from "@repo/db";
import { authenticate } from "./middlewares/authenticate.js";
import workItemRouter from "./routes/work-items.routes.js";
import userRouter from "./routes/users.routes.js";
import teamRouter from "./routes/teams.routes.js";
import { errorHandler } from "./middlewares/error-handler.js";

const app: Express = express();

app.use(
  cors({
    origin: env.webUrl,
    credentials: true,
  }),
);

app.use(express.json());
app.use(cookieParser(env.sessionSecret));

app.get("/", (_req, res) => {
  res.status(200).json({
    status: "success",
    message: "home",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "success",
    message: "working",
  });
});

app.get("/db", async (_req, res, next) => {
  try {
    await db.$queryRaw`SELECT 1`;

    res.status(200).json({
      success: true,
      message: "Database connection successful",
    });
  } catch (error) {
    next(error);
  }
});

app.use("/api/v1/work-items", authenticate, workItemRouter);
app.use("/api/work-items", authenticate, workItemRouter);

app.use("/api/v1/users", authenticate, userRouter);
app.use("/api/users", authenticate, userRouter);

app.use("/api/v1/teams", authenticate, teamRouter);
app.use("/api/teams", authenticate, teamRouter);

app.use((_req, res) => {
  res.status(404).json({
    status: "error",
    message: "Route not found",
  });
});

app.use(errorHandler);

export default app;
