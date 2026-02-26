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
  opsUiEnabled?: boolean;
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

const zendeskBaseUrl = process.env.NEXT_PUBLIC_ZENDESK_BASE_URL ?? "https://emeraldpark.zendesk.com";
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

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

export function Dashboard({
  initialSnapshot,
  refreshSeconds,
  staleWarningSeconds,
  showOperations = false,
  opsUiEnabled = true,
  widgetToggles
}: DashboardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ZendeskSnapshot | null>(initialSnapshot);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [historyDaily, setHistoryDaily] = useState<HistoryDailyItem[]>([]);
  const [historyRuns, setHistoryRuns] = useState<HistoryWorkerRunItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [forceRefreshing, setForceRefreshing] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState<string | null>(null);
  const [trendWindowDays, setTrendWindowDays] = useState<7 | 30 | 60 | 90 | 120>(30);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
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
    const chronologicalHistory = [...historyDaily].reverse();
    const backlogGrowingDays =
      chronologicalHistory.length > 1
        ? chronologicalHistory.slice(1).filter((point, index) => point.unsolved_count > chronologicalHistory[index].unsolved_count).length
        : visibleTrendPoints.filter((point) => point.intake_count > point.solved_count).length;
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
  }, [historyDaily, snapshot, visibleTrendPoints]);

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

  const fetchHistory = useCallback(async (limitDays: number, includeRuns: boolean): Promise<void> => {
    try {
      const requests: Array<Promise<Response>> = [
        fetch(`/api/history/daily?limit=${encodeURIComponent(String(limitDays))}`, { cache: "no-store" })
      ];
      if (includeRuns) {
        requests.push(fetch("/api/history/worker-runs?limit=30", { cache: "no-store" }));
      }
      const [dailyResponse, runsResponse] = await Promise.all(requests);
      if (dailyResponse.ok) {
        const payload = (await dailyResponse.json()) as { items?: HistoryDailyItem[] };
        setHistoryDaily(Array.isArray(payload.items) ? payload.items : []);
      }
      if (runsResponse?.ok) {
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
    void fetchHistory(trendWindowDays, showOperations);
    if (showOperations) {
      void fetchWorkerStatus();
    }
    const interval = setInterval(() => {
      void fetchSnapshot();
      void fetchHistory(trendWindowDays, showOperations);
      if (showOperations) {
        void fetchWorkerStatus();
      }
    }, effectiveRefreshSeconds * 1000);
    return () => clearInterval(interval);
  }, [effectiveRefreshSeconds, fetchHistory, fetchSnapshot, fetchWorkerStatus, initialSnapshot, showOperations, trendWindowDays]);
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
    const points = [...historyDaily].reverse();
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
  const activeUserAlerts = useMemo(() => {
    if (!snapshot) {
      return [];
    }
    const alerts = [];
    if (snapshot.alerts.unsolved.active) {
      alerts.push(`${snapshot.alerts.unsolved.label}: ${formatCount(snapshot.alerts.unsolved.value)} (threshold ${formatCount(snapshot.alerts.unsolved.threshold)})`);
    }
    if (snapshot.alerts.attention.active) {
      alerts.push(`${snapshot.alerts.attention.label}: ${formatCount(snapshot.alerts.attention.value)} (threshold ${formatCount(snapshot.alerts.attention.threshold)})`);
    }
    if (snapshot.alerts.unassigned.active) {
      alerts.push(`${snapshot.alerts.unassigned.label}: ${formatCount(snapshot.alerts.unassigned.value)} (threshold ${formatCount(snapshot.alerts.unassigned.threshold)})`);
    }
    return alerts;
  }, [snapshot]);
  const reopenedCount = snapshot?.reopened_tickets_30d.length ?? 0;
  const reopenRatePct = snapshot && snapshot.daily_summary.solved_count_7d > 0 ? (reopenedCount / snapshot.daily_summary.solved_count_7d) * 100 : 0;
  const priorityMix = useMemo(() => {
    if (!snapshot) {
      return [
        { key: "urgent", label: "Urgent", value: 0 },
        { key: "high", label: "High", value: 0 },
        { key: "normal", label: "Normal", value: 0 },
        { key: "low", label: "Low", value: 0 },
        { key: "none", label: "Unspecified", value: 0 }
      ];
    }
    const counts = new Map<string, number>();
    const add = (priority: string | null | undefined): void => {
      const key = (priority ?? "none").toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    };
    snapshot.attention_tickets.forEach((ticket) => add(ticket.priority));
    snapshot.reopened_tickets_30d.forEach((ticket) => add(ticket.priority));
    return ["urgent", "high", "normal", "low", "none"].map((key) => ({
      key,
      label: key === "none" ? "Unspecified" : key[0].toUpperCase() + key.slice(1),
      value: counts.get(key) ?? 0
    }));
  }, [snapshot]);
  const totalPriorityCount = Math.max(1, priorityMix.reduce((sum, item) => sum + item.value, 0));
  const topTicketTags = snapshot?.tickets_by_tag.slice(0, 6) ?? [];

  useEffect(() => {
    const saved = window.localStorage.getItem("dashboard_theme");
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    const initial = saved === "dark" || saved === "light" ? saved : prefersLight ? "light" : "dark";
    setTheme(initial);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("dashboard_theme", theme);
  }, [theme]);

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
          <h1 className="mt-4 text-2xl font-semibold">{showOperations ? "Operations Console" : "Emerald Park IT Ticket Dashboard"}</h1>
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
              {!showOperations ? (
                <button
                  type="button"
                  className="theme-toggle"
                  onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
                  aria-label="Toggle light and dark theme"
                >
                  {theme === "dark" ? "Light Mode" : "Dark Mode"}
                </button>
              ) : null}
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
            <div className="dashboard-nav mt-2 md:justify-end">
              <a href="/" className={`nav-link ${showOperations ? "" : "nav-link-active"}`}>Main Dashboard</a>
              <a href="/audit" className="nav-link">Ticket Audit</a>
              {opsUiEnabled ? <a href="/ops" className={`nav-link ${showOperations ? "nav-link-active" : ""}`}>Operations Console</a> : null}
            </div>
            {showOperations ? (
              <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
                <a href="/api/export/daily-summary?meta=1" className="nav-link">Export Summary</a>
                <button type="button" className="nav-link" onClick={() => void forceRefreshAllMetrics()} disabled={forceRefreshing}>
                  {forceRefreshing ? "Refreshing..." : "Force Refresh Metrics"}
                </button>
              </div>
            ) : null}
            {showOperations && forceRefreshMessage ? <p className="mt-1 text-sky-200">{forceRefreshMessage}</p> : null}
            {fetchError ? <p className="mt-1 text-rose-300">{fetchError}</p> : null}
          </div>
        </header>

        {stale ? (
          <section className="metric-surface alert-strip px-4 py-3 text-sm text-rose-100">
            Snapshot is stale ({formatAgeMinutes(snapshot.generated_at)}). Worker may be delayed or Zendesk rate-limited.
          </section>
        ) : null}

        {!showOperations && activeUserAlerts.length > 0 ? (
          <section className="metric-surface alert-strip px-4 py-3 text-sm text-rose-100">
            <p className="font-semibold uppercase tracking-[0.12em]">Attention Needed</p>
            <ul className="mt-2 space-y-1 text-rose-100/95">
              {activeUserAlerts.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
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

        {!showOperations ? (
          <section className="grid grid-cols-12 gap-4 dashboard-stagger">
            <article className="metric-surface col-span-12 p-4 md:col-span-6 xl:col-span-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Reopened (30d)</p>
              <p className="mono-numbers mt-2 text-3xl font-semibold text-rose-200">{formatCount(reopenedCount)}</p>
              <p className="mt-1 text-xs text-slate-400">currently open tickets reopened after solve</p>
            </article>
            <article className="metric-surface col-span-12 p-4 md:col-span-6 xl:col-span-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Reopen Rate Proxy</p>
              <p className="mono-numbers mt-2 text-3xl font-semibold text-amber-200">{formatPercent(reopenRatePct)}</p>
              <p className="mt-1 text-xs text-slate-400">reopened(30d) / solved(7d)</p>
            </article>
            <article className="metric-surface col-span-12 p-4 md:col-span-6 xl:col-span-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Attention Queue</p>
              <p className="mono-numbers mt-2 text-3xl font-semibold text-cyan-200">{formatCount(snapshot.attention_tickets.length)}</p>
              <p className="mt-1 text-xs text-slate-400">high urgency tickets needing action</p>
            </article>
            <article className="metric-surface col-span-12 p-4 md:col-span-6 xl:col-span-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Median Unassigned</p>
              <p className="mono-numbers mt-2 text-3xl font-semibold text-emerald-200">{formatHours(snapshot.assignment_lag.median_unassigned_hours)}</p>
              <p className="mt-1 text-xs text-slate-400">time before ticket gets assigned</p>
            </article>
          </section>
        ) : null}

        {!showOperations ? (
          <section className="grid grid-cols-12 gap-4">
            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-8">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Ticket Lifecycle Funnel</h2>
              </div>
              <div className="p-4">
                {(() => {
                  const funnelStages = [
                    { label: "Created Today", value: snapshot.daily_summary.created_today, accent: "from-cyan-300 to-sky-300" },
                    { label: "Attention Queue", value: snapshot.attention_tickets.length, accent: "from-amber-300 to-orange-300" },
                    { label: "Unassigned >2h", value: snapshot.assignment_lag.over_2h, accent: "from-rose-300 to-red-300" },
                    { label: "Solved (7d)", value: snapshot.daily_summary.solved_count_7d, accent: "from-emerald-300 to-teal-300" }
                  ];
                  const maxValue = Math.max(1, ...funnelStages.map((stage) => stage.value));
                  return (
                    <div className="space-y-3">
                      {funnelStages.map((stage) => {
                        const pct = (stage.value / maxValue) * 100;
                        return (
                          <div key={stage.label}>
                            <div className="mb-1 flex items-center justify-between text-xs text-slate-300">
                              <span className="uppercase tracking-[0.12em]">{stage.label}</span>
                              <span className="mono-numbers text-slate-100">{formatCount(stage.value)}</span>
                            </div>
                            <div className="h-3 rounded-full bg-slate-900/55">
                              <div className={`h-3 rounded-full bg-gradient-to-r ${stage.accent} transition-[width] duration-700 ease-out`} style={{ width: `${Math.max(4, pct)}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-4">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Action Summary</h2>
              </div>
              <div className="p-4">
                <div className="space-y-2 text-sm text-slate-200">
                  <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Backlog Growth Days</p>
                    <p className="mono-numbers mt-1 text-base">{formatCount(actionSummary.backlogGrowingDays)} of {formatCount(Math.max(historyDaily.length, 1))}</p>
                  </div>
                  <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">High Priority Risk Queue</p>
                    <p className="mono-numbers mt-1 text-base">{formatCount(actionSummary.highRiskCount)} tickets</p>
                  </div>
                  <div className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                    <p className="text-xs uppercase tracking-[0.12em] text-slate-400">Oldest Unassigned</p>
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

            <article className="metric-surface col-span-12 overflow-hidden">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Backlog Age Mix</h2>
              </div>
              <div className="p-4">
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
                <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                  {backlogBuckets.map((bucket) => (
                    <div key={`bucket-main-${bucket.label}`} className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                      <p className="text-xs uppercase tracking-[0.12em] text-slate-400">{bucket.label}</p>
                      <p className="mono-numbers text-base text-slate-100">{formatCount(bucket.value)}</p>
                      <p className="mono-numbers text-xs text-slate-300">{bucket.pct.toFixed(1)}%</p>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          </section>
        ) : null}

        {!showOperations ? (
          <section className="grid grid-cols-12 gap-4 dashboard-stagger">
            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-5">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Priority Mix</h2>
              </div>
              <div className="space-y-3 p-4">
                {priorityMix.map((item) => {
                  const pct = (item.value / totalPriorityCount) * 100;
                  return (
                    <div key={`priority-${item.key}`}>
                      <div className="mb-1 flex items-center justify-between text-xs text-slate-300">
                        <span>{item.label}</span>
                        <span className="mono-numbers">{formatCount(item.value)} ({pct.toFixed(1)}%)</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-900/55">
                        <div className="h-2 rounded-full bg-gradient-to-r from-cyan-300 to-emerald-300 transition-[width] duration-700 ease-out" style={{ width: `${Math.max(2, pct)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden xl:col-span-7">
              <div className="border-b border-slate-400/20 px-4 py-3">
                <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Top Ticket Tags</h2>
              </div>
              <div className="grid grid-cols-1 gap-2 p-4 md:grid-cols-2">
                {topTicketTags.length > 0 ? (
                  topTicketTags.map((tag) => (
                    <div key={`tag-${tag.tag}`} className="rounded-md border border-slate-500/20 bg-slate-900/25 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-slate-100">{tag.tag}</span>
                        <span className="mono-numbers text-sm text-cyan-200">{formatCount(tag.count)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-300">Tag data not available yet.</p>
                )}
              </div>
            </article>
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
            <details className="metric-surface p-4" open>
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">Queue Focus</summary>
              <div className="mt-4 grid grid-cols-12 gap-4">
                {widgetToggles.unassigned ? (
                  <article className="metric-surface col-span-12 overflow-hidden lg:col-span-6">
                    <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Unassigned Tickets</h2></div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2 text-right">Age</th></tr></thead>
                        <tbody>{snapshot.unassigned_tickets.slice(0, 8).map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="mono-numbers px-3 py-2 text-right">{formatHours(ticket.age_hours)}</td></tr>)}</tbody>
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
                        <tbody>{snapshot.attention_tickets.slice(0, 8).map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="px-3 py-2">{ticket.priority}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </article>
                ) : null}
              </div>
            </details>

            <details className="metric-surface p-4">
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-[0.2em] text-slate-200">High Priority Risk</summary>
              <div className="mt-4 grid grid-cols-12 gap-4">
                <article className="metric-surface col-span-12 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2 text-right">Stale</th></tr></thead>
                      <tbody>{snapshot.high_priority_risk_tickets.slice(0, 12).map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[420px] truncate px-3 py-2">{ticket.subject}</td><td className="mono-numbers px-3 py-2 text-right">{formatHours(ticket.stale_hours)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </article>
              </div>
            </details>
          </>
        ) : null}
      </div>
    </main>
  );
}
