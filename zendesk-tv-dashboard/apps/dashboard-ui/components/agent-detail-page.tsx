"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentDetailPayload } from "../lib/agent-detail";

interface AgentDetailPageProps {
  initialData: AgentDetailPayload | null;
  agentId: number;
  initialWindowDays: 7 | 14 | 30;
  refreshSeconds: number;
}

const zendeskBaseUrl = process.env.NEXT_PUBLIC_ZENDESK_BASE_URL ?? "https://emeraldpark.zendesk.com";

function formatCount(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat("en-IE").format(value) : "0";
}

function formatHours(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}h` : "0h";
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "0%";
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "n/a";
  }
  return parsed.toLocaleString("en-IE", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false
  });
}

function maxTrendCount(data: AgentDetailPayload | null): number {
  if (!data) {
    return 1;
  }
  const maxResponded = Math.max(...data.trends.responded.map((point) => point.count), 0);
  const maxSolved = Math.max(...data.trends.solved.map((point) => point.count), 0);
  return Math.max(1, maxResponded, maxSolved);
}

export function AgentDetailPage({ initialData, agentId, initialWindowDays, refreshSeconds }: AgentDetailPageProps): ReactElement {
  const [data, setData] = useState<AgentDetailPayload | null>(initialData);
  const [windowDays, setWindowDays] = useState<7 | 14 | 30>(initialWindowDays);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async (windowToLoad: 7 | 14 | 30) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/agent/${agentId}?window_days=${windowToLoad}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Agent request failed with ${response.status}`);
      }
      const payload = (await response.json()) as AgentDetailPayload;
      setData(payload);
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Agent request failed.");
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchDetail(windowDays);
  }, [fetchDetail, windowDays]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchDetail(windowDays);
    }, Math.max(5, refreshSeconds) * 1000);
    return () => clearInterval(interval);
  }, [fetchDetail, refreshSeconds, windowDays]);

  const trendPeak = useMemo(() => maxTrendCount(data), [data]);

  if (!data) {
    return (
      <main className="dashboard-shell min-h-[100dvh] px-[clamp(0.75rem,1.4vw,2rem)] py-[clamp(0.75rem,1.4vw,1.75rem)]">
        <section className="metric-surface mx-auto max-w-3xl p-8 text-center">
          <Image src="/emerald-park-logo.png" alt="Emerald Park" width={140} height={140} className="mx-auto h-28 w-28 md:h-32 md:w-32" />
          <h1 className="mt-4 text-2xl font-semibold">Agent Detail</h1>
          <p className="mt-3 text-slate-300">Agent profile is currently unavailable.</p>
          {error ? <p className="mt-3 text-rose-300">{error}</p> : null}
          <div className="mt-6 flex justify-center gap-2">
            <Link href="/audit" className="nav-link">Back To Audit</Link>
            <Link href="/" className="nav-link">Dashboard</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell min-h-[100dvh] px-[clamp(0.75rem,1.4vw,2rem)] py-[clamp(0.75rem,1.4vw,1.75rem)]">
      <div className="mx-auto flex w-full max-w-none flex-col gap-4">
        <header className="agent-hero metric-surface p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex items-center gap-4">
              <Image src="/emerald-park-logo.png" alt="Emerald Park" width={128} height={128} className="h-16 w-16 shrink-0 md:h-20 md:w-20" />
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-emerald-200/85">Agent Performance Profile</p>
                <h1 className="mt-2 text-[clamp(1.45rem,2.7vw,2.35rem)] font-semibold leading-tight">{data.agent_name}</h1>
                <p className="mt-1 text-sm text-slate-300">Agent ID #{data.agent_id}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {[7, 14, 30].map((windowOption) => (
                <button
                  key={windowOption}
                  type="button"
                  className={`window-toggle ${windowDays === windowOption ? "window-toggle-active" : ""}`}
                  onClick={() => setWindowDays(windowOption as 7 | 14 | 30)}
                >
                  {windowOption}d
                </button>
              ))}
              <Link href="/audit" className="nav-link">Back To Audit</Link>
            </div>
          </div>
          <div className="mt-3 text-sm text-slate-300">
            {loading ? "Refreshing..." : `Updated ${formatDate(data.generated_at)} UTC`}
            {error ? <span className="ml-2 text-rose-300">| {error}</span> : null}
          </div>
        </header>

        <section className="grid grid-cols-12 gap-4">
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Responded</p>
            <p className="mono-numbers mt-2 text-4xl text-emerald-200">{formatCount(data.metrics.responded_count)}</p>
          </article>
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Solved</p>
            <p className="mono-numbers mt-2 text-4xl text-sky-200">{formatCount(data.metrics.solved_count)}</p>
          </article>
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Median Resolution</p>
            <p className="mono-numbers mt-2 text-4xl text-slate-100">{formatHours(data.metrics.median_resolution_hours)}</p>
          </article>
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Within SLA</p>
            <p className="mono-numbers mt-2 text-4xl text-emerald-300">{formatPercent(data.metrics.resolution_within_target_pct)}</p>
          </article>
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Reopen Risk</p>
            <p className="mono-numbers mt-2 text-4xl text-amber-200">{formatCount(data.metrics.reopen_proxy_count)}</p>
          </article>
          <article className="metric-surface col-span-12 p-4 sm:col-span-6 xl:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Open Backlog</p>
            <p className="mono-numbers mt-2 text-4xl text-rose-200">{formatCount(data.metrics.open_backlog_count)}</p>
          </article>
        </section>

        <section className="metric-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Activity Trend ({windowDays} Days)</h2>
            <p className="text-xs text-slate-400">Responded vs Solved per day</p>
          </div>
          <div className="mt-4 grid gap-2">
            {data.trends.responded.map((point, index) => {
              const solvedPoint = data.trends.solved[index];
              const respondedWidth = `${Math.max(2, (point.count / trendPeak) * 100)}%`;
              const solvedWidth = `${Math.max(2, ((solvedPoint?.count ?? 0) / trendPeak) * 100)}%`;
              return (
                <div key={point.date} className="agent-trend-row">
                  <span className="mono-numbers text-xs text-slate-300">{point.date}</span>
                  <div className="agent-trend-bars">
                    <span className="agent-trend-responded" style={{ width: respondedWidth }} />
                    <span className="agent-trend-solved" style={{ width: solvedWidth }} />
                  </div>
                  <span className="mono-numbers text-xs text-slate-300">
                    {point.count} / {solvedPoint?.count ?? 0}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="grid grid-cols-12 gap-4">
          <article className="metric-surface col-span-12 overflow-hidden xl:col-span-7">
            <div className="border-b border-slate-400/20 px-4 py-3">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">Recent Solved Tickets</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400">
                  <tr>
                    <th className="px-3 py-2">ID</th>
                    <th className="px-3 py-2">Subject</th>
                    <th className="px-3 py-2">Solved At</th>
                    <th className="px-3 py-2">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {data.solved_tickets.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-slate-300">No solved tickets in this window.</td>
                    </tr>
                  ) : (
                    data.solved_tickets.slice(0, 20).map((ticket) => (
                      <tr key={`solved-${ticket.id}-${ticket.solved_at}`} className="table-row border-t border-slate-500/15">
                        <td className="mono-numbers px-3 py-2">
                          <a href={`${zendeskBaseUrl}/agent/tickets/${ticket.id}`} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a>
                        </td>
                        <td className="max-w-[420px] truncate px-3 py-2">{ticket.subject}</td>
                        <td className="px-3 py-2">{formatDate(ticket.solved_at ?? ticket.updated_at ?? ticket.created_at)}</td>
                        <td className="px-3 py-2">{ticket.priority}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>

          <article className="metric-surface col-span-12 overflow-hidden xl:col-span-5">
            <div className="border-b border-slate-400/20 px-4 py-3">
              <h2 className="text-xs uppercase tracking-[0.2em] text-slate-300">At-Risk Open Tickets</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400">
                  <tr>
                    <th className="px-3 py-2">ID</th>
                    <th className="px-3 py-2">Subject</th>
                    <th className="px-3 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.at_risk_tickets.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-4 text-slate-300">No high-priority stale tickets assigned.</td>
                    </tr>
                  ) : (
                    data.at_risk_tickets.map((ticket) => (
                      <tr key={`risk-${ticket.id}-${ticket.updated_at}`} className="table-row border-t border-slate-500/15">
                        <td className="mono-numbers px-3 py-2">
                          <a href={`${zendeskBaseUrl}/agent/tickets/${ticket.id}`} target="_blank" rel="noreferrer" className="ticket-link">#{ticket.id}</a>
                        </td>
                        <td className="max-w-[280px] truncate px-3 py-2">{ticket.subject}</td>
                        <td className="px-3 py-2">{formatDate(ticket.updated_at ?? ticket.created_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
