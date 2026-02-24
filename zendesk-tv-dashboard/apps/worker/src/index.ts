import fs from "node:fs/promises";
import path from "node:path";
import { ZendeskClient } from "@zendesk/zendesk-client";
import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import { createClient } from "redis";
import { loadWorkerConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { logger } from "./logger.js";
import { buildZendeskSnapshot } from "./snapshot-builder.js";
import { validateSnapshotOrThrow } from "./snapshot-schema.js";
import { createTeamsNotifier } from "./teams-notifier.js";

loadEnvFiles();

const config = loadWorkerConfig();
const redisClient = config.cacheBackend === "redis" ? createClient({ url: config.redisUrl }) : null;
const zendeskClient = ZendeskClient.fromEnv();
const teamsNotifier = createTeamsNotifier(config.teamsNotify, logger);

let pollInFlight = false;

async function persistSnapshot(snapshot: ZendeskSnapshot): Promise<void> {
  if (config.cacheBackend === "redis" && redisClient) {
    const generatedAt = snapshot.generated_at ?? new Date().toISOString();
    await redisClient.set(config.snapshotKey, JSON.stringify(snapshot));
    await redisClient.set(`${config.snapshotKey}:updated_at`, generatedAt);
    return;
  }

  const outputPath = config.snapshotFilePath;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(snapshot), "utf-8");
}

async function runPoll(): Promise<void> {
  if (pollInFlight) {
    logger.warn("Skipping poll because previous run is still in progress.");
    return;
  }

  pollInFlight = true;
  const startedAt = Date.now();

  try {
    const snapshot = await buildZendeskSnapshot({
      client: zendeskClient,
      dashboardConfig: config.dashboardConfig,
      maxTicketScan: config.maxTicketScan,
      maxSolvedAuditTickets: config.maxSolvedAuditTickets,
      maxAgentScan: config.maxAgentScan,
      pollIntervalSeconds: config.pollIntervalSeconds,
      timeZone: config.dashboardTimezone,
      alertThresholds: config.alertThresholds,
      slaTargets: config.slaTargets,
      highPriorityStaleHours: config.highPriorityStaleHours,
      logger
    });

    validateSnapshotOrThrow(snapshot);
    await persistSnapshot(snapshot);
    try {
      await teamsNotifier.maybeNotify(snapshot);
    } catch (error) {
      logger.error({ err: error }, "Failed to post Teams notification");
    }

    logger.info(
      {
        duration_ms: Date.now() - startedAt,
        cache_backend: config.cacheBackend,
        key: config.cacheBackend === "redis" ? config.snapshotKey : config.snapshotFilePath,
        generated_at: snapshot.generated_at,
        unsolved_count: snapshot.unsolved_count,
        active_alert_count: snapshot.alerts.active_count
      },
      "Snapshot updated"
    );
  } catch (error) {
    logger.error(
      {
        err: error,
        duration_ms: Date.now() - startedAt
      },
      "Failed to update snapshot"
    );
  } finally {
    pollInFlight = false;
  }
}

async function bootstrap(): Promise<void> {
  if (config.cacheBackend === "redis" && redisClient) {
    redisClient.on("error", (error) => {
      logger.error({ err: error }, "Redis client error");
    });
    await redisClient.connect();
  } else {
    await fs.mkdir(path.dirname(config.snapshotFilePath), { recursive: true });
  }

  logger.info(
    {
      cache_backend: config.cacheBackend,
      redis_url: config.cacheBackend === "redis" ? config.redisUrl : undefined,
      snapshot_key: config.cacheBackend === "redis" ? config.snapshotKey : undefined,
      snapshot_file_path: config.cacheBackend === "file" ? config.snapshotFilePath : undefined,
      poll_interval_seconds: config.pollIntervalSeconds,
      dashboard_timezone: config.dashboardTimezone,
      alert_thresholds: config.alertThresholds,
      sla_targets: config.slaTargets,
      high_priority_stale_hours: config.highPriorityStaleHours,
      teams_notifications_enabled: config.teamsNotify.enabled,
      teams_notify_interval_seconds: config.teamsNotify.notifyIntervalSeconds,
      screenshot_capture_enabled: Boolean(config.teamsNotify.screenshotCaptureUrl),
      max_ticket_scan: config.maxTicketScan,
      max_solved_audit_tickets: config.maxSolvedAuditTickets,
      max_agent_scan: config.maxAgentScan,
      configured_tag_count: config.dashboardConfig.tags.length
    },
    "Worker connected and starting"
  );

  await runPoll();
  setInterval(runPoll, config.pollIntervalSeconds * 1000);
}

async function shutdown(): Promise<void> {
  logger.info("Worker shutting down");
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
  logger.fatal({ err: error }, "Worker failed during startup");
  process.exit(1);
});
