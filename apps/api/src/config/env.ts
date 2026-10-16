import dotenv from "dotenv";
dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 3000,
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  elasticsearchUrl: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3000/auth/google/callback",
  sessionSecret: process.env.SESSION_SECRET || "",
  webUrl: process.env.WEB_URL || "http://localhost:3001",
};
