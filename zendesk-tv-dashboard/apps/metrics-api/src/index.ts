import fs from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import { createClient } from "redis";
import { loadApiConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { HttpError, errorHandler } from "./errors.js";
import { logger } from "./logger.js";

loadEnvFiles();

const config = loadApiConfig();
const redisClient = config.cacheBackend === "redis" ? createClient({ url: config.redisUrl }) : null;
const app = express();

function assertSnapshotFresh(snapshot: ZendeskSnapshot): void {
  const generatedAtMs = Date.parse(snapshot.generated_at);
  if (Number.isNaN(generatedAtMs)) {
    throw new HttpError(500, "Snapshot has invalid generated_at timestamp.");
  }

  const ageSeconds = Math.floor((Date.now() - generatedAtMs) / 1000);
  if (ageSeconds > config.snapshotStaleAfterSeconds) {
    throw new HttpError(503, "Snapshot is stale.", {
      age_seconds: ageSeconds,
      stale_after_seconds: config.snapshotStaleAfterSeconds,
      generated_at: snapshot.generated_at
    });
  }
}

function parseSnapshot(rawSnapshot: string): ZendeskSnapshot {
  try {
    return JSON.parse(rawSnapshot) as ZendeskSnapshot;
  } catch (error) {
    throw new HttpError(500, "Cached snapshot is not valid JSON.", error);
  }
}

async function getSnapshotRaw(): Promise<string | null> {
  if (config.cacheBackend === "redis" && redisClient) {
    return redisClient.get(config.snapshotKey);
  }

  try {
    return await fs.readFile(config.snapshotFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getSnapshotOrThrow(): Promise<ZendeskSnapshot> {
  const rawSnapshot = await getSnapshotRaw();
  if (!rawSnapshot) {
    throw new HttpError(503, "Snapshot not available yet.");
  }

  const snapshot = parseSnapshot(rawSnapshot);
  assertSnapshotFresh(snapshot);
  return snapshot;
}

async function getCacheHealth(): Promise<{ status: "up" | "degraded"; backend: string; detail?: string }> {
  if (config.cacheBackend === "redis" && redisClient) {
    const redisPing = await redisClient.ping();
    return {
      status: redisPing === "PONG" ? "up" : "degraded",
      backend: "redis"
    };
  }

  await fs.mkdir(path.dirname(config.snapshotFilePath), { recursive: true });
  return {
    status: "up",
    backend: "file",
    detail: config.snapshotFilePath
  };
}

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function csvEscape(value: string | number | null | undefined): string {
  const source = value === null || value === undefined ? "" : String(value);
  if (!source.includes(",") && !source.includes("\"") && !source.includes("\n")) {
    return source;
  }
  return `"${source.replace(/"/g, "\"\"")}"`;
}

function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const headerRow = headers.map((header) => csvEscape(header)).join(",");
  const body = rows.map((row) => row.map((cell) => csvEscape(cell)).join(",")).join("\n");
  return `${headerRow}\n${body}`;
}

function buildExportCsv(snapshot: ZendeskSnapshot, dataset: string): { filename: string; payload: string } {
  if (dataset === "agent-performance") {
    return {
      filename: "agent-performance-7d.csv",
      payload: toCsv(
        [
          "agent_id",
          "agent_name",
          "solved_count_7d",
          "median_resolution_hours",
          "resolution_within_target_pct",
          "reopen_proxy_count_30d",
          "open_backlog_count"
        ],
        snapshot.agent_performance_7d.map((row) => [
          row.agent_id,
          row.agent_name,
          row.solved_count_7d,
          row.median_resolution_hours,
          row.resolution_within_target_pct,
          row.reopen_proxy_count_30d,
          row.open_backlog_count
        ])
      )
    };
  }

  if (dataset === "solved-tickets-7d") {
    return {
      filename: "solved-tickets-7d.csv",
      payload: toCsv(
        ["id", "subject", "created_at", "solved_at", "assignee_id", "assignee_name", "age_hours"],
        snapshot.solved_tickets_7d.map((row) => [
          row.id,
          row.subject,
          row.created_at,
          row.solved_at,
          row.assignee_id,
          row.assignee_name,
          row.age_hours
        ])
      )
    };
  }

  if (dataset === "reopened-tickets-30d") {
    return {
      filename: "reopened-tickets-30d.csv",
      payload: toCsv(
        [
          "id",
          "subject",
          "status",
          "priority",
          "created_at",
          "updated_at",
          "last_solved_at",
          "assignee_id",
          "assignee_name",
          "age_hours",
          "stale_hours"
        ],
        snapshot.reopened_tickets_30d.map((row) => [
          row.id,
          row.subject,
          row.status,
          row.priority,
          row.created_at,
          row.updated_at,
          row.last_solved_at,
          row.assignee_id,
          row.assignee_name,
          row.age_hours,
          row.stale_hours
        ])
      )
    };
  }

  if (dataset === "group-workload") {
    return {
      filename: "group-workload.csv",
      payload: toCsv(
        ["group_id", "group_name", "open_count", "solved_count_7d", "high_priority_open_count"],
        snapshot.group_workload.map((row) => [
          row.group_id,
          row.group_name,
          row.open_count,
          row.solved_count_7d,
          row.high_priority_open_count
        ])
      )
    };
  }

  if (dataset === "high-priority-risk") {
    return {
      filename: "high-priority-risk.csv",
      payload: toCsv(
        [
          "id",
          "subject",
          "status",
          "priority",
          "created_at",
          "updated_at",
          "stale_hours",
          "assignee_id",
          "assignee_name"
        ],
        snapshot.high_priority_risk_tickets.map((row) => [
          row.id,
          row.subject,
          row.status,
          row.priority,
          row.created_at,
          row.updated_at,
          row.stale_hours,
          row.assignee_id,
          row.assignee_name
        ])
      )
    };
  }

  if (dataset === "daily-summary") {
    const summary = snapshot.daily_summary;
    return {
      filename: "daily-summary.csv",
      payload: toCsv(
        [
          "date",
          "generated_at",
          "unsolved_count",
          "created_today",
          "solved_count_7d",
          "attention_count",
          "sla_within_target_pct",
          "active_alert_count"
        ],
        [
          [
            summary.date,
            summary.generated_at,
            summary.unsolved_count,
            summary.created_today,
            summary.solved_count_7d,
            summary.attention_count,
            summary.sla_within_target_pct,
            summary.active_alert_count
          ]
        ]
      )
    };
  }

  throw new HttpError(404, `Unknown export dataset: ${dataset}`);
}

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    logger.info(
      {
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt
      },
      "HTTP request completed"
    );
  });
  next();
});

