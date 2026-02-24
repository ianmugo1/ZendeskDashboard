import type {
  AgentAuditSummary,
  AgentPerformanceRow,
  AssignmentLag,
  AttentionTicket,
  BacklogAgingBuckets,
  GroupWorkloadRow,
  HighPriorityRiskTicket,
  ReopenedTicketAudit,
  SlaHealth,
  SolvedTicketAudit,
  SnapshotTicket,
  TopSolver,
  TrendPoint,
  ZendeskSnapshot
} from "@zendesk/zendesk-client";

function assertFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Snapshot validation failed: ${fieldName} must be a finite number.`);
  }
}

function assertString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Snapshot validation failed: ${fieldName} must be a non-empty string.`);
  }
}

function assertDateString(value: unknown, fieldName: string): void {
  assertString(value, fieldName);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Snapshot validation failed: ${fieldName} must be a valid ISO date string.`);
  }
}

function assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Snapshot validation failed: ${fieldName} must be an array.`);
  }
}

function validateSnapshotTicket(ticket: SnapshotTicket, prefix: string): void {
  assertFiniteNumber(ticket.id, `${prefix}.id`);
  assertString(ticket.subject, `${prefix}.subject`);
  assertDateString(ticket.created_at, `${prefix}.created_at`);
  assertFiniteNumber(ticket.age_hours, `${prefix}.age_hours`);
}

function validateAttentionTicket(ticket: AttentionTicket, prefix: string): void {
  validateSnapshotTicket(ticket, prefix);
  assertString(ticket.priority, `${prefix}.priority`);
  assertString(ticket.status, `${prefix}.status`);
}

function validateTopSolver(solver: TopSolver, prefix: string): void {
  assertFiniteNumber(solver.agent_id, `${prefix}.agent_id`);
  assertString(solver.agent_name, `${prefix}.agent_name`);
  assertFiniteNumber(solver.solved_count, `${prefix}.solved_count`);
}

function validateAgentSummary(summary: AgentAuditSummary, prefix: string): void {
  assertFiniteNumber(summary.agent_id, `${prefix}.agent_id`);
  assertString(summary.agent_name, `${prefix}.agent_name`);
  assertFiniteNumber(summary.solved_count, `${prefix}.solved_count`);
}

function validateSolvedTicket(ticket: SolvedTicketAudit, prefix: string): void {
  assertFiniteNumber(ticket.id, `${prefix}.id`);
  assertString(ticket.subject, `${prefix}.subject`);
  assertDateString(ticket.created_at, `${prefix}.created_at`);
  assertDateString(ticket.solved_at, `${prefix}.solved_at`);
  assertFiniteNumber(ticket.assignee_id, `${prefix}.assignee_id`);
  assertString(ticket.assignee_name, `${prefix}.assignee_name`);
  assertFiniteNumber(ticket.age_hours, `${prefix}.age_hours`);
}

function validateReopenedTicket(ticket: ReopenedTicketAudit, prefix: string): void {
  assertFiniteNumber(ticket.id, `${prefix}.id`);
  assertString(ticket.subject, `${prefix}.subject`);
  assertString(ticket.status, `${prefix}.status`);
  assertString(ticket.priority, `${prefix}.priority`);
  assertDateString(ticket.created_at, `${prefix}.created_at`);
  assertDateString(ticket.updated_at, `${prefix}.updated_at`);
  assertDateString(ticket.last_solved_at, `${prefix}.last_solved_at`);
  if (ticket.assignee_id !== null) {
    assertFiniteNumber(ticket.assignee_id, `${prefix}.assignee_id`);
  }
  assertString(ticket.assignee_name, `${prefix}.assignee_name`);
  assertFiniteNumber(ticket.age_hours, `${prefix}.age_hours`);
  assertFiniteNumber(ticket.stale_hours, `${prefix}.stale_hours`);
}

function validateBacklogAging(backlog: BacklogAgingBuckets): void {
  assertFiniteNumber(backlog.under_24h, "backlog_aging.under_24h");
  assertFiniteNumber(backlog.from_1d_to_3d, "backlog_aging.from_1d_to_3d");
  assertFiniteNumber(backlog.from_3d_to_7d, "backlog_aging.from_3d_to_7d");
  assertFiniteNumber(backlog.over_7d, "backlog_aging.over_7d");
  assertFiniteNumber(backlog.total, "backlog_aging.total");
}

function validateSlaBreakdown(
  value: SlaHealth["first_response"] | SlaHealth["resolution"],
  prefix: string,
  includeMedian = false
): void {
  assertFiniteNumber(value.within_target, `${prefix}.within_target`);
  assertFiniteNumber(value.breached, `${prefix}.breached`);
  assertFiniteNumber(value.total_evaluated, `${prefix}.total_evaluated`);
  assertFiniteNumber(value.within_target_pct, `${prefix}.within_target_pct`);

  if (includeMedian) {
    const withMedian = value as SlaHealth["resolution"];
    assertFiniteNumber(withMedian.median_resolution_hours, `${prefix}.median_resolution_hours`);
  }
}

