export interface ZendeskTicket {
  id: number;
  subject: string | null;
  status: string;
  priority: string | null;
  created_at: string;
  updated_at: string;
  solved_at?: string | null;
  assignee_id: number | null;
  group_id?: number | null;
  requester_id: number | null;
  tags: string[];
}

export interface ZendeskUser {
  id: number;
  name: string;
  email?: string;
  role?: string;
  active?: boolean;
}

export interface ZendeskSearchResponse {
  count: number;
  next_page: string | null;
  previous_page: string | null;
  results: ZendeskTicket[];
}

export interface ZendeskCountResponse {
  count:
    | number
    | {
        value: number;
        refreshed_at?: string;
      };
}

export interface ZendeskUsersResponse {
  users: ZendeskUser[];
}

export interface ZendeskUsersListResponse {
  users: ZendeskUser[];
  next_page: string | null;
  previous_page: string | null;
}

export interface ZendeskGroup {
  id: number;
  name: string;
}

export interface ZendeskGroupsListResponse {
  groups: ZendeskGroup[];
  next_page: string | null;
  previous_page: string | null;
}

export interface ZendeskGroupsResponse {
  groups: ZendeskGroup[];
}

export interface ZendeskClientOptions {
  subdomain: string;
  email: string;
  apiToken: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface SearchTicketsOptions {
  perPage?: number;
  page?: number;
  sortBy?: "created_at" | "updated_at" | "priority" | "status";
  sortOrder?: "asc" | "desc";
}

export interface SearchAllTicketsOptions {
  pageSize?: number;
  limit?: number;
  sortBy?: "created_at" | "updated_at" | "priority" | "status";
  sortOrder?: "asc" | "desc";
}

export interface DailyTickets {
  today: number;
  yesterday: number;
  last_7_days: number;
}

export interface SnapshotTicket {
  id: number;
  subject: string;
  created_at: string;
  age_hours: number;
}

export interface AttentionTicket extends SnapshotTicket {
  priority: string;
  status: string;
}

export interface TopSolver {
  agent_id: number;
  agent_name: string;
  solved_count: number;
}

export interface AgentAuditSummary {
  agent_id: number;
  agent_name: string;
  solved_count: number;
}

export interface SolvedTicketAudit {
  id: number;
  subject: string;
  created_at: string;
  solved_at: string;
  assignee_id: number;
  assignee_name: string;
  age_hours: number;
}

export interface SlaHealthBreakdown {
  within_target: number;
  breached: number;
  total_evaluated: number;
  within_target_pct: number;
}

export interface SlaHealth {
  window_days: number;
  first_response_target_hours: number;
  resolution_target_hours: number;
  first_response: SlaHealthBreakdown;
  resolution: SlaHealthBreakdown & {
    median_resolution_hours: number;
  };
  combined_within_target_pct: number;
  first_response_method: string;
}

export interface BacklogAgingBuckets {
  under_24h: number;
  from_1d_to_3d: number;
  from_3d_to_7d: number;
  over_7d: number;
  total: number;
}

export interface AgentPerformanceRow {
  agent_id: number;
  agent_name: string;
  solved_count_7d: number;
  median_resolution_hours: number;
  resolution_within_target_pct: number;
  reopen_proxy_count_30d: number;
  open_backlog_count: number;
}

export interface ReopenedTicketAudit {
  id: number;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  last_solved_at: string;
  assignee_id: number | null;
  assignee_name: string;
  age_hours: number;
  stale_hours: number;
}

export interface AssignmentLag {
  over_30m: number;
  over_2h: number;
  median_unassigned_hours: number;
  oldest_unassigned: SnapshotTicket[];
}

export interface GroupWorkloadRow {
  group_id: number;
  group_name: string;
  open_count: number;
  solved_count_7d: number;
  high_priority_open_count: number;
}

export interface HighPriorityRiskTicket {
  id: number;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  stale_hours: number;
  assignee_id: number | null;
  assignee_name: string;
}

export interface TrendPoint {
  date: string;
  intake_count: number;
  solved_count: number;
  backlog_estimate: number;
  sla_within_target_pct: number;
}

export interface Trend30d {
  points: TrendPoint[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SnapshotAlertMetric {
  label: string;
  value: number;
  threshold: number;
  active: boolean;
}

export interface SnapshotAlerts {
  unsolved: SnapshotAlertMetric;
  attention: SnapshotAlertMetric;
  unassigned: SnapshotAlertMetric;
  active_count: number;
}

export interface DailySummarySnapshot {
  date: string;
  generated_at: string;
  unsolved_count: number;
  created_today: number;
  solved_count_7d: number;
  attention_count: number;
  sla_within_target_pct: number;
  active_alert_count: number;
}

export interface ZendeskSnapshot {
  unsolved_count: number;
  daily_tickets: DailyTickets;
  sla_health_7d: SlaHealth;
  backlog_aging: BacklogAgingBuckets;
  unassigned_tickets: SnapshotTicket[];
  top_solvers: TopSolver[];
  agent_audit: AgentAuditSummary[];
  all_agents: AgentAuditSummary[];
  agent_performance_7d: AgentPerformanceRow[];
  solved_tickets_7d: SolvedTicketAudit[];
  reopened_tickets_30d: ReopenedTicketAudit[];
  assignment_lag: AssignmentLag;
  group_workload: GroupWorkloadRow[];
  high_priority_risk_tickets: HighPriorityRiskTicket[];
  trends_30d: Trend30d;
  attention_tickets: AttentionTicket[];
  tickets_by_tag: TagCount[];
  daily_summary: DailySummarySnapshot;
  alerts: SnapshotAlerts;
  snapshot_mode?: "light" | "heavy";
  core_generated_at?: string;
  heavy_generated_at?: string;
  generated_at: string;
  poll_interval_seconds: number;
  window_timezone: string;
}
