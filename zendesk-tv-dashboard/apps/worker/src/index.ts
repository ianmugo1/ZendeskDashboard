import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ZendeskClient } from "@zendesk/zendesk-client";
import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import { createClient } from "redis";
import { loadWorkerConfig } from "./config.js";
import { loadEnvFiles } from "./env.js";
import { logger } from "./logger.js";
import { buildZendeskSnapshot } from "./snapshot-builder.js";
import { validateSnapshotOrThrow } from "./snapshot-schema.js";
import { createTeamsNotifier } from "./teams-notifier.js";
import { createSupabaseRecorder } from "./supabase-recorder.js";

loadEnvFiles();

const config = loadWorkerConfig();
const redisClient = config.cacheBackend === "redis" ? createClient({ url: config.redisUrl }) : null;
const zendeskClient = ZendeskClient.fromEnv();
const teamsNotifier = createTeamsNotifier(config.teamsNotify, logger);
const supabaseRecorder = createSupabaseRecorder(logger);

let pollInFlight = false;
let previousSnapshot: ZendeskSnapshot | null = null;
let lastHeavyRefreshAtMs = 0;
let lastSnapshotFingerprint: string | null = null;
let consecutiveFailures = 0;
let lastErrorMessage: string | null = null;
let lastRateLimitRemaining: number | null = null;
let lastRateLimitLimit: number | null = null;
let lastRateLimitResetSeconds: number | null = null;
let lastRefreshRequestId: string | null = null;
let refreshMonitor: NodeJS.Timeout | null = null;
let lastPollStartedAtMs: number | null = null;
let lastPollFinishedAtMs: number | null = null;

function snapshotFingerprint(snapshot: ZendeskSnapshot): string {
  const normalized: ZendeskSnapshot = {
    ...snapshot,
    generated_at: "",
    core_generated_at: "",
    daily_summary: {
      ...snapshot.daily_summary,
      generated_at: ""
    }
  };
  return JSON.stringify(normalized);
}

async function persistWorkerStatus(lastSuccessfulPollAt: string | null): Promise<void> {
  const statusPath = path.resolve(path.dirname(config.snapshotFilePath), "worker-status.json");
  const nowMs = Date.now();
  const nextPollAtIso = new Date((lastPollStartedAtMs ?? nowMs) + config.pollIntervalSeconds * 1000).toISOString();
  const nextHeavyRefreshAtIso =
    lastHeavyRefreshAtMs > 0
      ? new Date(lastHeavyRefreshAtMs + config.heavyRefreshIntervalSeconds * 1000).toISOString()
      : null;
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(
    statusPath,
    JSON.stringify(
      {
        poll_interval_seconds: config.pollIntervalSeconds,
        heavy_refresh_interval_seconds: config.heavyRefreshIntervalSeconds,
        directory_cache_ttl_seconds: config.directoryCacheTtlSeconds,
        consecutive_failures: consecutiveFailures,
        last_error: lastErrorMessage,
        last_successful_poll_at: lastSuccessfulPollAt,
        last_poll_started_at: lastPollStartedAtMs ? new Date(lastPollStartedAtMs).toISOString() : null,
        last_poll_finished_at: lastPollFinishedAtMs ? new Date(lastPollFinishedAtMs).toISOString() : null,
        next_scheduled_poll_at: nextPollAtIso,
        next_scheduled_heavy_refresh_at: nextHeavyRefreshAtIso,
        rate_limit_remaining: lastRateLimitRemaining,
        rate_limit_limit: lastRateLimitLimit,
        rate_limit_reset_seconds: lastRateLimitResetSeconds
      },
      null,
      2
    ),
    "utf-8"
  );
}

async function tryAcquirePollLock(lockToken: string): Promise<boolean> {
  if (config.cacheBackend !== "redis" || !redisClient) {
    return true;
  }

  const lockTtlSeconds = Math.max(config.pollIntervalSeconds * 2, 120);
  const reply = await redisClient.set(config.lockKey, lockToken, {
    NX: true,
    EX: lockTtlSeconds
  });
  return reply === "OK";
}

async function releasePollLock(lockToken: string): Promise<void> {
  if (config.cacheBackend !== "redis" || !redisClient) {
    return;
  }
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;
  await redisClient.sendCommand(["EVAL", script, "1", config.lockKey, lockToken]);
}

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

