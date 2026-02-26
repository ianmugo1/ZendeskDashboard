import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import type { Logger } from "pino";

interface WorkerRunRecord {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
  snapshotMode: "light" | "heavy" | null;
  pollReason: string;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  rateLimitResetSeconds: number | null;
}

interface SupabaseRecorder {
  readonly enabled: boolean;
  recordSnapshot(snapshot: ZendeskSnapshot): Promise<void>;
  recordAlertEvents(snapshot: ZendeskSnapshot): Promise<void>;
  recordWorkerRun(run: WorkerRunRecord): Promise<void>;
}

interface SupabaseConfig {
  enabled: boolean;
  url: string | null;
  serviceRoleKey: string | null;
  snapshotsTable: string;
  workerRunsTable: string;
  alertEventsTable: string;
}

interface RestSupabaseConfig {
  url: string;
  serviceRoleKey: string;
  snapshotsTable: string;
  workerRunsTable: string;
  alertEventsTable: string;
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

function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = env.SUPABASE_URL?.trim() || null;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  const enabledByDefault = Boolean(url && serviceRoleKey);
  return {
    enabled: parseBoolean(env.SUPABASE_ENABLED, enabledByDefault),
    url,
    serviceRoleKey,
    snapshotsTable: env.SUPABASE_TABLE_SNAPSHOTS?.trim() || "snapshots",
    workerRunsTable: env.SUPABASE_TABLE_WORKER_RUNS?.trim() || "worker_runs",
    alertEventsTable: env.SUPABASE_TABLE_ALERT_EVENTS?.trim() || "alert_events"
  };
}

class NoopSupabaseRecorder implements SupabaseRecorder {
  readonly enabled = false;

  async recordSnapshot(_snapshot: ZendeskSnapshot): Promise<void> {
    return;
  }

  async recordAlertEvents(_snapshot: ZendeskSnapshot): Promise<void> {
    return;
  }

  async recordWorkerRun(_run: WorkerRunRecord): Promise<void> {
    return;
  }
}

class RestSupabaseRecorder implements SupabaseRecorder {
  readonly enabled = true;

  constructor(private readonly config: RestSupabaseConfig, private readonly logger: Logger) {}

  private async insertRows(table: string, rows: unknown[]): Promise<void> {
    const response = await fetch(`${this.config.url}/rest/v1/${encodeURIComponent(table)}`, {
      method: "POST",
      headers: {
        apikey: this.config.serviceRoleKey,
        Authorization: `Bearer ${this.config.serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    });

    if (response.ok) {
      return;
    }

    const body = await response.text().catch(() => "");
    throw new Error(`Supabase insert failed for table '${table}' with status ${response.status}. ${body}`);
  }

  async recordSnapshot(snapshot: ZendeskSnapshot): Promise<void> {
    await this.insertRows(this.config.snapshotsTable, [
      {
        generated_at: snapshot.generated_at,
        snapshot_mode: snapshot.snapshot_mode ?? null,
        core_generated_at: snapshot.core_generated_at ?? null,
        heavy_generated_at: snapshot.heavy_generated_at ?? null,
        unsolved_count: snapshot.unsolved_count,
        attention_count: snapshot.attention_tickets.length,
        active_alert_count: snapshot.alerts.active_count,
        payload_json: snapshot
      }
    ]);
  }

  async recordAlertEvents(snapshot: ZendeskSnapshot): Promise<void> {
    const metrics = [
      { metric: "unsolved", data: snapshot.alerts.unsolved },
      { metric: "attention", data: snapshot.alerts.attention },
      { metric: "unassigned", data: snapshot.alerts.unassigned }
    ];
    const rows = metrics.map((entry) => ({
      generated_at: snapshot.generated_at,
      snapshot_mode: snapshot.snapshot_mode ?? null,
      metric: entry.metric,
      label: entry.data.label,
      current_value: entry.data.value,
      threshold: entry.data.threshold,
      active: entry.data.active
    }));
    await this.insertRows(this.config.alertEventsTable, rows);
  }

  async recordWorkerRun(run: WorkerRunRecord): Promise<void> {
    await this.insertRows(this.config.workerRunsTable, [
      {
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        duration_ms: run.durationMs,
        success: run.success,
        error_message: run.errorMessage,
        snapshot_mode: run.snapshotMode,
        poll_reason: run.pollReason,
        rate_limit_remaining: run.rateLimitRemaining,
        rate_limit_limit: run.rateLimitLimit,
        rate_limit_reset_seconds: run.rateLimitResetSeconds
      }
    ]);
  }
}

export function createSupabaseRecorder(logger: Logger, env: NodeJS.ProcessEnv = process.env): SupabaseRecorder {
  const config = loadSupabaseConfig(env);
  logger.info(
    {
      supabase_enabled_requested: config.enabled,
      has_supabase_url: Boolean(config.url),
      has_supabase_service_role_key: Boolean(config.serviceRoleKey),
      snapshots_table: config.snapshotsTable,
      worker_runs_table: config.workerRunsTable,
      alert_events_table: config.alertEventsTable
    },
    "Supabase recorder configuration"
  );

  if (!config.enabled) {
    return new NoopSupabaseRecorder();
  }

  if (!config.url || !config.serviceRoleKey) {
    logger.warn("SUPABASE_ENABLED=true but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Supabase writes disabled.");
    return new NoopSupabaseRecorder();
  }

  logger.info(
    {
      supabase_url: config.url,
      snapshots_table: config.snapshotsTable,
      worker_runs_table: config.workerRunsTable,
      alert_events_table: config.alertEventsTable
    },
    "Supabase recorder enabled"
  );

  return new RestSupabaseRecorder(
    {
      url: config.url,
      serviceRoleKey: config.serviceRoleKey,
      snapshotsTable: config.snapshotsTable,
      workerRunsTable: config.workerRunsTable,
      alertEventsTable: config.alertEventsTable
    },
    logger
  );
}

export type { WorkerRunRecord, SupabaseRecorder };
