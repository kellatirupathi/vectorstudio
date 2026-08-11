import fs from "node:fs";

import cors from "cors";
import express from "express";

import { ALLOWED_ORIGINS, APP_ACCESS_TOKEN, PORT, STORAGE_DIR, WORKER_CONCURRENCY } from "./config.js";
import batchRouter from "./routes/batch.js";
import { loadBatchFromDisk } from "./services/batchStore.js";
import { resumeBatchIfNeeded } from "./services/batchRunner.js";

const app = express();

fs.mkdirSync(STORAGE_DIR, { recursive: true });

const corsOptions: cors.CorsOptions =
  ALLOWED_ORIGINS.length === 0
    ? {}
    : {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-access-token"],
      };

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * Shared-token auth. Every /api route except /api/health requires the token
 * once APP_ACCESS_TOKEN is set. Without it the API is fully open, which would
 * let anyone with the URL spend your OpenAI credits.
 */
app.use("/api", (req, res, next) => {
  if (!APP_ACCESS_TOKEN) {
    next();
    return;
  }

  const header = req.header("x-access-token") ?? "";
  const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const provided = header || bearer;

  if (provided !== APP_ACCESS_TOKEN) {
    res.status(401).json({ error: "Unauthorized. A valid access token is required." });
    return;
  }
  next();
});

app.use("/api/batch", batchRouter);

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ level: "ERROR", message: String(error?.message ?? error) }));
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  loadBatchFromDisk();
  resumeBatchIfNeeded();
  console.log(
    JSON.stringify({
      level: "INFO",
      message: "Vector Studio API started",
      port: PORT,
      storageDir: STORAGE_DIR,
      concurrency: WORKER_CONCURRENCY,
      authEnabled: Boolean(APP_ACCESS_TOKEN),
    }),
  );
});