async function loadExistingSnapshot(): Promise<ZendeskSnapshot | null> {
  try {
    if (config.cacheBackend === "redis" && redisClient) {
      const rawSnapshot = await redisClient.get(config.snapshotKey);
      if (!rawSnapshot) {
        return null;
      }
      const snapshot = JSON.parse(rawSnapshot) as ZendeskSnapshot;
      validateSnapshotOrThrow(snapshot);
      return snapshot;
    }

    const rawSnapshot = await fs.readFile(config.snapshotFilePath, "utf-8");
    const snapshot = JSON.parse(rawSnapshot) as ZendeskSnapshot;
    validateSnapshotOrThrow(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

async function readRefreshRequest(): Promise<{ requestId: string; requestedAtMs: number; forceHeavy: boolean } | null> {
  try {
    const raw = await fs.readFile(config.refreshRequestFilePath, "utf-8");
    const parsed = JSON.parse(raw) as { request_id?: unknown; requested_at?: unknown; force_heavy?: unknown };
    if (typeof parsed.request_id !== "string" || typeof parsed.requested_at !== "string") {
      return null;
    }
    const requestedAtMs = Date.parse(parsed.requested_at);
    if (Number.isNaN(requestedAtMs)) {
      return null;
    }
    return {
      requestId: parsed.request_id,
      requestedAtMs,
      forceHeavy: parsed.force_heavy !== false
    };
  } catch {
    return null;
  }
}

async function runPoll(options: { forceHeavy?: boolean; reason?: string } = {}): Promise<void> {
  if (pollInFlight) {
    logger.warn("Skipping poll because previous run is still in progress.");
    return;
  }

  pollInFlight = true;
  const startedAt = Date.now();
  lastPollStartedAtMs = startedAt;
  const lockToken = randomUUID();
  let lockAcquired = false;

  try {
    lockAcquired = await tryAcquirePollLock(lockToken);
    if (!lockAcquired) {
      logger.info(
        {
          cache_backend: config.cacheBackend,
          lock_key: config.lockKey
        },
        "Skipping poll because another worker holds the lock."
      );
      return;
    }

    const nowMs = Date.now();
    let includeHeavyData =
      options.forceHeavy === true ||
      !previousSnapshot ||
      nowMs - lastHeavyRefreshAtMs >= config.heavyRefreshIntervalSeconds * 1000;

    const rateSnapshotBeforePoll = zendeskClient.getRateLimitSnapshot();
    if (rateSnapshotBeforePoll.remaining !== null) {
      lastRateLimitRemaining = rateSnapshotBeforePoll.remaining;
      lastRateLimitLimit = rateSnapshotBeforePoll.limit;
      lastRateLimitResetSeconds = rateSnapshotBeforePoll.resetSeconds;
      if (rateSnapshotBeforePoll.remaining <= config.rateLimitCriticalWatermark && !options.forceHeavy) {
        logger.warn(
          {
            rate_limit_remaining: rateSnapshotBeforePoll.remaining,
            rate_limit_limit: rateSnapshotBeforePoll.limit,
            rate_limit_reset_seconds: rateSnapshotBeforePoll.resetSeconds
          },
          "Skipping poll due to critical Zendesk API rate-limit budget."
        );
        await persistWorkerStatus(previousSnapshot?.generated_at ?? null);
        return;
      }

      if (rateSnapshotBeforePoll.remaining <= config.rateLimitLowWatermark && includeHeavyData && previousSnapshot) {
        if (options.forceHeavy) {
          logger.warn(
            {
              rate_limit_remaining: rateSnapshotBeforePoll.remaining,
              rate_limit_limit: rateSnapshotBeforePoll.limit,
              rate_limit_reset_seconds: rateSnapshotBeforePoll.resetSeconds
            },
            "Running forced heavy poll even though Zendesk API rate-limit budget is low."
          );
        } else {
          includeHeavyData = false;
          logger.warn(
            {
              rate_limit_remaining: rateSnapshotBeforePoll.remaining,
              rate_limit_limit: rateSnapshotBeforePoll.limit,
              rate_limit_reset_seconds: rateSnapshotBeforePoll.resetSeconds
            },
            "Downgrading heavy poll to light poll due to low Zendesk API rate-limit budget."
          );
        }
      }
    }

    const snapshot = await buildZendeskSnapshot({
      client: zendeskClient,
      dashboardConfig: config.dashboardConfig,
      maxTicketScan: config.maxTicketScan,
      maxSolvedAuditTickets: config.maxSolvedAuditTickets,
      maxAgentScan: config.maxAgentScan,
      pollIntervalSeconds: config.pollIntervalSeconds,
      includeHeavyData,
      previousSnapshot,
      timeZone: config.dashboardTimezone,
      alertThresholds: config.alertThresholds,
      slaTargets: config.slaTargets,
      highPriorityStaleHours: config.highPriorityStaleHours,
      directoryCacheTtlSeconds: config.directoryCacheTtlSeconds,
      logger
    });

    validateSnapshotOrThrow(snapshot);
    const nextFingerprint = snapshotFingerprint(snapshot);
    const snapshotChanged = nextFingerprint !== lastSnapshotFingerprint;
    if (snapshotChanged) {
      await persistSnapshot(snapshot);
      previousSnapshot = snapshot;
      lastSnapshotFingerprint = nextFingerprint;
    }
    const rateSnapshot = zendeskClient.getRateLimitSnapshot();
    lastRateLimitRemaining = rateSnapshot.remaining;
    lastRateLimitLimit = rateSnapshot.limit;
    lastRateLimitResetSeconds = rateSnapshot.resetSeconds;
    consecutiveFailures = 0;
    lastErrorMessage = null;
    await persistWorkerStatus(snapshot.generated_at);
    if (includeHeavyData) {
      lastHeavyRefreshAtMs = nowMs;
    }
    try {
      await teamsNotifier.maybeNotify(snapshot);
    } catch (error) {
      logger.error({ err: error }, "Failed to post Teams notification");
    }
    if (supabaseRecorder.enabled) {
      try {
        await supabaseRecorder.recordSnapshot(snapshot);
        await supabaseRecorder.recordAlertEvents(snapshot);
        await supabaseRecorder.recordWorkerRun({
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          success: true,
          errorMessage: null,
          snapshotMode: includeHeavyData ? "heavy" : "light",
          pollReason: options.reason ?? "scheduled",
          rateLimitRemaining: lastRateLimitRemaining,
          rateLimitLimit: lastRateLimitLimit,
          rateLimitResetSeconds: lastRateLimitResetSeconds
        });
      } catch (error) {
        logger.warn({ err: error }, "Failed to write worker/snapshot records to Supabase.");
      }
    }

    logger.info(
      {
        duration_ms: Date.now() - startedAt,
        cache_backend: config.cacheBackend,
        key: config.cacheBackend === "redis" ? config.snapshotKey : config.snapshotFilePath,
        snapshot_mode: includeHeavyData ? "heavy" : "light",
        snapshot_changed: snapshotChanged,
        poll_reason: options.reason ?? "scheduled",
        heavy_refresh_interval_seconds: config.heavyRefreshIntervalSeconds,
        rate_limit_remaining: lastRateLimitRemaining,
        rate_limit_limit: lastRateLimitLimit,
        rate_limit_reset_seconds: lastRateLimitResetSeconds,
        generated_at: snapshot.generated_at,
        unsolved_count: snapshot.unsolved_count,
        active_alert_count: snapshot.alerts.active_count
      },
      "Snapshot updated"
    );
  } catch (error) {
    const rateSnapshot = zendeskClient.getRateLimitSnapshot();
    lastRateLimitRemaining = rateSnapshot.remaining;
    lastRateLimitLimit = rateSnapshot.limit;
    lastRateLimitResetSeconds = rateSnapshot.resetSeconds;
    consecutiveFailures += 1;
    lastErrorMessage = error instanceof Error ? error.message : String(error);
    await persistWorkerStatus(previousSnapshot?.generated_at ?? null);
    if (supabaseRecorder.enabled) {
      try {
        await supabaseRecorder.recordWorkerRun({
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: error instanceof Error ? error.message : String(error),
          snapshotMode: null,
          pollReason: options.reason ?? "scheduled",
          rateLimitRemaining: lastRateLimitRemaining,
          rateLimitLimit: lastRateLimitLimit,
          rateLimitResetSeconds: lastRateLimitResetSeconds
        });
      } catch (supabaseError) {
        logger.warn({ err: supabaseError }, "Failed to write failed worker run to Supabase.");
      }
    }
    logger.error(
      {
        err: error,
        duration_ms: Date.now() - startedAt
      },
      "Failed to update snapshot"
    );
  } finally {
    if (lockAcquired) {
      try {
        await releasePollLock(lockToken);
      } catch (lockReleaseError) {
        logger.warn({ err: lockReleaseError }, "Failed to release worker poll lock cleanly.");
      }
    }
    pollInFlight = false;
    lastPollFinishedAtMs = Date.now();
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

  previousSnapshot = await loadExistingSnapshot();
  if (previousSnapshot) {
    const existingGeneratedAtMs = Date.parse(previousSnapshot.generated_at);
    if (!Number.isNaN(existingGeneratedAtMs)) {
      lastHeavyRefreshAtMs = existingGeneratedAtMs;
    }
    lastSnapshotFingerprint = snapshotFingerprint(previousSnapshot);
  }
  await persistWorkerStatus(previousSnapshot?.generated_at ?? null);

  logger.info(
    {
      cache_backend: config.cacheBackend,
      redis_url: config.cacheBackend === "redis" ? config.redisUrl : undefined,
      snapshot_key: config.cacheBackend === "redis" ? config.snapshotKey : undefined,
      lock_key: config.cacheBackend === "redis" ? config.lockKey : undefined,
      refresh_request_file_path: config.refreshRequestFilePath,
      snapshot_file_path: config.cacheBackend === "file" ? config.snapshotFilePath : undefined,
      poll_interval_seconds: config.pollIntervalSeconds,
      heavy_refresh_interval_seconds: config.heavyRefreshIntervalSeconds,
      rate_limit_low_watermark: config.rateLimitLowWatermark,
      rate_limit_critical_watermark: config.rateLimitCriticalWatermark,
      dashboard_timezone: config.dashboardTimezone,
      alert_thresholds: config.alertThresholds,
      sla_targets: config.slaTargets,
      high_priority_stale_hours: config.highPriorityStaleHours,
      directory_cache_ttl_seconds: config.directoryCacheTtlSeconds,
      teams_notifications_enabled: config.teamsNotify.enabled,
      teams_notify_interval_seconds: config.teamsNotify.notifyIntervalSeconds,
      teams_notify_on_alert_change_only: config.teamsNotify.notifyOnAlertChangeOnly,
      teams_notify_max_silence_seconds: config.teamsNotify.notifyMaxSilenceSeconds,
      screenshot_capture_enabled: Boolean(config.teamsNotify.screenshotCaptureUrl),
      supabase_history_enabled: supabaseRecorder.enabled,
      max_ticket_scan: config.maxTicketScan,
      max_solved_audit_tickets: config.maxSolvedAuditTickets,
      max_agent_scan: config.maxAgentScan,
      configured_tag_count: config.dashboardConfig.tags.length
    },
    "Worker connected and starting"
  );

  await runPoll();
  setInterval(runPoll, config.pollIntervalSeconds * 1000);
  refreshMonitor = setInterval(() => {
    void (async () => {
      const refreshRequest = await readRefreshRequest();
      if (!refreshRequest) {
        return;
      }
      if (refreshRequest.requestId === lastRefreshRequestId) {
        return;
      }
      lastRefreshRequestId = refreshRequest.requestId;
      logger.info(
        {
          request_id: refreshRequest.requestId,
          force_heavy: refreshRequest.forceHeavy,
          requested_at_ms: refreshRequest.requestedAtMs
        },
        "Received manual refresh request."
      );
      await runPoll({
        forceHeavy: refreshRequest.forceHeavy,
        reason: "manual_refresh"
      });
    })().catch((error) => {
      logger.warn({ err: error }, "Failed to process refresh request.");
    });
  }, 5000);
}

async function shutdown(): Promise<void> {
  logger.info("Worker shutting down");
  if (refreshMonitor) {
    clearInterval(refreshMonitor);
    refreshMonitor = null;
  }
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
