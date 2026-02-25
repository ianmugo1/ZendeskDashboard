import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZendeskClient, type ZendeskSnapshot, type ZendeskTicket } from "@zendesk/zendesk-client";
import { createClient } from "redis";
import { loadApiConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { HttpError, errorHandler } from "./errors.js";
import { logger } from "./logger.js";

loadEnvFiles();

const config = loadApiConfig();
const redisClient = config.cacheBackend === "redis" ? createClient({ url: config.redisUrl }) : null;
const zendeskClient = (() => {
  try {
    return ZendeskClient.fromEnv();
  } catch {
    return null;
  }
})();
const app = express();

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  if (config.corsOrigins.length === 0) {
    return false;
  }
  return config.corsOrigins.includes(origin);
}

function isAuthorizedRequest(req: Request): boolean {
  if (!config.apiToken) {
    return true;
  }

  const authHeader = req.header("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim() === config.apiToken;
  }

  const apiKeyHeader = req.header("x-api-key");
  return apiKeyHeader?.trim() === config.apiToken;
}

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

function withCsvMetadata(snapshot: ZendeskSnapshot, dataset: string, csvPayload: string): string {
  const lines = [
    `# dataset=${dataset}`,
    `# generated_at=${snapshot.generated_at}`,
    `# snapshot_mode=${snapshot.snapshot_mode ?? "unknown"}`,
    `# core_generated_at=${snapshot.core_generated_at ?? snapshot.generated_at}`,
    `# heavy_generated_at=${snapshot.heavy_generated_at ?? snapshot.generated_at}`,
    `# timezone=${snapshot.window_timezone}`
  ];
  return `${lines.join("\n")}\n${csvPayload}`;
}

function parsePositiveInteger(input: string | undefined, fallback: number, max: number): number {
  const parsed = input ? Number.parseInt(input, 10) : Number.NaN;
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseWindowDays(input: string | undefined): 7 | 14 | 30 {
  if (!input) {
    return 7;
  }
  const parsed = Number.parseInt(input, 10);
  if (parsed === 14 || parsed === 30) {
    return parsed;
  }
  return 7;
}

function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getWindowStartYmd(windowDays: 7 | 14 | 30): string {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  return toYmd(start);
}

function getMedianResolutionHours(tickets: ZendeskTicket[]): number {
  const values = tickets
    .map((ticket) => {
      const solvedAt = Date.parse(ticket.solved_at ?? ticket.updated_at);
      const createdAt = Date.parse(ticket.created_at);
      if (Number.isNaN(solvedAt) || Number.isNaN(createdAt) || solvedAt < createdAt) {
        return null;
      }
      return (solvedAt - createdAt) / 36e5;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return 0;
  }
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[middle - 1] + values[middle]) / 2;
  }
  return values[middle];
}

function buildDailyCounts(tickets: ZendeskTicket[], startYmd: string, endYmd: string, useSolvedDate: boolean): Array<{ date: string; count: number }> {
  const dates: string[] = [];
  const cursor = new Date(`${startYmd}T00:00:00.000Z`);
  const end = new Date(`${endYmd}T00:00:00.000Z`);
  while (cursor <= end) {
    dates.push(toYmd(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const counts = new Map<string, number>(dates.map((date) => [date, 0]));
  for (const ticket of tickets) {
    const source = useSolvedDate ? ticket.solved_at ?? ticket.updated_at : ticket.updated_at;
    const parsed = Date.parse(source);
    if (Number.isNaN(parsed)) {
      continue;
    }
    const key = toYmd(new Date(parsed));
    if (!counts.has(key)) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
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

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin not allowed."));
    }
  })
);
app.use(express.json());
app.use("/api/metrics", (req, _res, next) => {
  if (!isAuthorizedRequest(req)) {
    next(new HttpError(401, "Unauthorized metrics API access."));
    return;
  }
  next();
});
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
    res.set("Cache-Control", "no-store");
    res.json(snapshot);
  })
);

app.get(
  "/api/metrics/summary/daily",
  asyncRoute(async (_req, res) => {
    const snapshot = await getSnapshotOrThrow();
    res.set("Cache-Control", "no-store");
    res.json(snapshot.daily_summary);
  })
);