function validateSlaHealth(sla: SlaHealth): void {
  assertFiniteNumber(sla.window_days, "sla_health_7d.window_days");
  assertFiniteNumber(sla.first_response_target_hours, "sla_health_7d.first_response_target_hours");
  assertFiniteNumber(sla.resolution_target_hours, "sla_health_7d.resolution_target_hours");
  validateSlaBreakdown(sla.first_response, "sla_health_7d.first_response");
  validateSlaBreakdown(sla.resolution, "sla_health_7d.resolution", true);
  assertFiniteNumber(sla.combined_within_target_pct, "sla_health_7d.combined_within_target_pct");
  assertString(sla.first_response_method, "sla_health_7d.first_response_method");
}

function validateAgentPerformance(row: AgentPerformanceRow, prefix: string): void {
  assertFiniteNumber(row.agent_id, `${prefix}.agent_id`);
  assertString(row.agent_name, `${prefix}.agent_name`);
  assertFiniteNumber(row.solved_count_7d, `${prefix}.solved_count_7d`);
  assertFiniteNumber(row.median_resolution_hours, `${prefix}.median_resolution_hours`);
  assertFiniteNumber(row.resolution_within_target_pct, `${prefix}.resolution_within_target_pct`);
  assertFiniteNumber(row.reopen_proxy_count_30d, `${prefix}.reopen_proxy_count_30d`);
  assertFiniteNumber(row.open_backlog_count, `${prefix}.open_backlog_count`);
}

function validateAssignmentLag(lag: AssignmentLag): void {
  assertFiniteNumber(lag.over_30m, "assignment_lag.over_30m");
  assertFiniteNumber(lag.over_2h, "assignment_lag.over_2h");
  assertFiniteNumber(lag.median_unassigned_hours, "assignment_lag.median_unassigned_hours");
  assertArray(lag.oldest_unassigned, "assignment_lag.oldest_unassigned");
  for (let index = 0; index < lag.oldest_unassigned.length; index += 1) {
    validateSnapshotTicket(lag.oldest_unassigned[index], `assignment_lag.oldest_unassigned[${index}]`);
  }
}

function validateGroupWorkload(row: GroupWorkloadRow, prefix: string): void {
  assertFiniteNumber(row.group_id, `${prefix}.group_id`);
  assertString(row.group_name, `${prefix}.group_name`);
  assertFiniteNumber(row.open_count, `${prefix}.open_count`);
  assertFiniteNumber(row.solved_count_7d, `${prefix}.solved_count_7d`);
  assertFiniteNumber(row.high_priority_open_count, `${prefix}.high_priority_open_count`);
}

function validateHighPriorityRisk(ticket: HighPriorityRiskTicket, prefix: string): void {
  assertFiniteNumber(ticket.id, `${prefix}.id`);
  assertString(ticket.subject, `${prefix}.subject`);
  assertString(ticket.status, `${prefix}.status`);
  assertString(ticket.priority, `${prefix}.priority`);
  assertDateString(ticket.created_at, `${prefix}.created_at`);
  assertDateString(ticket.updated_at, `${prefix}.updated_at`);
  assertFiniteNumber(ticket.stale_hours, `${prefix}.stale_hours`);
  if (ticket.assignee_id !== null) {
    assertFiniteNumber(ticket.assignee_id, `${prefix}.assignee_id`);
  }
  assertString(ticket.assignee_name, `${prefix}.assignee_name`);
}

function validateTrendPoint(point: TrendPoint, prefix: string): void {
  assertString(point.date, `${prefix}.date`);
  assertFiniteNumber(point.intake_count, `${prefix}.intake_count`);
  assertFiniteNumber(point.solved_count, `${prefix}.solved_count`);
  assertFiniteNumber(point.backlog_estimate, `${prefix}.backlog_estimate`);
  assertFiniteNumber(point.sla_within_target_pct, `${prefix}.sla_within_target_pct`);
}

function validateAlertMetric(metric: unknown, fieldName: string): void {
  if (!metric || typeof metric !== "object") {
    throw new Error(`Snapshot validation failed: ${fieldName} must be an object.`);
  }

  const candidate = metric as {
    label?: unknown;
    value?: unknown;
    threshold?: unknown;
    active?: unknown;
  };

  assertString(candidate.label, `${fieldName}.label`);
  assertFiniteNumber(candidate.value, `${fieldName}.value`);
  assertFiniteNumber(candidate.threshold, `${fieldName}.threshold`);
  if (typeof candidate.active !== "boolean") {
    throw new Error(`Snapshot validation failed: ${fieldName}.active must be a boolean.`);
  }
}

