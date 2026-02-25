import fs from "node:fs";
import path from "node:path";

export interface DashboardConfigFile {
  tags: string[];
  groupIds: number[];
  viewIds: number[];
}

export type CacheBackend = "redis" | "file";

export interface AlertThresholds {
  unsolvedWarn: number;
  attentionWarn: number;
  unassignedWarn: number;
}

export interface SlaTargets {
  firstResponseHours: number;
  resolutionHours: number;
}

export interface TeamsNotifyConfig {
  enabled: boolean;
  webhookUrl: string | null;
  dashboardPublicUrl: string | null;
  screenshotCaptureUrl: string | null;
  screenshotFilePath: string;
  screenshotPublicUrl: string | null;
  screenshotAccessToken: string | null;
  screenshotBrowserPath: string | null;
  screenshotWidth: number;
  screenshotHeight: number;
  screenshotTimeoutMs: number;
  screenshotBasicAuthUsername: string | null;
  screenshotBasicAuthPassword: string | null;
  notifyIntervalSeconds: number;
}

export interface WorkerConfig {
  cacheBackend: CacheBackend;
  redisUrl: string;
  snapshotKey: string;
  lockKey: string;
  refreshRequestFilePath: string;
  snapshotFilePath: string;
  pollIntervalSeconds: number;
  heavyRefreshIntervalSeconds: number;
  rateLimitLowWatermark: number;
  rateLimitCriticalWatermark: number;
  maxTicketScan: number;
  maxSolvedAuditTickets: number;
  maxAgentScan: number;
  dashboardTimezone: string;
  alertThresholds: AlertThresholds;
  slaTargets: SlaTargets;
  highPriorityStaleHours: number;
  teamsNotify: TeamsNotifyConfig;
  dashboardConfig: DashboardConfigFile;
}