app.get(
  "/api/metrics/worker-status",
  asyncRoute(async (_req, res) => {
    const raw = await fs.readFile(config.workerStatusFilePath, "utf-8").catch(() => null);
    if (!raw) {
      throw new HttpError(503, "Worker status not available yet.");
    }

    const parsed = JSON.parse(raw) as unknown;
    res.set("Cache-Control", "no-store");
    res.json(parsed);
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
  "/api/metrics/audit/solved",
  asyncRoute(async (req, res) => {
    const snapshot = await getSnapshotOrThrow();
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const agentId = typeof req.query.agent_id === "string" ? req.query.agent_id.trim() : "all";
    const page = parsePositiveInteger(typeof req.query.page === "string" ? req.query.page : undefined, 1, 10000);
    const pageSize = parsePositiveInteger(typeof req.query.page_size === "string" ? req.query.page_size : undefined, 25, 100);

    const filtered = snapshot.solved_tickets_7d.filter((ticket) => {
      const matchesAgent = agentId === "all" || String(ticket.assignee_id) === agentId;
      const matchesQuery =
        query.length === 0 || ticket.subject.toLowerCase().includes(query) || String(ticket.id).includes(query);
      return matchesAgent && matchesQuery;
    });

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const items = filtered.slice(start, start + pageSize);
    res.set("Cache-Control", "no-store");
    res.json({
      page,
      page_size: pageSize,
      total,
      generated_at: snapshot.generated_at,
      core_generated_at: snapshot.core_generated_at ?? snapshot.generated_at,
      heavy_generated_at: snapshot.heavy_generated_at ?? snapshot.generated_at,
      items
    });
  })
);

app.get(
  "/api/metrics/agent/:agentId",
  asyncRoute(async (req, res) => {
    if (!zendeskClient) {
      throw new HttpError(503, "Zendesk credentials are not configured on metrics API.");
    }

    const agentId = Number.parseInt(req.params.agentId, 10);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      throw new HttpError(400, "Invalid agent id.");
    }

    const windowDays = parseWindowDays(typeof req.query.window_days === "string" ? req.query.window_days : undefined);
    const startYmd = getWindowStartYmd(windowDays);
    const todayYmd = toYmd(new Date());
    const snapshot = await getSnapshotOrThrow();
    const resolutionTargetHours = snapshot.sla_health_7d.resolution_target_hours;

    const [respondedCount, solvedTickets, openBacklogCount, reopenedProxyCount, atRiskTicketsRaw] = await Promise.all([
      zendeskClient.searchCount(`type:ticket commenter:${agentId} updated>=${startYmd}`),
      zendeskClient.searchAllTickets(`type:ticket assignee:${agentId} solved>=${startYmd}`, {
        limit: 500,
        pageSize: 100,
        sortBy: "updated_at",
        sortOrder: "desc"
      }),
      zendeskClient.searchCount(`type:ticket assignee:${agentId} -status:solved -status:closed`),
      zendeskClient.searchCount(`type:ticket assignee:${agentId} -status:solved -status:closed solved>=${startYmd}`),
      zendeskClient.searchAllTickets(`type:ticket assignee:${agentId} status<solved priority>normal`, {
        limit: 40,
        pageSize: 40,
        sortBy: "updated_at",
        sortOrder: "asc"
      })
    ]);

    const solvedCount = solvedTickets.length;
    const medianResolutionHours = getMedianResolutionHours(solvedTickets);
    const withinTargetCount = solvedTickets.filter((ticket) => {
      const solvedAt = Date.parse(ticket.solved_at ?? ticket.updated_at);
      const createdAt = Date.parse(ticket.created_at);
      if (Number.isNaN(solvedAt) || Number.isNaN(createdAt) || solvedAt < createdAt) {
        return false;
      }
      return (solvedAt - createdAt) / 36e5 <= resolutionTargetHours;
    }).length;
    const resolutionWithinTargetPct = solvedCount === 0 ? 0 : (withinTargetCount / solvedCount) * 100;

    const allAgentRows = snapshot.all_agents ?? [];
    const agentSummary = allAgentRows.find((row) => row.agent_id === agentId);
    const agentName = agentSummary?.agent_name ?? `Agent ${agentId}`;

    const dailySolved = buildDailyCounts(solvedTickets, startYmd, todayYmd, true);
    const respondedTickets = await zendeskClient.searchAllTickets(`type:ticket commenter:${agentId} updated>=${startYmd}`, {
      limit: 500,
      pageSize: 100,
      sortBy: "updated_at",
      sortOrder: "desc"
    });
    const dailyResponded = buildDailyCounts(respondedTickets, startYmd, todayYmd, false);

    res.set("Cache-Control", "no-store");
    res.json({
      agent_id: agentId,
      agent_name: agentName,
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      metrics: {
        responded_count: respondedCount,
        solved_count: solvedCount,
        median_resolution_hours: Number(medianResolutionHours.toFixed(2)),
        resolution_within_target_pct: Number(resolutionWithinTargetPct.toFixed(1)),
        reopen_proxy_count: reopenedProxyCount,
        open_backlog_count: openBacklogCount
      },
      trends: {
        responded: dailyResponded,
        solved: dailySolved
      },
      solved_tickets: solvedTickets.slice(0, 50).map((ticket) => ({
        id: ticket.id,
        subject: ticket.subject ?? "Untitled ticket",
        created_at: ticket.created_at,
        solved_at: ticket.solved_at ?? ticket.updated_at,
        status: ticket.status,
        priority: ticket.priority ?? "normal"
      })),
      at_risk_tickets: atRiskTicketsRaw.slice(0, 25).map((ticket) => ({
        id: ticket.id,
        subject: ticket.subject ?? "Untitled ticket",
        status: ticket.status,
        priority: ticket.priority ?? "normal",
        created_at: ticket.created_at,
        updated_at: ticket.updated_at
      }))
    });
  })
);

app.get(
  "/api/metrics/export/:dataset",
  asyncRoute(async (req, res) => {
    const snapshot = await getSnapshotOrThrow();
    const dataset = req.params.dataset.replace(/\.csv$/i, "");
    const csv = buildExportCsv(snapshot, dataset);
    const includeMetadata = req.query.meta === "1";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${csv.filename}"`);
    res.status(200).send(includeMetadata ? withCsvMetadata(snapshot, dataset, csv.payload) : csv.payload);
  })
);

app.post(
  "/api/metrics/refresh",
  asyncRoute(async (_req, res) => {
    const payload = {
      request_id: randomUUID(),
      requested_at: new Date().toISOString(),
      force_heavy: true
    };
    await fs.mkdir(path.dirname(config.refreshRequestFilePath), { recursive: true });
    await fs.writeFile(config.refreshRequestFilePath, JSON.stringify(payload, null, 2), "utf-8");
    res.status(202).json({
      status: "accepted",
      ...payload
    });
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
        screenshot_protected: Boolean(config.screenshotAccessToken),
        metrics_api_token_protected: Boolean(config.apiToken),
        cors_origin_count: config.corsOrigins.length,
        worker_status_file_path: config.workerStatusFilePath,
        refresh_request_file_path: config.refreshRequestFilePath
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
