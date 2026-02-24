import fs from "node:fs";
import path from "node:path";

export type CacheBackend = "redis" | "file";

export interface ApiConfig {
  host: string;
  port: number;
  cacheBackend: CacheBackend;
  redisUrl: string;
  snapshotKey: string;
  snapshotFilePath: string;
  snapshotStaleAfterSeconds: number;
  screenshotFilePath: string;
  screenshotAccessToken: string | null;
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

  return {
    host: env.METRICS_API_HOST ?? "0.0.0.0",
    port: parseInteger(env.METRICS_API_PORT, 4000),
    cacheBackend: parseCacheBackend(env.CACHE_BACKEND),
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    snapshotKey: env.SNAPSHOT_KEY ?? "zendesk:snapshot",
    snapshotFilePath: resolvePathForReadWrite(env.SNAPSHOT_FILE_PATH ?? "./data/zendesk-snapshot.json"),
    snapshotStaleAfterSeconds,
    screenshotFilePath: resolvePathForReadWrite(env.SCREENSHOT_FILE_PATH ?? "./data/latest-dashboard.png"),
    screenshotAccessToken: env.SCREENSHOT_ACCESS_TOKEN?.trim() || null
  };
}