function parseInteger(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const parsed = Number.parseInt(input, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseBoolean(input: string | undefined, fallback: boolean): boolean {
  if (!input) {
    return fallback;
  }

  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseTagListFromEnv(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseCacheBackend(rawValue: string | undefined): CacheBackend {
  if (rawValue?.toLowerCase() === "file") {
    return "file";
  }
  return "redis";
}

function parseTimezone(rawValue: string | undefined): string {
  const timezone = rawValue?.trim() || "Europe/Dublin";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`Invalid DASHBOARD_TIMEZONE: ${timezone}`);
  }
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

function resolveConfigPath(configFilePath: string): string {
  const resolved = resolvePathForReadWrite(configFilePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Could not find config file: ${configFilePath}`);
  }
  return resolved;
}

function loadDashboardConfig(configFilePath: string, envTagList: string[]): DashboardConfigFile {
  const resolvedPath = resolveConfigPath(configFilePath);
  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<DashboardConfigFile>;
  const fileTags = Array.isArray(parsed.tags) ? parsed.tags : [];
  const mergedTags = Array.from(new Set([...fileTags, ...envTagList]));

  return {
    tags: mergedTags,
    groupIds: Array.isArray(parsed.groupIds) ? parsed.groupIds.filter((id) => Number.isInteger(id)) : [],
    viewIds: Array.isArray(parsed.viewIds) ? parsed.viewIds.filter((id) => Number.isInteger(id)) : []
  };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const cacheBackend = parseCacheBackend(env.CACHE_BACKEND);
  const redisUrl = env.REDIS_URL ?? "redis://localhost:6379";
  const snapshotKey = env.SNAPSHOT_KEY ?? "zendesk:snapshot";
  const lockKey = env.SNAPSHOT_LOCK_KEY ?? `${snapshotKey}:poll-lock`;
  const refreshRequestFilePath = resolvePathForReadWrite(env.REFRESH_REQUEST_FILE_PATH ?? "./data/refresh-request.json");
  const snapshotFilePath = resolvePathForReadWrite(env.SNAPSHOT_FILE_PATH ?? "./data/zendesk-snapshot.json");
  const requestedPollInterval = parseInteger(env.POLL_INTERVAL_SECONDS, 20);
  const pollIntervalSeconds = Math.max(20, requestedPollInterval);
  const requestedHeavyRefreshInterval = parseInteger(env.HEAVY_REFRESH_INTERVAL_SECONDS, Math.max(1800, pollIntervalSeconds * 2));
  const heavyRefreshIntervalSeconds = Math.max(pollIntervalSeconds, requestedHeavyRefreshInterval);
  const rateLimitLowWatermark = Math.max(1, parseInteger(env.ZENDESK_RATE_LIMIT_LOW_WATERMARK, 100));
  const rateLimitCriticalWatermark = Math.max(1, parseInteger(env.ZENDESK_RATE_LIMIT_CRITICAL_WATERMARK, 20));
  const maxTicketScan = Math.max(100, parseInteger(env.MAX_TICKET_SCAN, 500));
  const maxSolvedAuditTickets = Math.max(50, parseInteger(env.MAX_SOLVED_AUDIT_TICKETS, 300));
  const maxAgentScan = Math.max(50, parseInteger(env.MAX_AGENT_SCAN, 500));
  const dashboardTimezone = parseTimezone(env.DASHBOARD_TIMEZONE);
  const alertThresholds: AlertThresholds = {
    unsolvedWarn: Math.max(1, parseInteger(env.THRESHOLD_UNSOLVED_WARN, 80)),
    attentionWarn: Math.max(1, parseInteger(env.THRESHOLD_ATTENTION_WARN, 10)),
    unassignedWarn: Math.max(1, parseInteger(env.THRESHOLD_UNASSIGNED_WARN, 10))
  };
  const slaTargets: SlaTargets = {
    firstResponseHours: Math.max(1, parseInteger(env.SLA_FIRST_RESPONSE_TARGET_HOURS, 2)),
    resolutionHours: Math.max(1, parseInteger(env.SLA_RESOLUTION_TARGET_HOURS, 72))
  };
  const highPriorityStaleHours = Math.max(1, parseInteger(env.HIGH_PRIORITY_STALE_HOURS, 8));
  const teamsNotifyEnabled = parseBoolean(env.TEAMS_NOTIFICATIONS_ENABLED, Boolean(env.TEAMS_WEBHOOK_URL));
  const screenshotFilePath = resolvePathForReadWrite(env.SCREENSHOT_FILE_PATH ?? "./data/latest-dashboard.png");
  const metricsPublicBaseUrl = env.METRICS_PUBLIC_BASE_URL?.trim() || null;
  const screenshotAccessToken = env.SCREENSHOT_ACCESS_TOKEN?.trim() || null;
  const screenshotPublicUrlFromEnv = env.SCREENSHOT_PUBLIC_URL?.trim() || null;
  const screenshotPublicUrl =
    screenshotPublicUrlFromEnv ??
    (metricsPublicBaseUrl
      ? `${metricsPublicBaseUrl.replace(/\/+$/, "")}/api/metrics/screenshot/latest${
          screenshotAccessToken ? `?token=${encodeURIComponent(screenshotAccessToken)}` : ""
        }`
      : null);
  const teamsNotify: TeamsNotifyConfig = {
    enabled: teamsNotifyEnabled,
    webhookUrl: env.TEAMS_WEBHOOK_URL?.trim() || null,
    dashboardPublicUrl: env.DASHBOARD_PUBLIC_URL?.trim() || null,
    screenshotCaptureUrl: env.SCREENSHOT_CAPTURE_URL?.trim() || null,
    screenshotFilePath,
    screenshotPublicUrl,
    screenshotAccessToken,
    screenshotBrowserPath: env.SCREENSHOT_BROWSER_PATH?.trim() || null,
    screenshotWidth: Math.max(640, parseInteger(env.SCREENSHOT_WIDTH, 1920)),
    screenshotHeight: Math.max(360, parseInteger(env.SCREENSHOT_HEIGHT, 1080)),
    screenshotTimeoutMs: Math.max(5000, parseInteger(env.SCREENSHOT_TIMEOUT_MS, 45000)),
    screenshotBasicAuthUsername: env.SCREENSHOT_BASIC_AUTH_USERNAME?.trim() || null,
    screenshotBasicAuthPassword: env.SCREENSHOT_BASIC_AUTH_PASSWORD?.trim() || null,
    notifyIntervalSeconds: Math.max(60, parseInteger(env.TEAMS_NOTIFY_INTERVAL_SECONDS, 3600))
  };
  const configPath = env.CONFIG_FILE_PATH ?? "./config/dashboard.config.json";
  const envTags = parseTagListFromEnv(env.TICKETS_BY_TAG_LIST);
  const dashboardConfig = loadDashboardConfig(configPath, envTags);

  return {
    cacheBackend,
    redisUrl,
    snapshotKey,
    lockKey,
    refreshRequestFilePath,
    snapshotFilePath,
    pollIntervalSeconds,
    heavyRefreshIntervalSeconds,
    rateLimitLowWatermark,
    rateLimitCriticalWatermark,
    maxTicketScan,
    maxSolvedAuditTickets,
    maxAgentScan,
    dashboardTimezone,
    alertThresholds,
    slaTargets,
    highPriorityStaleHours,
    teamsNotify,
    dashboardConfig
  };
}
