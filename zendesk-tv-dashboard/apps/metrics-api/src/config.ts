import fs from "node:fs";
import path from "node:path";

export type CacheBackend = "redis" | "file";

export interface ApiConfig {
  host: string;
  port: number;
  cacheBackend: CacheBackend;
  redisUrl: string;
  snapshotKey: string;
  refreshRequestFilePath: string;
  snapshotFilePath: string;
  snapshotStaleAfterSeconds: number;
  screenshotFilePath: string;
  screenshotAccessToken: string | null;
  workerStatusFilePath: string;
  corsOrigins: string[];
  apiToken: string | null;
  requestMetricsWindowSize: number;
  supabaseHistoryEnabled: boolean;
  supabaseUrl: string | null;
  supabaseServiceRoleKey: string | null;
  supabaseSnapshotsTable: string;
  supabaseWorkerRunsTable: string;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseCacheBackend(rawValue: string | undefined): CacheBackend {
  if (rawValue?.toLowerCase() === "file") {
    return "file";
  }
  return "redis";
}

function parseList(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { workspaces?: unknown };
        if (packageJson.workspaces) {
          return current;
        }
      } catch {
        // Ignore parse errors and continue walking up.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }
    current = parent;
  }
}

function resolvePathForReadWrite(targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  return path.resolve(workspaceRoot, targetPath);
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const snapshotStaleAfterSeconds = Math.max(30, parseInteger(env.SNAPSHOT_STALE_AFTER_SECONDS, 180));
  const requestMetricsWindowSize = Math.max(20, parseInteger(env.METRICS_REQUEST_METRICS_WINDOW_SIZE, 300));
  const supabaseUrl = env.SUPABASE_URL?.trim() || null;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  const supabaseHistoryEnabled = parseBoolean(env.SUPABASE_HISTORY_ENABLED, parseBoolean(env.SUPABASE_ENABLED, false));

  return {
    host: env.METRICS_API_HOST ?? "0.0.0.0",
    port: parseInteger(env.METRICS_API_PORT, 4000),
    cacheBackend: parseCacheBackend(env.CACHE_BACKEND),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    snapshotKey: env.SNAPSHOT_KEY ?? "zendesk:snapshot",
    refreshRequestFilePath: resolvePathForReadWrite(env.REFRESH_REQUEST_FILE_PATH ?? "./data/refresh-request.json"),
    snapshotFilePath: resolvePathForReadWrite(env.SNAPSHOT_FILE_PATH ?? "./data/zendesk-snapshot.json"),
    snapshotStaleAfterSeconds,
    screenshotFilePath: resolvePathForReadWrite(env.SCREENSHOT_FILE_PATH ?? "./data/latest-dashboard.png"),
    screenshotAccessToken: env.SCREENSHOT_ACCESS_TOKEN?.trim() || null,
    workerStatusFilePath: resolvePathForReadWrite(env.WORKER_STATUS_FILE_PATH ?? "./data/worker-status.json"),
    corsOrigins: parseList(env.METRICS_CORS_ORIGINS),
    apiToken: env.METRICS_API_TOKEN?.trim() || null,
    requestMetricsWindowSize,
    supabaseHistoryEnabled,
    supabaseUrl,
    supabaseServiceRoleKey,
    supabaseSnapshotsTable: env.SUPABASE_TABLE_SNAPSHOTS?.trim() || "snapshots",
    supabaseWorkerRunsTable: env.SUPABASE_TABLE_WORKER_RUNS?.trim() || "worker_runs"
  };
}
