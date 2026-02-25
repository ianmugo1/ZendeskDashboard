import { getMetricsApiHeaders } from "./metrics-auth";

export interface AgentDetailMetricSet {
  responded_count: number;
  solved_count: number;
  median_resolution_hours: number;
  resolution_within_target_pct: number;
  reopen_proxy_count: number;
  open_backlog_count: number;
}

export interface AgentDetailTrendPoint {
  date: string;
  count: number;
}

export interface AgentDetailTicketRow {
  id: number;
  subject: string;
  created_at: string;
  solved_at?: string;
  updated_at?: string;
  status: string;
  priority: string;
}

export interface AgentDetailPayload {
  agent_id: number;
  agent_name: string;
  window_days: 7 | 14 | 30;
  generated_at: string;
  metrics: AgentDetailMetricSet;
  trends: {
    responded: AgentDetailTrendPoint[];
    solved: AgentDetailTrendPoint[];
  };
  solved_tickets: AgentDetailTicketRow[];
  at_risk_tickets: AgentDetailTicketRow[];
}

function parseWindowDays(input: string | undefined): 7 | 14 | 30 {
  if (input === "14") {
    return 14;
  }
  if (input === "30") {
    return 30;
  }
  return 7;
}

export async function getInitialAgentDetail(
  apiBaseUrl: string,
  agentId: number,
  windowInput: string | undefined
): Promise<AgentDetailPayload | null> {
  const windowDays = parseWindowDays(windowInput);
  try {
    const response = await fetch(
      `${apiBaseUrl}/api/metrics/agent/${encodeURIComponent(String(agentId))}?window_days=${windowDays}`,
      {
        cache: "no-store",
        headers: getMetricsApiHeaders()
      }
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as AgentDetailPayload;
  } catch {
    return null;
  }
}
