"use client";

import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import Image from "next/image";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface DashboardProps {
  initialSnapshot: ZendeskSnapshot | null;
  refreshSeconds: number;
  staleWarningSeconds: number;
  showOperations?: boolean;
  widgetToggles: {
    topSolvers: boolean;
    ticketsByTag: boolean;
    unassigned: boolean;
    attention: boolean;
    dailyVolume: boolean;
  };
}

interface WorkerStatus {
  poll_interval_seconds: number;
  heavy_refresh_interval_seconds: number;
  consecutive_failures: number;
  last_error: string | null;
  last_successful_poll_at: string | null;
  last_poll_started_at?: string | null;
  last_poll_finished_at?: string | null;
  next_scheduled_poll_at?: string | null;
  next_scheduled_heavy_refresh_at?: string | null;
  rate_limit_remaining: number | null;
  rate_limit_limit: number | null;
  rate_limit_reset_seconds: number | null;
}

interface HistoryDailyItem {
  generated_at: string;
  unsolved_count: number;
  attention_count: number;
  active_alert_count: number;
  snapshot_mode: string;
}

interface HistoryWorkerRunItem {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  success: boolean;
  error_message: string | null;
  snapshot_mode: string;
  poll_reason: string;
  rate_limit_remaining: number | null;
}

interface MetricDefinition {
  name: string;
  meaning: string;
}

const zendeskBaseUrl = process.env.NEXT_PUBLIC_ZENDESK_BASE_URL ?? "https://emeraldpark.zendesk.com";
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const metricDefinitions: MetricDefinition[] = [
  { name: "Unsolved", meaning: "Current count of tickets that are not solved or closed." },
  { name: "SLA (7d)", meaning: "Percentage of recently evaluated tickets resolved within configured SLA targets." },
  { name: "Created Today", meaning: "Number of new tickets created since local midnight in dashboard timezone." },
  { name: "Solved (7d)", meaning: "Total tickets solved during the last 7 days." },
  { name: "Backlog >7d", meaning: "Open tickets older than 7 days." },
  { name: "Unassigned >2h", meaning: "Tickets without assignee for more than 2 hours." },
  { name: "Group Workload", meaning: "Open, solved, and high-priority distribution by Zendesk group." },
  { name: "Agent Performance", meaning: "Solved volume and SLA performance by agent over the 7-day window." },
  { name: "Trend", meaning: "Daily intake vs solved trend with configurable window (7/14/30 days)." },
  { name: "Unassigned Tickets", meaning: "Oldest unassigned queue items requiring assignment." },
  { name: "Attention Tickets", meaning: "High-urgency tickets likely needing immediate action." },
  { name: "High Priority Risk", meaning: "High/urgent tickets with stale updates above risk threshold." },
  { name: "Top Solvers (7d)", meaning: "Agents with highest solved counts in the last 7 days." },
  { name: "Tickets By Tag", meaning: "Open ticket counts for configured operational tags." },
  { name: "Core Freshness", meaning: "Age of fast-refresh metrics (counts, queues, alerts)." },
  { name: "Heavy Freshness", meaning: "Age of expensive analytics sections refreshed on slower cadence." }
];
const metricMeaningByName = new Map(metricDefinitions.map((metric) => [metric.name, metric.meaning]));

function formatCount(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-IE").format(value) : "0";
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "0%";
}

function formatHours(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}h` : "0h";
}

function formatRefreshInterval(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} min`;
  }
  return `${seconds}s`;
}

function formatAgeMinutes(timestamp: string | undefined): string {
  if (!timestamp) {
    return "n/a";
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return "n/a";
  }
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return `${minutes} min ago`;
}

function formatAgeShort(timestamp: string | undefined): string {
  if (!timestamp) {
    return "n/a";
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return "n/a";
  }
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatRelativeFuture(timestamp: string | null | undefined): string {
  if (!timestamp) {
    return "n/a";
  }
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) {
    return "n/a";
  }
  const deltaMinutes = Math.round((ms - Date.now()) / 60000);
  if (deltaMinutes <= 0) {
    return "due now";
  }
  if (deltaMinutes < 60) {
    return `in ${deltaMinutes} min`;
  }
  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
}

function formatAbsoluteDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  const day = date.getUTCDate();
  const month = shortMonths[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year} at ${hour}:${minute} UTC`;
}

function formatUkDateFromYmd(dateString: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) {
    return dateString;
  }
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function formatClockTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes} UTC`;
}

function getTicketUrl(ticketId: number): string {
  return `${zendeskBaseUrl}/agent/tickets/${ticketId}`;
}

