"use client";

import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface DashboardProps {
  initialSnapshot: ZendeskSnapshot | null;
  refreshSeconds: number;
  widgetToggles: {
    topSolvers: boolean;
    ticketsByTag: boolean;
    unassigned: boolean;
    attention: boolean;
    dailyVolume: boolean;
  };
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

function getTicketUrl(ticketId: number): string {
  return `${zendeskBaseUrl}/agent/tickets/${ticketId}`;
}

function SummaryTile({ label, value, hint, tone = "text-slate-100" }: { label: string; value: string; hint?: string; tone?: string }): ReactElement {
  return (
    <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className={`mono-numbers mt-2 text-[clamp(1.7rem,3.4vw,2.6rem)] font-semibold ${tone}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </article>
  );
}

export function Dashboard({ initialSnapshot, refreshSeconds, widgetToggles }: DashboardProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ZendeskSnapshot | null>(initialSnapshot);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const effectiveRefreshSeconds = Math.max(5, snapshot?.poll_interval_seconds ?? refreshSeconds);

  const fetchSnapshot = useCallback(async () => {
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
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Snapshot request failed.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSnapshot) {
      void fetchSnapshot();
    }
    const interval = setInterval(() => void fetchSnapshot(), effectiveRefreshSeconds * 1000);
    return () => clearInterval(interval);
  }, [effectiveRefreshSeconds, fetchSnapshot, initialSnapshot]);

  const stale = useMemo(() => {
    if (!snapshot) {
      return true;
    }
    const generatedAtMs = Date.parse(snapshot.generated_at);
    if (Number.isNaN(generatedAtMs)) {
      return true;
    }
    return Date.now() - generatedAtMs > effectiveRefreshSeconds * 1000 * 3;
  }, [effectiveRefreshSeconds, snapshot]);

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <section className="metric-surface w-full max-w-2xl p-8 text-center">
          <h1 className="text-2xl font-semibold">Emerald Park IT Ticket Dashboard</h1>
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
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-sky-200/75">Emerald Park IT</p>
            <h1 className="mt-2 text-[clamp(1.4rem,2.4vw,2.2rem)] font-semibold leading-tight">Emerald Park IT Ticket Dashboard</h1>
          </div>
          <div className="text-sm md:text-right">
            <p className="text-slate-300">
              Last updated: <span className="mono-numbers text-slate-100">{formatAbsoluteDate(snapshot.generated_at)}</span>
            </p>
            <p className={stale ? "text-rose-300" : "text-emerald-300"}>
              {refreshing ? "Refreshing now" : `Refreshes every ${formatRefreshInterval(effectiveRefreshSeconds)}`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
              <a href="/audit" className="nav-link">Open Audit Page</a>
              <a href="/api/export/daily-summary" className="nav-link">Export Summary</a>
            </div>
            {fetchError ? <p className="mt-1 text-rose-300">{fetchError}</p> : null}
          </div>
        </header>

        <section className="grid grid-cols-12 gap-4">
          <SummaryTile label="Unsolved" value={formatCount(snapshot.unsolved_count)} tone="text-[var(--kpi-highlight)]" />
          <SummaryTile label="SLA (7d)" value={formatPercent(snapshot.sla_health_7d.combined_within_target_pct)} tone="text-emerald-300" />
          <SummaryTile label="Created Today" value={formatCount(snapshot.daily_summary.created_today)} />
          <SummaryTile label="Solved (7d)" value={formatCount(snapshot.daily_summary.solved_count_7d)} />
          <SummaryTile label="Backlog >7d" value={formatCount(snapshot.backlog_aging.over_7d)} tone="text-amber-200" />
          <SummaryTile label="Unassigned >2h" value={formatCount(snapshot.assignment_lag.over_2h)} tone="text-amber-200" />
        </section>

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
              <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Trend (Last 7 Days)</h2></div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2 text-right">In</th><th className="px-3 py-2 text-right">Solved</th></tr></thead>
                  <tbody>{snapshot.trends_30d.points.slice(-7).map((point) => <tr key={point.date} className="table-row border-t border-slate-500/15"><td className="px-3 py-2">{formatUkDateFromYmd(point.date)}</td><td className="mono-numbers px-3 py-2 text-right">{formatCount(point.intake_count)}</td><td className="mono-numbers px-3 py-2 text-right">{formatCount(point.solved_count)}</td></tr>)}</tbody>
                </table>
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
            <article className="metric-surface col-span-12 overflow-hidden lg:col-span-6">
              <div className="border-b border-slate-400/20 px-4 py-3"><h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Reopened Tickets (30d)</h2></div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400"><tr><th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2 text-right">Stale</th></tr></thead>
                  <tbody>{snapshot.reopened_tickets_30d.slice(0, 12).map((ticket) => <tr key={ticket.id} className="table-row border-t border-slate-500/15"><td className="mono-numbers px-3 py-2"><a href={getTicketUrl(ticket.id)} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a></td><td className="max-w-[320px] truncate px-3 py-2">{ticket.subject}</td><td className="mono-numbers px-3 py-2 text-right">{formatHours(ticket.stale_hours)}</td></tr>)}</tbody>
                </table>
              </div>
            </article>

            <article className="metric-surface col-span-12 overflow-hidden lg:col-span-6">
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
      </div>
    </main>
  );
}