app.get(
  "/health",
  asyncRoute(async (_req, res) => {
    const cache = await getCacheHealth();
    res.json({
      status: "ok",
      service: "metrics-api",
      cache,
      timestamp: new Date().toISOString()
    });
  })
);

app.get(
  "/api/metrics/snapshot",
  asyncRoute(async (_req, res) => {
    const snapshot = await getSnapshotOrThrow();
    res.json(snapshot);
  })
);

app.get(
  "/api/metrics/summary/daily",
  asyncRoute(async (_req, res) => {
    const snapshot = await getSnapshotOrThrow();
    res.json(snapshot.daily_summary);
  })
);

app.get(
  "/api/metrics/screenshot/latest",
  asyncRoute(async (req, res) => {
    if (config.screenshotAccessToken) {
      const token = typeof req.query.token === "string" ? req.query.token : null;
      if (token !== config.screenshotAccessToken) {
        throw new HttpError(401, "Unauthorized screenshot access.");
      }
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await fs.readFile(config.screenshotFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "Screenshot not available yet.");
      }
      throw error;
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(imageBuffer);
  })
);

app.get(
  "/api/metrics/export/:dataset",
  asyncRoute(async (req, res) => {
    const snapshot = await getSnapshotOrThrow();
    const dataset = req.params.dataset.replace(/\.csv$/i, "");
    const csv = buildExportCsv(snapshot, dataset);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${csv.filename}"`);
    res.status(200).send(csv.payload);
  })
);

app.use(errorHandler);

async function bootstrap(): Promise<void> {
  if (config.cacheBackend === "redis" && redisClient) {
    redisClient.on("error", (error) => {
      logger.error({ err: error }, "Redis client error");
    });
    await redisClient.connect();
  } else {
    await fs.mkdir(path.dirname(config.snapshotFilePath), { recursive: true });
  }

  app.listen(config.port, config.host, () => {
    logger.info(
      {
        host: config.host,
        port: config.port,
        cache_backend: config.cacheBackend,
        redis_url: config.cacheBackend === "redis" ? config.redisUrl : undefined,
        snapshot_key: config.cacheBackend === "redis" ? config.snapshotKey : undefined,
        snapshot_file_path: config.cacheBackend === "file" ? config.snapshotFilePath : undefined,
        snapshot_stale_after_seconds: config.snapshotStaleAfterSeconds,
        screenshot_file_path: config.screenshotFilePath,
        screenshot_protected: Boolean(config.screenshotAccessToken)
      },
      "Metrics API listening"
    );
  });
}

async function shutdown(): Promise<void> {
  logger.info("Metrics API shutting down");
  if (config.cacheBackend === "redis" && redisClient) {
    try {
      await redisClient.quit();
    } catch (error) {
      logger.error({ err: error }, "Failed to close Redis client cleanly");
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bootstrap().catch((error) => {
  logger.fatal({ err: error }, "Metrics API failed during startup");
  process.exit(1);
});