export function validateSnapshotOrThrow(snapshot: ZendeskSnapshot): void {
  assertFiniteNumber(snapshot.unsolved_count, "unsolved_count");
  assertFiniteNumber(snapshot.daily_tickets.today, "daily_tickets.today");
  assertFiniteNumber(snapshot.daily_tickets.yesterday, "daily_tickets.yesterday");
  assertFiniteNumber(snapshot.daily_tickets.last_7_days, "daily_tickets.last_7_days");

  validateSlaHealth(snapshot.sla_health_7d);
  validateBacklogAging(snapshot.backlog_aging);

  assertArray(snapshot.unassigned_tickets, "unassigned_tickets");
  for (let index = 0; index < snapshot.unassigned_tickets.length; index += 1) {
    validateSnapshotTicket(snapshot.unassigned_tickets[index], `unassigned_tickets[${index}]`);
  }

  assertArray(snapshot.attention_tickets, "attention_tickets");
  for (let index = 0; index < snapshot.attention_tickets.length; index += 1) {
    validateAttentionTicket(snapshot.attention_tickets[index], `attention_tickets[${index}]`);
  }

  assertArray(snapshot.top_solvers, "top_solvers");
  for (let index = 0; index < snapshot.top_solvers.length; index += 1) {
    validateTopSolver(snapshot.top_solvers[index], `top_solvers[${index}]`);
  }

  assertArray(snapshot.agent_audit, "agent_audit");
  for (let index = 0; index < snapshot.agent_audit.length; index += 1) {
    validateAgentSummary(snapshot.agent_audit[index], `agent_audit[${index}]`);
  }

  assertArray(snapshot.all_agents, "all_agents");
  for (let index = 0; index < snapshot.all_agents.length; index += 1) {
    validateAgentSummary(snapshot.all_agents[index], `all_agents[${index}]`);
  }

  assertArray(snapshot.agent_performance_7d, "agent_performance_7d");
  for (let index = 0; index < snapshot.agent_performance_7d.length; index += 1) {
    validateAgentPerformance(snapshot.agent_performance_7d[index], `agent_performance_7d[${index}]`);
  }

  assertArray(snapshot.solved_tickets_7d, "solved_tickets_7d");
  for (let index = 0; index < snapshot.solved_tickets_7d.length; index += 1) {
    validateSolvedTicket(snapshot.solved_tickets_7d[index], `solved_tickets_7d[${index}]`);
  }

  assertArray(snapshot.reopened_tickets_30d, "reopened_tickets_30d");
  for (let index = 0; index < snapshot.reopened_tickets_30d.length; index += 1) {
    validateReopenedTicket(snapshot.reopened_tickets_30d[index], `reopened_tickets_30d[${index}]`);
  }

  validateAssignmentLag(snapshot.assignment_lag);

  assertArray(snapshot.group_workload, "group_workload");
  for (let index = 0; index < snapshot.group_workload.length; index += 1) {
    validateGroupWorkload(snapshot.group_workload[index], `group_workload[${index}]`);
  }

  assertArray(snapshot.high_priority_risk_tickets, "high_priority_risk_tickets");
  for (let index = 0; index < snapshot.high_priority_risk_tickets.length; index += 1) {
    validateHighPriorityRisk(snapshot.high_priority_risk_tickets[index], `high_priority_risk_tickets[${index}]`);
  }

  assertArray(snapshot.trends_30d.points, "trends_30d.points");
  for (let index = 0; index < snapshot.trends_30d.points.length; index += 1) {
    validateTrendPoint(snapshot.trends_30d.points[index], `trends_30d.points[${index}]`);
  }

  assertArray(snapshot.tickets_by_tag, "tickets_by_tag");
  for (let index = 0; index < snapshot.tickets_by_tag.length; index += 1) {
    const tagCount = snapshot.tickets_by_tag[index];
    assertString(tagCount.tag, `tickets_by_tag[${index}].tag`);
    assertFiniteNumber(tagCount.count, `tickets_by_tag[${index}].count`);
  }

  assertString(snapshot.daily_summary.date, "daily_summary.date");
  assertDateString(snapshot.daily_summary.generated_at, "daily_summary.generated_at");
  assertFiniteNumber(snapshot.daily_summary.unsolved_count, "daily_summary.unsolved_count");
  assertFiniteNumber(snapshot.daily_summary.created_today, "daily_summary.created_today");
  assertFiniteNumber(snapshot.daily_summary.solved_count_7d, "daily_summary.solved_count_7d");
  assertFiniteNumber(snapshot.daily_summary.attention_count, "daily_summary.attention_count");
  assertFiniteNumber(snapshot.daily_summary.sla_within_target_pct, "daily_summary.sla_within_target_pct");
  assertFiniteNumber(snapshot.daily_summary.active_alert_count, "daily_summary.active_alert_count");

  if (!snapshot.alerts || typeof snapshot.alerts !== "object") {
    throw new Error("Snapshot validation failed: alerts must be an object.");
  }
  validateAlertMetric(snapshot.alerts.unsolved, "alerts.unsolved");
  validateAlertMetric(snapshot.alerts.attention, "alerts.attention");
  validateAlertMetric(snapshot.alerts.unassigned, "alerts.unassigned");
  assertFiniteNumber(snapshot.alerts.active_count, "alerts.active_count");

  assertDateString(snapshot.generated_at, "generated_at");
  assertFiniteNumber(snapshot.poll_interval_seconds, "poll_interval_seconds");
  assertString(snapshot.window_timezone, "window_timezone");
}