function SummaryTile({
  label,
  value,
  hint,
  tone = "text-slate-100"
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}): ReactElement {
  return (
    <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className={`mono-numbers mt-2 text-[clamp(1.7rem,3.4vw,2.6rem)] font-semibold ${tone}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </article>
  );
}

export function Dashboard({ initialSnapshot, refreshSeconds, staleWarningSeconds, showOperations = false, widgetToggles }: DashboardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ZendeskSnapshot | null>(initialSnapshot);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [historyDaily, setHistoryDaily] = useState<HistoryDailyItem[]>([]);
  const [historyRuns, setHistoryRuns] = useState<HistoryWorkerRunItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState<string | null>(null);
  const [trendWindowDays, setTrendWindowDays] = useState<7 | 14 | 30>(7);
  const [hoveredTrendDate, setHoveredTrendDate] = useState<string | null>(null);
  const [hoveredNetFlowDate, setHoveredNetFlowDate] = useState<string | null>(null);
  const effectiveRefreshSeconds = Math.max(5, snapshot?.poll_interval_seconds ?? refreshSeconds);
  const visibleTrendPoints = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    return snapshot.trends_30d.points.slice(-trendWindowDays);
  }, [snapshot, trendWindowDays]);
  const trendChart = useMemo(() => {
    const chartWidth = 980;
    const chartHeight = 260;
    const left = 36;
    const right = 24;
    const top = 16;
    const bottom = 32;
    const usableWidth = chartWidth - left - right;
    const usableHeight = chartHeight - top - bottom;
    const maxValue = Math.max(1, ...visibleTrendPoints.flatMap((point) => [point.intake_count, point.solved_count]));
    const points = visibleTrendPoints.map((point, index) => {
      const ratioX = visibleTrendPoints.length <= 1 ? 0.5 : index / (visibleTrendPoints.length - 1);
      const intakeRatioY = point.intake_count / maxValue;
      const solvedRatioY = point.solved_count / maxValue;
      return {
        ...point,
        x: left + ratioX * usableWidth,
        intakeY: top + (1 - intakeRatioY) * usableHeight,
        solvedY: top + (1 - solvedRatioY) * usableHeight
      };
    });
    const toPath = (selector: "intakeY" | "solvedY"): string =>
      points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point[selector].toFixed(2)}`).join(" ");

    return {
      chartWidth,
      chartHeight,
      left,
      right,
      top,
      bottom,
      maxValue,
      points,
      intakePath: toPath("intakeY"),
      solvedPath: toPath("solvedY")
    };
  }, [visibleTrendPoints]);
  const activeTrendPoint = useMemo(() => {
    if (trendChart.points.length === 0) {
      return null;
    }
    if (hoveredTrendDate) {
      const matched = trendChart.points.find((point) => point.date === hoveredTrendDate);
      if (matched) {
        return matched;
      }
    }
    return trendChart.points[trendChart.points.length - 1];
  }, [hoveredTrendDate, trendChart.points]);
  const netFlowChart = useMemo(() => {
    const chartWidth = 980;
    const chartHeight = 220;
    const left = 28;
    const right = 18;
    const top = 14;
    const bottom = 28;
    const usableWidth = chartWidth - left - right;
    const usableHeight = chartHeight - top - bottom;
    const points = visibleTrendPoints.map((point, index) => {
      const delta = point.intake_count - point.solved_count;
      const ratioX = visibleTrendPoints.length <= 1 ? 0.5 : index / (visibleTrendPoints.length - 1);
      return {
        ...point,
        delta,
        x: left + ratioX * usableWidth
      };
    });
    const maxAbs = Math.max(1, ...points.map((point) => Math.abs(point.delta)));
    const zeroY = top + usableHeight / 2;
    return { chartWidth, chartHeight, left, right, top, bottom, usableWidth, usableHeight, points, maxAbs, zeroY };
  }, [visibleTrendPoints]);
  const activeNetFlowPoint = useMemo(() => {
    if (netFlowChart.points.length === 0) {
      return null;
    }
    if (hoveredNetFlowDate) {
      const matched = netFlowChart.points.find((point) => point.date === hoveredNetFlowDate);
      if (matched) {
        return matched;
      }
    }
    return netFlowChart.points[netFlowChart.points.length - 1];
  }, [hoveredNetFlowDate, netFlowChart.points]);
  const backlogBuckets = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    const buckets = [
      { label: "<24h", value: snapshot.backlog_aging.under_24h, className: "backlog-segment-fresh" },
      { label: "1-3d", value: snapshot.backlog_aging.from_1d_to_3d, className: "backlog-segment-mid" },
      { label: "3-7d", value: snapshot.backlog_aging.from_3d_to_7d, className: "backlog-segment-aged" },
      { label: "7d+", value: snapshot.backlog_aging.over_7d, className: "backlog-segment-old" }
    ];
    const total = Math.max(1, buckets.reduce((sum, bucket) => sum + bucket.value, 0));
    return buckets.map((bucket) => ({
      ...bucket,
      pct: (bucket.value / total) * 100
    }));
  }, [snapshot]);
  const actionSummary = useMemo(() => {
    if (!snapshot) {
      return {
        backlogGrowingDays: 0,
        topGroupName: "n/a",
        topGroupOpenCount: 0,
        highRiskCount: 0,
        oldestUnassignedId: null as number | null
      };
    }
    const backlogGrowingDays = visibleTrendPoints.filter((point) => point.intake_count > point.solved_count).length;
    const topGroup = snapshot.group_workload
      .slice()
      .sort((left, right) => right.open_count - left.open_count)[0];
    return {
      backlogGrowingDays,
      topGroupName: topGroup?.group_name ?? "n/a",
      topGroupOpenCount: topGroup?.open_count ?? 0,
      highRiskCount: snapshot.high_priority_risk_tickets.length,
      oldestUnassignedId: snapshot.assignment_lag.oldest_unassigned[0]?.id ?? null
    };
  }, [snapshot, visibleTrendPoints]);

  const fetchSnapshot = useCallback(async (): Promise<ZendeskSnapshot | null> => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Snapshot request failed with ${response.status}`);
      }
      const payload = (await response.json()) as ZendeskSnapshot;
      setSnapshot(payload);
      setFetchError(null);
      return payload;
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Snapshot request failed.");
      return null;
    } finally {
      setRefreshing(false);
    }
  }, []);

  const fetchWorkerStatus = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/worker-status", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as WorkerStatus;
      setWorkerStatus(payload);
    } catch {
      // Ignore worker-status fetch errors and keep previous state.
    }
  }, []);

  const fetchHistory = useCallback(async (): Promise<void> => {
    try {
      const [dailyResponse, runsResponse] = await Promise.all([
        fetch("/api/history/daily?limit=30", { cache: "no-store" }),
        fetch("/api/history/worker-runs?limit=30", { cache: "no-store" })
      ]);
      if (dailyResponse.ok) {
        const payload = (await dailyResponse.json()) as { items?: HistoryDailyItem[] };
        setHistoryDaily(Array.isArray(payload.items) ? payload.items : []);
      }
      if (runsResponse.ok) {
        const payload = (await runsResponse.json()) as { items?: HistoryWorkerRunItem[] };
        setHistoryRuns(Array.isArray(payload.items) ? payload.items : []);
      }
    } catch {
      // history is optional; keep existing UI if unavailable.
    }
  }, []);

  const forceRefreshAllMetrics = useCallback(async () => {
    if (forceRefreshing) {
      return;
    }

    setForceRefreshing(true);
    setForceRefreshMessage("Requesting full refresh...");
    const previousHeavyGeneratedAt = snapshot?.heavy_generated_at ?? snapshot?.generated_at ?? null;

    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        cache: "no-store"
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Refresh request failed with ${response.status}`);
      }

      let updated = false;
      for (let attempt = 0; attempt < 18; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const nextSnapshot = await fetchSnapshot();
        if (!nextSnapshot) {
          continue;
        }
        const latestHeavyGeneratedAt = nextSnapshot.heavy_generated_at ?? nextSnapshot.generated_at;
        if (!previousHeavyGeneratedAt || Date.parse(latestHeavyGeneratedAt) > Date.parse(previousHeavyGeneratedAt)) {
          updated = true;
          break;
        }
      }

      if (updated) {
        setForceRefreshMessage("Full metrics refresh completed.");
      } else {
        setForceRefreshMessage("Refresh requested. Heavy metrics may still be processing.");
      }
    } catch (error) {
      setForceRefreshMessage(error instanceof Error ? error.message : "Failed to request refresh.");
    } finally {
      setForceRefreshing(false);
    }
  }, [fetchSnapshot, forceRefreshing, snapshot?.generated_at, snapshot?.heavy_generated_at]);

  useEffect(() => {
    if (!initialSnapshot) {
      void fetchSnapshot();
    }
    if (showOperations) {
      void fetchWorkerStatus();
      void fetchHistory();
    }
    const interval = setInterval(() => {
      void fetchSnapshot();
      if (showOperations) {
        void fetchWorkerStatus();
        void fetchHistory();
      }
    }, effectiveRefreshSeconds * 1000);
    return () => clearInterval(interval);
  }, [effectiveRefreshSeconds, fetchHistory, fetchSnapshot, fetchWorkerStatus, initialSnapshot, showOperations]);
  useEffect(() => {
    if (visibleTrendPoints.length === 0) {
      setHoveredTrendDate(null);
      return;
    }
    setHoveredTrendDate((previous) => {
      if (previous && visibleTrendPoints.some((point) => point.date === previous)) {
        return previous;
      }
      return visibleTrendPoints[visibleTrendPoints.length - 1].date;
    });
  }, [visibleTrendPoints]);
  useEffect(() => {
    if (netFlowChart.points.length === 0) {
      setHoveredNetFlowDate(null);
      return;
    }
    setHoveredNetFlowDate((previous) => {
      if (previous && netFlowChart.points.some((point) => point.date === previous)) {
        return previous;
      }
      return netFlowChart.points[netFlowChart.points.length - 1].date;
    });
  }, [netFlowChart.points]);

  const stale = useMemo(() => {
    if (!snapshot) {
      return true;
    }
    const generatedAtMs = Date.parse(snapshot.generated_at);
    if (Number.isNaN(generatedAtMs)) {
      return true;
    }
    return Date.now() - generatedAtMs > staleWarningSeconds * 1000;
  }, [snapshot, staleWarningSeconds]);
  const historyChart = useMemo(() => {
    const points = historyDaily;
    const chartWidth = 980;
    const chartHeight = 180;
    const left = 20;
    const right = 16;
    const top = 12;
    const bottom = 24;
    const usableWidth = chartWidth - left - right;
    const usableHeight = chartHeight - top - bottom;
    const maxValue = Math.max(1, ...points.map((point) => point.unsolved_count));
    const mapped = points.map((point, index) => {
      const ratioX = points.length <= 1 ? 0.5 : index / (points.length - 1);
      const ratioY = point.unsolved_count / maxValue;
      return {
        ...point,
        x: left + ratioX * usableWidth,
        y: top + (1 - ratioY) * usableHeight
      };
    });
    const path = mapped.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
    return { chartWidth, chartHeight, left, right, top, bottom, maxValue, points: mapped, path };
  }, [historyDaily]);
  const workerRunSummary = useMemo(() => {
    if (historyRuns.length === 0) {
      return { successRatePct: 0, avgDurationMs: 0 };
    }
    const successCount = historyRuns.filter((run) => run.success).length;
    const successRatePct = Number(((successCount / historyRuns.length) * 100).toFixed(1));
    const avgDurationMs = Math.round(historyRuns.reduce((sum, run) => sum + run.duration_ms, 0) / historyRuns.length);
    return { successRatePct, avgDurationMs };
  }, [historyRuns]);

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <section className="metric-surface w-full max-w-2xl p-8 text-center">
          <Image
            src="/emerald-park-logo.png"
            alt="Emerald Park"
            width={132}
            height={132}
            priority
            className="mx-auto h-24 w-24 md:h-28 md:w-28"
          />
          <h1 className="mt-4 text-2xl font-semibold">Emerald Park IT Ticket Dashboard</h1>
          <p className="mt-4 text-slate-300">Waiting for the first snapshot from the metrics API.</p>
          {fetchError ? <p className="mt-3 text-rose-300">{fetchError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell min-h-[100dvh] px-[clamp(0.75rem,1.4vw,2rem)] py-[clamp(0.75rem,1.4vw,1.75rem)]">
      <div className="mx-auto flex w-full max-w-none flex-col gap-4">
        <header className="metric-surface flex flex-col gap-3 p-4 md:flex-row md:items-end md:justify-between">
          <div className="flex items-center gap-4">
            <Image
              src="/emerald-park-logo.png"
              alt="Emerald Park"
              width={112}
              height={112}
              priority
              className="h-14 w-14 shrink-0 md:h-16 md:w-16"
            />
            <div>
            <p className="text-xs uppercase tracking-[0.35em] text-sky-200/75">Emerald Park IT</p>
            <h1 className="mt-2 text-[clamp(1.4rem,2.4vw,2.2rem)] font-semibold leading-tight">
              {showOperations ? "Operations Console" : "Emerald Park IT Ticket Dashboard"}
            </h1>
            </div>
          </div>
          <div className="text-sm md:text-right">
            <div className="flex flex-wrap gap-2 text-xs md:justify-end">
              <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200" title={formatAbsoluteDate(snapshot.generated_at)}>
                Updated <span className="mono-numbers text-slate-100">{formatAgeShort(snapshot.generated_at)}</span>
              </span>
              <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200">
                Core <span className="mono-numbers text-slate-100">{formatAgeShort(snapshot.core_generated_at)}</span>
              </span>
              <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200">
                Heavy <span className="mono-numbers text-slate-100">{formatAgeShort(snapshot.heavy_generated_at)}</span>
              </span>
              <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200">
                Auto <span className="mono-numbers text-slate-100">{formatRefreshInterval(effectiveRefreshSeconds)}</span>
              </span>
              {showOperations ? (
                <>
                  <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200">
                    Next <span className="mono-numbers text-slate-100">{formatRelativeFuture(workerStatus?.next_scheduled_poll_at)}</span>
                  </span>
                  <span className="rounded-full border border-slate-500/30 bg-slate-900/35 px-2.5 py-1 text-slate-200">
                    Heavy Next <span className="mono-numbers text-slate-100">{formatRelativeFuture(workerStatus?.next_scheduled_heavy_refresh_at)}</span>
                  </span>
                </>
              ) : null}
            </div>
            <p className={`mt-1 ${stale ? "text-rose-300" : "text-emerald-300"}`}>
              {refreshing ? "Refreshing now" : "Data feed healthy"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
              {showOperations ? (
                <>
                  <a href="/" className="nav-link">Main Dashboard</a>
                  <a href="/api/export/daily-summary?meta=1" className="nav-link">Export Summary</a>
                  <button type="button" className="nav-link" onClick={() => void forceRefreshAllMetrics()} disabled={forceRefreshing}>
                    {forceRefreshing ? "Refreshing..." : "Force Refresh Metrics"}
                  </button>
                </>
              ) : (
                <>
                  <a href="/audit" className="nav-link">Agent Audit Page</a>
                  <a href="/ops" className="nav-link">Operations Console</a>
                </>
              )}
            </div>
            {showOperations && forceRefreshMessage ? <p className="mt-1 text-sky-200">{forceRefreshMessage}</p> : null}
            {fetchError ? <p className="mt-1 text-rose-300">{fetchError}</p> : null}
          </div>
        </header>

        {stale ? (
          <section className="metric-surface alert-strip px-4 py-3 text-sm text-rose-100">
            Snapshot is stale ({formatAgeMinutes(snapshot.generated_at)}). Worker may be delayed or Zendesk rate-limited.
          </section>
        ) : null}

        {!showOperations ? (
          <section className="grid grid-cols-12 gap-4">
            <SummaryTile label="Unsolved" value={formatCount(snapshot.unsolved_count)} tone="text-[var(--kpi-highlight)]" />
            <SummaryTile label="SLA (7d)" value={formatPercent(snapshot.sla_health_7d.combined_within_target_pct)} tone="text-emerald-300" />
            <SummaryTile label="Created Today" value={formatCount(snapshot.daily_summary.created_today)} />
            <SummaryTile label="Solved (7d)" value={formatCount(snapshot.daily_summary.solved_count_7d)} />
            <SummaryTile label="Backlog >7d" value={formatCount(snapshot.backlog_aging.over_7d)} tone="text-amber-200" />
            <SummaryTile label="Unassigned >2h" value={formatCount(snapshot.assignment_lag.over_2h)} tone="text-amber-200" />
          </section>
        ) : null}

        {showOperations ? (
          <section className="grid grid-cols-12 gap-4">
            <article className="metric-surface col-span-12 p-4">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Operations Health</h2>
              <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-200 md:grid-cols-4">
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Consecutive Failures</p>
                  <p className="mono-numbers text-base">{formatCount(workerStatus?.consecutive_failures ?? 0)}</p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Rate Limit Remaining</p>
                  <p className="mono-numbers text-base">
                    {workerStatus?.rate_limit_remaining ?? "n/a"} / {workerStatus?.rate_limit_limit ?? "n/a"}
                  </p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Rate Reset</p>
                  <p className="mono-numbers text-base">
                    {workerStatus?.rate_limit_reset_seconds !== null && workerStatus?.rate_limit_reset_seconds !== undefined
                      ? `${workerStatus.rate_limit_reset_seconds}s`
                      : "n/a"}
                  </p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Last Error</p>
                  <p className="truncate text-sm text-slate-200">{workerStatus?.last_error ?? "None"}</p>
                </div>
              </div>
            </article>
          </section>
        ) : null}

        {showOperations ? (
          <section className="grid grid-cols-12 gap-4">
            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-7">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">History (Supabase, Last 30 Runs)</h2>
              </div>
              <div className="p-3">
                {historyChart.points.length > 0 ? (
                  <>
                    <svg viewBox={`0 0 ${historyChart.chartWidth} ${historyChart.chartHeight}`} className="trend-chart-svg" role="img" aria-label="Unsolved history trend">
                      {[0, 1, 2, 3].map((line) => {
                        const y = historyChart.top + ((historyChart.chartHeight - historyChart.top - historyChart.bottom) * line) / 3;
                        return <line key={`history-grid-${line}`} x1={historyChart.left} y1={y} x2={historyChart.chartWidth - historyChart.right} y2={y} className="trend-grid-line" />;
                      })}
                      {historyChart.path ? <path d={historyChart.path} className="trend-line-solved" /> : null}
                      {historyChart.points.map((point) => (
                        <circle key={`history-point-${point.generated_at}`} cx={point.x} cy={point.y} r={2.6} className="trend-point-solved" />
                      ))}
                    </svg>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                      <span>Peak unsolved: {formatCount(historyChart.maxValue)}</span>
                      <span>Latest: {formatCount(historyChart.points[historyChart.points.length - 1]?.unsolved_count ?? 0)}</span>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-slate-300">Supabase history not available yet.</p>
                )}
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-5">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Worker Reliability (Recent)</h2>
              </div>
              <div className="p-3">
                <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Success Rate</p>
                    <p className="mono-numbers text-base text-emerald-300">{formatPercent(workerRunSummary.successRatePct)}</p>
                  </div>
                  <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Avg Duration</p>
                    <p className="mono-numbers text-base text-slate-100">{Math.round(workerRunSummary.avgDurationMs / 1000)}s</p>
                  </div>
                </div>
                {historyRuns.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs">
                      <thead className="table-head text-left uppercase tracking-[0.12em] text-slate-400">
                        <tr>
                          <th className="px-2 py-1.5">Time</th>
                          <th className="px-2 py-1.5">Mode</th>
                          <th className="px-2 py-1.5 text-right">Dur</th>
                          <th className="px-2 py-1.5 text-right">RL</th>
                          <th className="px-2 py-1.5 text-right">OK</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyRuns.slice(-8).reverse().map((run) => (
                          <tr key={`${run.started_at}-${run.duration_ms}`} className="table-row border-t border-slate-500/15">
                            <td className="px-2 py-1.5">{formatClockTime(run.started_at)}</td>
                            <td className="px-2 py-1.5">{run.snapshot_mode}</td>
                            <td className="mono-numbers px-2 py-1.5 text-right">{Math.round(run.duration_ms / 1000)}s</td>
                            <td className="mono-numbers px-2 py-1.5 text-right">{run.rate_limit_remaining ?? "n/a"}</td>
                            <td className={`px-2 py-1.5 text-right ${run.success ? "text-emerald-300" : "text-rose-300"}`}>
                              {run.success ? "Yes" : "No"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-slate-300">Worker history not available yet.</p>
                )}
              </div>
            </article>
          </section>
        ) : null}

        {!showOperations ? (
          <>
            <details className="metric-surface p-4">
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Metric Guide</summary>
              <div className="mt-3 grid grid-cols-1 gap-2 text-sm text-slate-300 md:grid-cols-2">
                {metricDefinitions.map((metric) => (
                  <div key={metric.name} className="rounded-md border border-slate-500/20 bg-slate-900/30 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{metric.name}</p>
                    <p className="mt-1 text-slate-200">{metric.meaning}</p>
                  </div>
                ))}
              </div>
            </details>

            <details className="metric-surface p-4" open>
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Management Overview</summary>
              <div className="mt-4 grid grid-cols-12 gap-4">
            <article className="metric-surface col-span-12 overflow-hidden lg:col-span-4">
              <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Group Workload</h2></div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">Group</th><th className="px-3 py-2 text-right">Open</th><th className="px-3 py-2 text-right">Solved</th></tr></thead>
                  <tbody>{snapshot.group_workload.slice(0, 8).map((row) => <tr key={row.group_id} className="table-row border-t border-slate-500/15"><td className="px-3 py-2">{row.group_name}</td><td className="mono-numbers px-3 py-2 text-right">{formatCount(row.open_count)}</td><td className="mono-numbers px-3 py-2 text-right">{formatCount(row.solved_count_7d)}</td></tr>)}</tbody>
                </table>
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden lg:col-span-4">
              <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Agent Performance (Top 8)</h2></div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">Agent</th><th className="px-3 py-2 text-right">Solved</th><th className="px-3 py-2 text-right">SLA %</th></tr></thead>
                  <tbody>{snapshot.agent_performance_7d.slice(0, 8).map((row) => <tr key={row.agent_id} className="table-row border-t border-slate-500/15"><td className="px-3 py-2">{row.agent_name}</td><td className="mono-numbers px-3 py-2 text-right">{formatCount(row.solved_count_7d)}</td><td className="mono-numbers px-3 py-2 text-right">{formatPercent(row.resolution_within_target_pct)}</td></tr>)}</tbody>
                </table>
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden lg:col-span-4">
              <div className="flex items-center justify-between border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Trend ({trendWindowDays} Days)</h2>
                <select
                  className="audit-input h-8 min-w-[90px] text-xs"
                  value={trendWindowDays}
                  onChange={(event) => setTrendWindowDays(Number.parseInt(event.target.value, 10) as 7 | 14 | 30)}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                </select>
              </div>
              <div className="trend-chart-panel p-3">
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.12em] text-slate-400">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1">
                      <span className="trend-legend-dot trend-legend-intake" />
                      Intake
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="trend-legend-dot trend-legend-solved" />
                      Solved
                    </span>
                  </div>
                  <span>Peak {formatCount(trendChart.maxValue)}</span>
                </div>
                <div className="mt-3">
                  <svg viewBox={`0 0 ${trendChart.chartWidth} ${trendChart.chartHeight}`} className="trend-chart-svg" role="img" aria-label="Daily intake versus solved trend">
                    {[0, 1, 2, 3, 4].map((line) => {
                      const y = trendChart.top + ((trendChart.chartHeight - trendChart.top - trendChart.bottom) * line) / 4;
                      return <line key={`grid-${line}`} x1={trendChart.left} y1={y} x2={trendChart.chartWidth - trendChart.right} y2={y} className="trend-grid-line" />;
                    })}
                    {trendChart.intakePath ? <path d={trendChart.intakePath} className="trend-line-intake" /> : null}
                    {trendChart.solvedPath ? <path d={trendChart.solvedPath} className="trend-line-solved" /> : null}
                    {trendChart.points.map((point) => (
                      <g key={`point-${point.date}`}>
                        <circle cx={point.x} cy={point.intakeY} r={3.2} className="trend-point-intake" />
                        <circle cx={point.x} cy={point.solvedY} r={3.2} className="trend-point-solved" />
                        <circle
                          cx={point.x}
                          cy={(point.intakeY + point.solvedY) / 2}
                          r={15}
                          className="trend-hit-area"
                          onMouseEnter={() => setHoveredTrendDate(point.date)}
                          onFocus={() => setHoveredTrendDate(point.date)}
                          tabIndex={0}
                          aria-label={`Trend on ${formatUkDateFromYmd(point.date)}`}
                        />
                      </g>
                    ))}
                  </svg>
                </div>
                {activeTrendPoint ? (
                  <div className="trend-tooltip mt-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">{formatUkDateFromYmd(activeTrendPoint.date)}</p>
                    <p className="mono-numbers text-sm text-slate-100">
                      Intake: {formatCount(activeTrendPoint.intake_count)} | Solved: {formatCount(activeTrendPoint.solved_count)}
                    </p>
                  </div>
                ) : null}
              </div>
            </article>
              </div>
            </details>

            <details className="metric-surface p-4">
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Operational Queues</summary>
              <div className="mt-4 grid grid-cols-12 gap-4">
            {widgetToggles.unassigned ? (
              <article className="metric-surface col-span-12 overflow-hidden lg:col-span-6">
                <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Unassigned Tickets</h2></div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2 text-right">Age</th></tr></thead>
                    <tbody>{snapshot.unassigned_tickets.map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="mono-numbers px-3 py-2 text-right">{formatHours(ticket.age_hours)}</td></tr>)}</tbody>
                  </table>
                </div>
              </article>
            ) : null}

            {widgetToggles.attention ? (
              <article className="metric-surface col-span-12 overflow-hidden lg:col-span-6">
                <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Attention Tickets</h2></div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Priority</th></tr></thead>
                    <tbody>{snapshot.attention_tickets.map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="px-3 py-2">{ticket.priority}</td></tr>)}</tbody>
                  </table>
                </div>
              </article>
            ) : null}
              </div>
            </details>

            <details className="metric-surface p-4">
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Audit And Risk</summary>
              <div className="mt-4 grid grid-cols-12 gap-4">
            <article className="metric-surface col-span-12 overflow-hidden">
              <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">High Priority Risk</h2></div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2 text-right">Stale</th></tr></thead>
                  <tbody>{snapshot.high_priority_risk_tickets.map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="mono-numbers px-3 py-2 text-right">{formatHours(ticket.stale_hours)}</td></tr>)}</tbody>
                </table>
              </div>
            </article>
              </div>
            </details>

            {(widgetToggles.topSolvers || widgetToggles.ticketsByTag) ? (
              <details className="metric-surface p-4">
                <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Tags And Solvers</summary>
                <div className="mt-4 grid grid-cols-12 gap-4">
              {widgetToggles.topSolvers ? (
                <article className="metric-surface col-span-12 p-4 lg:col-span-6">
                  <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Top Solvers (7d)</h2>
                  <ul className="mt-3 space-y-2">
                    {snapshot.top_solvers.map((solver) => (
                      <li key={solver.agent_id} className="leaderboard-item flex items-center justify-between rounded-lg px-3 py-2">
                        <span className="truncate">{solver.agent_name}</span>
                        <span className="mono-numbers">{formatCount(solver.solved_count)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}
              {widgetToggles.ticketsByTag ? (
                <article className="metric-surface col-span-12 p-4 lg:col-span-6">
                  <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Tickets By Tag</h2>
                  <ul className="mt-3 space-y-2">
                    {snapshot.tickets_by_tag.map((item) => (
                      <li key={item.tag} className="leaderboard-item flex items-center justify-between rounded-lg px-3 py-2">
                        <span className="truncate">{item.tag}</span>
                        <span className="mono-numbers">{formatCount(item.count)}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ) : null}
                </div>
              </details>
            ) : null}

            <section className="grid grid-cols-12 gap-4">
          <article className="metric-surface col-span-12 overflow-hidden xl:col-span-4">
            <div className="border-b border-slate-400/20 px-4 py-3">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Are We Keeping Up? ({trendWindowDays}d)</h2>
            </div>
            <div className="p-3">
              <p className="mb-2 text-xs text-slate-400">Green bars mean solved more than came in. Red bars mean backlog likely grew that day.</p>
              <svg viewBox={`0 0 ${netFlowChart.chartWidth} ${netFlowChart.chartHeight}`} className="trend-chart-svg" role="img" aria-label="Net flow chart: intake minus solved">
                <line
                  x1={netFlowChart.left}
                  y1={netFlowChart.zeroY}
                  x2={netFlowChart.chartWidth - netFlowChart.right}
                  y2={netFlowChart.zeroY}
                  className="trend-grid-line"
                />
                {netFlowChart.points.map((point) => {
                  const ratio = Math.abs(point.delta) / netFlowChart.maxAbs;
                  const barHeight = ratio * ((netFlowChart.usableHeight / 2) - 8);
                  const barWidth = Math.max(8, netFlowChart.usableWidth / Math.max(1, netFlowChart.points.length) - 4);
                  return (
                    <g key={`delta-${point.date}`}>
                      <rect
                        x={point.x - barWidth / 2}
                        y={point.delta >= 0 ? netFlowChart.zeroY - barHeight : netFlowChart.zeroY}
                        width={barWidth}
                        height={Math.max(2, barHeight)}
                        className={point.delta >= 0 ? "net-flow-bar-positive" : "net-flow-bar-negative"}
                      />
                      <circle
                        cx={point.x}
                        cy={netFlowChart.zeroY}
                        r={14}
                        className="trend-hit-area"
                        onMouseEnter={() => setHoveredNetFlowDate(point.date)}
                        onFocus={() => setHoveredNetFlowDate(point.date)}
                        tabIndex={0}
                        aria-label={`Net flow on ${formatUkDateFromYmd(point.date)}`}
                      />
                    </g>
                  );
                })}
              </svg>
              {activeNetFlowPoint ? (
                <div className="trend-tooltip mt-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">{formatUkDateFromYmd(activeNetFlowPoint.date)}</p>
                  <p className="mono-numbers text-sm text-slate-100">
                    Net Flow: {activeNetFlowPoint.delta > 0 ? "+" : ""}
                    {formatCount(activeNetFlowPoint.delta)} (In {formatCount(activeNetFlowPoint.intake_count)} / Solved{" "}
                    {formatCount(activeNetFlowPoint.solved_count)})
                  </p>
                </div>
              ) : null}
            </div>
          </article>

          <article className="metric-surface col-span-12 overflow-hidden xl:col-span-4">
            <div className="border-b border-slate-400/20 px-4 py-3">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">How Old Is The Backlog?</h2>
            </div>
            <div className="p-4">
              <p className="mb-3 text-xs text-slate-400">This shows what share of open tickets are fresh vs aging/stale.</p>
              <div className="backlog-stacked-bar">
                {backlogBuckets.map((bucket) => (
                  <span
                    key={bucket.label}
                    className={`backlog-segment ${bucket.className}`}
                    style={{ width: `${Math.max(3, bucket.pct)}%` }}
                    title={`${bucket.label}: ${formatCount(bucket.value)} (${bucket.pct.toFixed(1)}%)`}
                  />
                ))}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {backlogBuckets.map((bucket) => (
                  <div key={`bucket-${bucket.label}`} className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">{bucket.label}</p>
                    <p className="mono-numbers text-base text-slate-100">{formatCount(bucket.value)}</p>
                    <p className="mono-numbers text-xs text-slate-300">{bucket.pct.toFixed(1)}%</p>
                  </div>
                ))}
              </div>
            </div>
          </article>

          <article className="metric-surface col-span-12 overflow-hidden xl:col-span-4">
            <div className="border-b border-slate-400/20 px-4 py-3">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">What Needs Action Now?</h2>
            </div>
            <div className="p-4">
              <div className="space-y-2 text-sm text-slate-200">
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Backlog Growth Days</p>
                  <p className="mono-numbers mt-1 text-base">{formatCount(actionSummary.backlogGrowingDays)} of {formatCount(trendWindowDays)}</p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Most Loaded Group</p>
                  <p className="mt-1 truncate">{actionSummary.topGroupName}</p>
                  <p className="mono-numbers text-xs text-slate-300">{formatCount(actionSummary.topGroupOpenCount)} open tickets</p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">High Priority Risk Queue</p>
                  <p className="mono-numbers mt-1 text-base">{formatCount(actionSummary.highRiskCount)} tickets</p>
                </div>
                <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                  <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Oldest Unassigned Ticket</p>
                  <p className="mono-numbers mt-1 text-base">
                    {actionSummary.oldestUnassignedId ? (
                      <a href={getTicketUrl(actionSummary.oldestUnassignedId)} target="_blank" rel="noreferrer" className="ticket-link">
                        #{actionSummary.oldestUnassignedId}
                      </a>
                    ) : "None"}
                  </p>
                </div>
              </div>
            </div>
          </article>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
