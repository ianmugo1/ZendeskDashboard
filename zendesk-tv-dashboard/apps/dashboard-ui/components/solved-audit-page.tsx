"use client";

import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface SolvedAuditPageProps {
  initialSnapshot: ZendeskSnapshot | null;
  refreshSeconds: number;
}

const zendeskBaseUrl = process.env.NEXT_PUBLIC_ZENDESK_BASE_URL ?? "https://emeraldpark.zendesk.com";
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat("en-IE").format(value);
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

function formatRefreshInterval(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} min`;
  }
  return `${seconds}s`;
}

function formatAge(ageHours: number): string {
  if (!Number.isFinite(ageHours)) {
    return "0h";
  }
  return `${ageHours.toFixed(1)}h`;
}

function getTicketUrl(ticketId: number): string {
  return `${zendeskBaseUrl}/agent/tickets/${ticketId}`;
}

export function SolvedAuditPage({ initialSnapshot, refreshSeconds }: SolvedAuditPageProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ZendeskSnapshot | null>(initialSnapshot);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("all");
  const [auditSearch, setAuditSearch] = useState<string>("");
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

    const interval = setInterval(() => {
      void fetchSnapshot();
    }, effectiveRefreshSeconds * 1000);

    return () => clearInterval(interval);
  }, [effectiveRefreshSeconds, fetchSnapshot, initialSnapshot]);

  const allAgents = useMemo(() => {
    return snapshot?.all_agents ?? snapshot?.agent_audit ?? [];
  }, [snapshot]);

  const solvedTickets = useMemo(() => {
    return snapshot?.solved_tickets_7d ?? [];
  }, [snapshot]);

  const filteredSolvedAuditRows = useMemo(() => {
    const search = auditSearch.trim().toLowerCase();
    return solvedTickets.filter((ticket) => {
      const matchesAgent = selectedAgentId === "all" || String(ticket.assignee_id) === selectedAgentId;
      const matchesSearch =
        search.length === 0 || ticket.subject.toLowerCase().includes(search) || String(ticket.id).includes(search);
      return matchesAgent && matchesSearch;
    });
  }, [auditSearch, selectedAgentId, solvedTickets]);

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <section className="metric-surface w-full max-w-2xl p-8 text-center">
          <h1 className="text-2xl font-semibold">Emerald Park IT Ticket Audit</h1>
          <p className="mt-4 text-slate-300">Waiting for the first snapshot from the metrics API.</p>
          {fetchError ? <p className="mt-3 text-rose-300">{fetchError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell min-h-[100dvh] px-[clamp(0.75rem,1.4vw,2rem)] py-[clamp(0.75rem,1.4vw,1.75rem)]">
      <div className="mx-auto flex w-full max-w-none flex-col gap-[clamp(0.75rem,1.2vw,1.25rem)]">
        <header className="metric-surface flex flex-col gap-3 p-[clamp(0.9rem,1.35vw,1.4rem)] md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[clamp(0.62rem,0.8vw,0.78rem)] uppercase tracking-[0.35em] text-sky-200/75">Emerald Park IT</p>
            <h1 className="mt-2 text-[clamp(1.55rem,2.9vw,3rem)] font-semibold leading-[1.03] tracking-tight">
              Solved Tickets Audit (7d)
            </h1>
          </div>
          <div className="text-[clamp(0.75rem,0.95vw,0.95rem)] md:text-right">
            <p className="text-slate-300">
              Last updated: <span className="mono-numbers text-slate-100">{formatAbsoluteDate(snapshot.generated_at)}</span>
            </p>
            <p className="text-slate-300">
              {refreshing ? "Refreshing now" : `Refreshes every ${formatRefreshInterval(effectiveRefreshSeconds)}`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
              <a href="/" className="nav-link">
                Back To Dashboard
              </a>
              <a href="/api/export/solved-tickets-7d" className="nav-link">
                Export Solved CSV
              </a>
              <a href="/api/export/agent-performance" className="nav-link">
                Export Agent CSV
              </a>
            </div>
            {fetchError ? <p className="mt-1 text-rose-300">{fetchError}</p> : null}
          </div>
        </header>

        <article className="metric-surface col-span-12 overflow-hidden">
          <div className="audit-toolbar flex flex-col gap-3 border-b border-slate-400/20 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-[0.2em] text-slate-400" htmlFor="agent-filter">
                Agent
              </label>
              <select
                id="agent-filter"
                className="audit-input min-w-[220px]"
                value={selectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
              >
                <option value="all">All Zendesk agents</option>
                {allAgents.map((agent) => (
                  <option key={agent.agent_id} value={String(agent.agent_id)}>
                    {agent.agent_name} ({formatCount(agent.solved_count)})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-[0.2em] text-slate-400" htmlFor="ticket-search">
                Search
              </label>
              <input
                id="ticket-search"
                className="audit-input min-w-[260px]"
                type="text"
                placeholder="Ticket ID or subject"
                value={auditSearch}
                onChange={(event) => setAuditSearch(event.target.value)}
              />
            </div>

            <div className="audit-summary text-sm text-slate-300">
              Showing <span className="mono-numbers text-slate-100">{formatCount(filteredSolvedAuditRows.length)}</span> of{" "}
              <span className="mono-numbers text-slate-100">{formatCount(solvedTickets.length)}</span> solved tickets
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="table-head text-left text-xs uppercase tracking-[0.2em] text-slate-400">
                <tr>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Solved By</th>
                  <th className="px-4 py-3">Solved At</th>
                  <th className="px-4 py-3 text-right">Age</th>
                </tr>
              </thead>
              <tbody>
                {filteredSolvedAuditRows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-300" colSpan={5}>
                      No solved tickets match current filters.
                    </td>
                  </tr>
                ) : (
                  filteredSolvedAuditRows.map((ticket) => (
                    <tr key={`audit-${ticket.id}-${ticket.solved_at}`} className="table-row border-t border-slate-500/15">
                      <td className="mono-numbers px-4 py-3 text-sky-200">
                        <a
                          href={getTicketUrl(ticket.id)}
                          target="_blank"
                          rel="noreferrer"
                          className="ticket-link inline-flex items-center gap-2"
                        >
                          <span>#{ticket.id}</span>
                          <span className="ticket-link-open">Open</span>
                        </a>
                      </td>
                      <td className="max-w-[480px] truncate px-4 py-3 text-slate-100">{ticket.subject}</td>
                      <td className="px-4 py-3 text-slate-200">{ticket.assignee_name}</td>
                      <td className="px-4 py-3 text-slate-300">{formatAbsoluteDate(ticket.solved_at)}</td>
                      <td className="mono-numbers px-4 py-3 text-right text-slate-100">{formatAge(ticket.age_hours)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </article>
      </div>
    </main>
  );
}
