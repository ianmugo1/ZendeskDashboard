"use client";

import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import Image from "next/image";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface SolvedAuditPageProps {
  initialSnapshot: ZendeskSnapshot | null;
  refreshSeconds: number;
}

interface SolvedAuditResponsePayload {
  page: number;
  page_size: number;
  total: number;
  items: ZendeskSnapshot["solved_tickets_7d"];
}

interface AuditFilterPreset {
  id: string;
  name: string;
  agentId: string;
  search: string;
  updatedAt: string;
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
  const [page, setPage] = useState(1);
  const [auditRows, setAuditRows] = useState<ZendeskSnapshot["solved_tickets_7d"]>(initialSnapshot?.solved_tickets_7d.slice(0, 25) ?? []);
  const [auditTotal, setAuditTotal] = useState<number>(initialSnapshot?.solved_tickets_7d.length ?? 0);
  const [presets, setPresets] = useState<AuditFilterPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("none");
  const [presetName, setPresetName] = useState<string>("");
  const auditRequestSeqRef = useRef(0);
  const auditAbortRef = useRef<AbortController | null>(null);
  const pageSize = 25;
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

  const totalPages = Math.max(1, Math.ceil(auditTotal / pageSize));

  useEffect(() => {
    setPage(1);
  }, [selectedAgentId, auditSearch]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    const savedAgent = window.localStorage.getItem("audit_filter_agent");
    const savedSearch = window.localStorage.getItem("audit_filter_search");
    if (savedAgent) {
      setSelectedAgentId(savedAgent);
    }
    if (savedSearch) {
      setAuditSearch(savedSearch);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("audit_filter_agent", selectedAgentId);
    window.localStorage.setItem("audit_filter_search", auditSearch);
  }, [selectedAgentId, auditSearch]);

  const fetchAuditRows = useCallback(async () => {
    auditAbortRef.current?.abort();
    const abortController = new AbortController();
    auditAbortRef.current = abortController;
    const requestSeq = auditRequestSeqRef.current + 1;
    auditRequestSeqRef.current = requestSeq;
    const url = new URL("/api/audit/solved", window.location.origin);
    url.searchParams.set("agent_id", selectedAgentId);
    url.searchParams.set("q", auditSearch);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(pageSize));

    try {
      const response = await fetch(url.toString(), { cache: "no-store", signal: abortController.signal });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Audit request failed with ${response.status}`);
      }

      const payload = (await response.json()) as SolvedAuditResponsePayload;
      if (requestSeq !== auditRequestSeqRef.current) {
        return;
      }
      setAuditRows(payload.items ?? []);
      setAuditTotal(payload.total ?? 0);
      setFetchError(null);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    }
  }, [auditSearch, page, pageSize, selectedAgentId]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    void fetchAuditRows().catch((error) => {
      setFetchError(error instanceof Error ? error.message : "Audit request failed.");
    });
  }, [fetchAuditRows, snapshot?.generated_at]);

  useEffect(() => {
    return () => {
      auditAbortRef.current?.abort();
    };
  }, []);

  const fetchPresets = useCallback(async () => {
    const response = await fetch("/api/audit/presets", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { presets?: AuditFilterPreset[] };
    setPresets(payload.presets ?? []);
  }, []);

  useEffect(() => {
    void fetchPresets();
  }, [fetchPresets]);

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
            className="mx-auto h-24 w-24 rounded-md border border-sky-200/20 bg-black/20 p-1 md:h-28 md:w-28"
          />
          <h1 className="mt-4 text-2xl font-semibold">Emerald Park IT Ticket Audit</h1>
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
          <div className="flex items-center gap-4">
            <Image
              src="/emerald-park-logo.png"
              alt="Emerald Park"
              width={112}
              height={112}
              priority
              className="h-14 w-14 shrink-0 rounded-md border border-sky-200/20 bg-black/20 p-1 md:h-16 md:w-16"
            />
            <div>
            <p className="text-[clamp(0.62rem,0.8vw,0.78rem)] uppercase tracking-[0.35em] text-sky-200/75">Emerald Park IT</p>
            <h1 className="mt-2 text-[clamp(1.55rem,2.9vw,3rem)] font-semibold leading-[1.03] tracking-tight">
              Solved Tickets Audit (7d)
            </h1>
            </div>
          </div>
          <div className="text-[clamp(0.75rem,0.95vw,0.95rem)] md:text-right">
            <p className="text-slate-300">
              Last updated: <span className="mono-numbers text-slate-100">{formatAbsoluteDate(snapshot.generated_at)}</span>
            </p>
            <p className="text-slate-300">
              Core: <span className="mono-numbers text-slate-100">{formatAgeMinutes(snapshot.core_generated_at)}</span> | Heavy:{" "}
              <span className="mono-numbers text-slate-100">{formatAgeMinutes(snapshot.heavy_generated_at)}</span>
            </p>
            <p className="text-slate-300">
              {refreshing ? "Refreshing now" : `Refreshes every ${formatRefreshInterval(effectiveRefreshSeconds)}`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 md:justify-end">
              <a href="/" className="nav-link">
                Back To Dashboard
              </a>
              <a href="/api/export/solved-tickets-7d?meta=1" className="nav-link">
                Export Solved CSV
              </a>
              <a href="/api/export/agent-performance?meta=1" className="nav-link">
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

            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-[0.2em] text-slate-400" htmlFor="preset-filter">
                Presets
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="preset-filter"
                  className="audit-input min-w-[210px]"
                  value={selectedPresetId}
                  onChange={(event) => setSelectedPresetId(event.target.value)}
                >
                  <option value="none">Saved preset</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="nav-link"
                  onClick={() => {
                    const preset = presets.find((item) => item.id === selectedPresetId);
                    if (!preset) {
                      return;
                    }
                    setSelectedAgentId(preset.agentId);
                    setAuditSearch(preset.search);
                  }}
                >
                  Apply
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  className="audit-input min-w-[210px]"
                  type="text"
                  placeholder="Preset name"
                  value={presetName}
                  onChange={(event) => setPresetName(event.target.value)}
                />
                <button
                  type="button"
                  className="nav-link"
                  onClick={() => {
                    const name = presetName.trim();
                    if (!name) {
                      return;
                    }
                    void (async () => {
                      try {
                        const response = await fetch("/api/audit/presets", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ name, agentId: selectedAgentId, search: auditSearch })
                        });
                        if (!response.ok) {
                          const payload = (await response.json().catch(() => ({}))) as { error?: string };
                          throw new Error(payload.error ?? `Preset save failed with ${response.status}`);
                        }
                        await fetchPresets();
                        setPresetName("");
                        setFetchError(null);
                      } catch (error) {
                        setFetchError(error instanceof Error ? error.message : "Preset save failed.");
                      }
                    })();
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="nav-link"
                  onClick={() => {
                    if (selectedPresetId === "none") {
                      return;
                    }
                    void (async () => {
                      try {
                        const response = await fetch(`/api/audit/presets?id=${encodeURIComponent(selectedPresetId)}`, {
                          method: "DELETE"
                        });
                        if (!response.ok) {
                          const payload = (await response.json().catch(() => ({}))) as { error?: string };
                          throw new Error(payload.error ?? `Preset delete failed with ${response.status}`);
                        }
                        setSelectedPresetId("none");
                        await fetchPresets();
                        setFetchError(null);
                      } catch (error) {
                        setFetchError(error instanceof Error ? error.message : "Preset delete failed.");
                      }
                    })();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="audit-summary text-sm text-slate-300">
              Showing <span className="mono-numbers text-slate-100">{formatCount(auditRows.length)}</span> of{" "}
              <span className="mono-numbers text-slate-100">{formatCount(auditTotal)}</span> solved tickets
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
                {auditTotal === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-300" colSpan={5}>
                      No solved tickets match current filters.
                    </td>
                  </tr>
                ) : (
                  auditRows.map((ticket) => (
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
                      <td className="px-4 py-3 text-slate-200">
                        <a href={`/audit/agent/${ticket.assignee_id}`} className="ticket-link">
                          {ticket.assignee_name}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{formatAbsoluteDate(ticket.solved_at)}</td>
                      <td className="mono-numbers px-4 py-3 text-right text-slate-100">{formatAge(ticket.age_hours)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {auditTotal > 0 ? (
            <div className="flex items-center justify-between border-t border-slate-400/20 px-5 py-3 text-sm text-slate-300">
              <span>
                Page <span className="mono-numbers text-slate-100">{formatCount(page)}</span> of{" "}
                <span className="mono-numbers text-slate-100">{formatCount(totalPages)}</span>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="nav-link"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="nav-link"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  disabled={page >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </article>
      </div>
    </main>
  );
}
