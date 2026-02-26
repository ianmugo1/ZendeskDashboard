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
  SnapshotAlerts,
  SnapshotTicket,
  TopSolver,
  Trend30d,
  TrendPoint,
  ZendeskClient,
  ZendeskGroup,
  ZendeskSnapshot,
  ZendeskTicket,
  ZendeskUser
} from "@zendesk/zendesk-client";
import type { Logger } from "pino";
import type { AlertThresholds, DashboardConfigFile, SlaTargets } from "./config.js";

interface BuildSnapshotParams {
  client: ZendeskClient;
  dashboardConfig: DashboardConfigFile;
  maxTicketScan: number;
  maxSolvedAuditTickets: number;
  maxAgentScan: number;
  pollIntervalSeconds: number;
  includeHeavyData: boolean;
  previousSnapshot: ZendeskSnapshot | null;
  timeZone: string;
  alertThresholds: AlertThresholds;
  slaTargets: SlaTargets;
  highPriorityStaleHours: number;
  directoryCacheTtlSeconds: number;
  logger: Logger;
}

let cachedAgents: { fetchedAtMs: number; users: ZendeskUser[]; maxScan: number } | null = null;
const cachedGroupsByKey = new Map<string, { fetchedAtMs: number; groups: ZendeskGroup[] }>();

async function getAgentDirectory(
  client: ZendeskClient,
  maxAgentScan: number,
  cacheTtlSeconds: number
): Promise<ZendeskUser[]> {
  const nowMs = Date.now();
  if (
    cachedAgents &&
    cachedAgents.maxScan === maxAgentScan &&
    nowMs - cachedAgents.fetchedAtMs <= cacheTtlSeconds * 1000
  ) {
    return cachedAgents.users;
  }
  const users = await client.listAgents(maxAgentScan);
  cachedAgents = { fetchedAtMs: nowMs, users, maxScan: maxAgentScan };
  return users;
}

async function getGroupsDirectory(
  client: ZendeskClient,
  dashboardConfig: DashboardConfigFile,
  cacheTtlSeconds: number
): Promise<ZendeskGroup[]> {
  const configKey =
    dashboardConfig.groupIds.length > 0
      ? `ids:${dashboardConfig.groupIds.slice().sort((a, b) => a - b).join(",")}`
      : "all:500";
  const cached = cachedGroupsByKey.get(configKey);
  const nowMs = Date.now();
  if (cached && nowMs - cached.fetchedAtMs <= cacheTtlSeconds * 1000) {
    return cached.groups;
  }

  const groups =
    dashboardConfig.groupIds.length > 0
      ? await client.getGroupsByIds(dashboardConfig.groupIds).then((groupsMap) => Array.from(groupsMap.values()))
      : await client.listGroups(500);
  cachedGroupsByKey.set(configKey, { fetchedAtMs: nowMs, groups });
  return groups;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function getCalendarDateInTimeZone(date: Date, timeZone: string): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Failed to derive calendar date in timezone: ${timeZone}`);
  }

  return { year, month, day };
}

function shiftCalendarDate(baseDate: CalendarDate, deltaDays: number): CalendarDate {
  const shifted = new Date(Date.UTC(baseDate.year, baseDate.month - 1, baseDate.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function toZendeskDate(date: CalendarDate): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function ageInHours(createdAtIso: string, now: Date): number {
  const createdAtMs = parseDateMs(createdAtIso);
  if (createdAtMs === null) {
    return 0;
  }
  const hours = (now.getTime() - createdAtMs) / (1000 * 60 * 60);
  return Number(Math.max(0, hours).toFixed(1));
}

function staleInHours(updatedAtIso: string, now: Date): number {
  const updatedAtMs = parseDateMs(updatedAtIso);
  if (updatedAtMs === null) {
    return 0;
  }
  const hours = (now.getTime() - updatedAtMs) / (1000 * 60 * 60);
  return Number(Math.max(0, hours).toFixed(1));
}

function normalizeSubject(subject: string | null): string {
  if (!subject || subject.trim().length === 0) {
    return "(No subject)";
  }
  return subject;
}

function isHighPriorityTicket(ticket: ZendeskTicket): boolean {
  const priority = (ticket.priority ?? "").toLowerCase();
  return priority === "high" || priority === "urgent";
}

function mapSnapshotTicket(ticket: ZendeskTicket, now: Date): SnapshotTicket {
  return {
    id: ticket.id,
    subject: normalizeSubject(ticket.subject),
    created_at: ticket.created_at,
    age_hours: ageInHours(ticket.created_at, now)
  };
}

function mapAttentionTicket(ticket: ZendeskTicket, now: Date): AttentionTicket {
  return {
    id: ticket.id,
    subject: normalizeSubject(ticket.subject),
    created_at: ticket.created_at,
    age_hours: ageInHours(ticket.created_at, now),
    priority: ticket.priority ?? "normal",
    status: ticket.status
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(1));
  }
  return Number(sorted[mid].toFixed(1));
}

function toPercent(within: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number(((within / total) * 100).toFixed(1));
}

function resolutionHours(ticket: ZendeskTicket): number | null {
  const start = parseDateMs(ticket.created_at);
  const end = parseDateMs(ticket.solved_at ?? ticket.updated_at);
  if (start === null || end === null || end < start) {
    return null;
  }
  return Number(((end - start) / (1000 * 60 * 60)).toFixed(1));
}

function getDateKeyInTimeZone(date: Date, timeZone: string): string {
  return toZendeskDate(getCalendarDateInTimeZone(date, timeZone));
}

function getDateKeyFromIso(isoDate: string, timeZone: string): string | null {
  const parsedMs = parseDateMs(isoDate);
  if (parsedMs === null) {
    return null;
  }
  return getDateKeyInTimeZone(new Date(parsedMs), timeZone);
}

function buildDateRange(start: CalendarDate, end: CalendarDate): string[] {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  const endDate = new Date(Date.UTC(end.year, end.month - 1, end.day));

  while (cursor.getTime() <= endDate.getTime()) {
    result.push(
      toZendeskDate({
        year: cursor.getUTCFullYear(),
        month: cursor.getUTCMonth() + 1,
        day: cursor.getUTCDate()
      })
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

function incrementCounter(counter: Map<number, number>, key: number): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function buildAlerts(params: {
  unsolvedCount: number;
  attentionCount: number;
  unassignedCount: number;
  thresholds: AlertThresholds;
}): SnapshotAlerts {
  const unsolved = {
    label: "Unsolved tickets",
    value: params.unsolvedCount,
    threshold: params.thresholds.unsolvedWarn,
    active: params.unsolvedCount >= params.thresholds.unsolvedWarn
  };
  const attention = {
    label: "Attention tickets",
    value: params.attentionCount,
    threshold: params.thresholds.attentionWarn,
    active: params.attentionCount >= params.thresholds.attentionWarn
  };
  const unassigned = {
    label: "Unassigned tickets",
    value: params.unassignedCount,
    threshold: params.thresholds.unassignedWarn,
    active: params.unassignedCount >= params.thresholds.unassignedWarn
  };

  return {
    unsolved,
    attention,
    unassigned,
    active_count: [unsolved.active, attention.active, unassigned.active].filter(Boolean).length
  };
}

async function getTagCounts(client: ZendeskClient, tags: string[]): Promise<ZendeskSnapshot["tickets_by_tag"]> {
  const uniqueTags = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
  if (uniqueTags.length === 0) {
    return [];
  }

  const counts = await Promise.all(
    uniqueTags.map(async (tag) => ({
      tag,
      count: await client.searchCount(`type:ticket tags:${tag} -status:solved -status:closed`)
    }))
  );

  return counts.sort((a, b) => b.count - a.count);
}

function collectAssigneeIds(ticketLists: ZendeskTicket[][]): number[] {
  const ids = new Set<number>();
  for (const list of ticketLists) {
    for (const ticket of list) {
      if (ticket.assignee_id) {
        ids.add(ticket.assignee_id);
      }
    }
  }
  return Array.from(ids);
}

function buildAssigneeNameResolver(
  directoryUsers: ZendeskUser[],
  fallbackUsers: Map<number, ZendeskUser>
): Map<number, string> {
  const namesById = new Map<number, string>();
  for (const user of directoryUsers) {
    namesById.set(user.id, user.name);
  }
  for (const [userId, user] of fallbackUsers.entries()) {
    if (!namesById.has(userId)) {
      namesById.set(userId, user.name);
    }
  }
  return namesById;
}

function buildAgentRows(
  namesById: Map<number, string>,
  solvedCountsByAgent: Map<number, number>
): { allAgents: AgentAuditSummary[]; agentAudit: AgentAuditSummary[]; topSolvers: TopSolver[] } {
  const allAgents = Array.from(namesById.entries())
    .map(([agentId, agentName]) => ({
      agent_id: agentId,
      agent_name: agentName,
      solved_count: solvedCountsByAgent.get(agentId) ?? 0
    }))
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name));

  const agentAudit = allAgents
    .filter((agent) => agent.solved_count > 0)
    .sort((a, b) => b.solved_count - a.solved_count || a.agent_name.localeCompare(b.agent_name));

  const topSolvers: TopSolver[] = agentAudit.slice(0, 5).map((agent) => ({
    agent_id: agent.agent_id,
    agent_name: agent.agent_name,
    solved_count: agent.solved_count
  }));

  return { allAgents, agentAudit, topSolvers };
}

function buildBacklogAging(unsolvedTickets: ZendeskTicket[], now: Date): BacklogAgingBuckets {
  let under24h = 0;
  let from1dTo3d = 0;
  let from3dTo7d = 0;
  let over7d = 0;

  for (const ticket of unsolvedTickets) {
    const ageHours = ageInHours(ticket.created_at, now);
    if (ageHours < 24) {
      under24h += 1;
    } else if (ageHours < 72) {
      from1dTo3d += 1;
    } else if (ageHours < 168) {
      from3dTo7d += 1;
    } else {
      over7d += 1;
    }
  }

  return {
    under_24h: under24h,
    from_1d_to_3d: from1dTo3d,
    from_3d_to_7d: from3dTo7d,
    over_7d: over7d,
    total: unsolvedTickets.length
  };
}

function buildAssignmentLag(unsolvedTickets: ZendeskTicket[], now: Date): AssignmentLag {
  const unassigned = unsolvedTickets.filter((ticket) => !ticket.assignee_id);
  const ages = unassigned.map((ticket) => ageInHours(ticket.created_at, now));
  const over30m = ages.filter((hours) => hours > 0.5).length;
  const over2h = ages.filter((hours) => hours > 2).length;
  const oldestUnassigned = [...unassigned]
    .sort((a, b) => ageInHours(b.created_at, now) - ageInHours(a.created_at, now))
    .slice(0, 10)
    .map((ticket) => mapSnapshotTicket(ticket, now));

  return {
    over_30m: over30m,
    over_2h: over2h,
    median_unassigned_hours: median(ages),
    oldest_unassigned: oldestUnassigned
  };
}

function buildSlaHealth(params: {
  createdTicketsLast7d: ZendeskTicket[];
  solvedTicketsLast7d: ZendeskTicket[];
  now: Date;
  slaTargets: SlaTargets;
}): SlaHealth {
  let firstResponseWithin = 0;
  let firstResponseBreached = 0;

  for (const ticket of params.createdTicketsLast7d) {
    const ageHours = ageInHours(ticket.created_at, params.now);
    const withinTarget = Boolean(ticket.assignee_id) || ageHours <= params.slaTargets.firstResponseHours;
    if (withinTarget) {
      firstResponseWithin += 1;
    } else {
      firstResponseBreached += 1;
    }
  }

  let resolutionWithin = 0;
  let resolutionBreached = 0;
  const resolutionValues: number[] = [];

  for (const ticket of params.solvedTicketsLast7d) {
    const hours = resolutionHours(ticket);
    if (hours === null) {
      continue;
    }
    resolutionValues.push(hours);
    if (hours <= params.slaTargets.resolutionHours) {
      resolutionWithin += 1;
    } else {
      resolutionBreached += 1;
    }
  }

  const firstTotal = firstResponseWithin + firstResponseBreached;
  const resolutionTotal = resolutionWithin + resolutionBreached;
  const combinedTotal = firstTotal + resolutionTotal;
  const combinedWithin = firstResponseWithin + resolutionWithin;

  return {
    window_days: 7,
    first_response_target_hours: params.slaTargets.firstResponseHours,
    resolution_target_hours: params.slaTargets.resolutionHours,
    first_response: {
      within_target: firstResponseWithin,
      breached: firstResponseBreached,
      total_evaluated: firstTotal,
      within_target_pct: toPercent(firstResponseWithin, firstTotal)
    },
    resolution: {
      within_target: resolutionWithin,
      breached: resolutionBreached,
      total_evaluated: resolutionTotal,
      within_target_pct: toPercent(resolutionWithin, resolutionTotal),
      median_resolution_hours: median(resolutionValues)
    },
    combined_within_target_pct: toPercent(combinedWithin, combinedTotal),
    first_response_method: "Proxy: assigned within target window from ticket creation."
  };
}

function buildAgentPerformance(params: {
  allAgents: AgentAuditSummary[];
  solvedCountsByAgent: Map<number, number>;
  resolutionHoursByAgent: Map<number, number[]>;
  resolutionWithinByAgent: Map<number, number>;
  resolutionEvaluatedByAgent: Map<number, number>;
  reopenProxyByAgent: Map<number, number>;
  openBacklogByAgent: Map<number, number>;
}): AgentPerformanceRow[] {
  return params.allAgents
    .map((agent) => {
      const agentId = agent.agent_id;
      const solvedCount = params.solvedCountsByAgent.get(agentId) ?? 0;
      const resolutionWithin = params.resolutionWithinByAgent.get(agentId) ?? 0;
      const resolutionTotal = params.resolutionEvaluatedByAgent.get(agentId) ?? 0;
      return {
        agent_id: agentId,
        agent_name: agent.agent_name,
        solved_count_7d: solvedCount,
        median_resolution_hours: median(params.resolutionHoursByAgent.get(agentId) ?? []),
        resolution_within_target_pct: toPercent(resolutionWithin, resolutionTotal),
        reopen_proxy_count_30d: params.reopenProxyByAgent.get(agentId) ?? 0,
        open_backlog_count: params.openBacklogByAgent.get(agentId) ?? 0
      };
    })
    .sort(
      (a, b) =>
        b.solved_count_7d - a.solved_count_7d ||
        b.open_backlog_count - a.open_backlog_count ||
        a.agent_name.localeCompare(b.agent_name)
    );
}

function buildGroupWorkload(params: {
  dashboardConfig: DashboardConfigFile;
  groups: ZendeskGroup[];
  unsolvedTickets: ZendeskTicket[];
  solvedTickets7d: ZendeskTicket[];
}): GroupWorkloadRow[] {
  const openCount = new Map<number, number>();
  const solvedCount = new Map<number, number>();
  const highPriorityOpenCount = new Map<number, number>();

  for (const ticket of params.unsolvedTickets) {
    if (!ticket.group_id) {
      continue;
    }
    incrementCounter(openCount, ticket.group_id);
    if (isHighPriorityTicket(ticket)) {
      incrementCounter(highPriorityOpenCount, ticket.group_id);
    }
  }

  for (const ticket of params.solvedTickets7d) {
    if (!ticket.group_id) {
      continue;
    }
    incrementCounter(solvedCount, ticket.group_id);
  }

  const groupNames = new Map<number, string>();
  for (const group of params.groups) {
    groupNames.set(group.id, group.name);
  }

  const configuredIds = Array.from(new Set(params.dashboardConfig.groupIds.filter((id) => Number.isInteger(id) && id > 0)));
  const detectedIds = Array.from(new Set([...openCount.keys(), ...solvedCount.keys(), ...highPriorityOpenCount.keys()]));

  const targetGroupIds =
    configuredIds.length > 0
      ? configuredIds
      : detectedIds
          .sort((a, b) => (openCount.get(b) ?? 0) - (openCount.get(a) ?? 0) || a - b)
          .slice(0, 12);

  return targetGroupIds.map((groupId) => ({
    group_id: groupId,
    group_name: groupNames.get(groupId) ?? `Group ${groupId}`,
    open_count: openCount.get(groupId) ?? 0,
    solved_count_7d: solvedCount.get(groupId) ?? 0,
    high_priority_open_count: highPriorityOpenCount.get(groupId) ?? 0
  }));
}

function buildHighPriorityRiskTickets(params: {
  unsolvedTickets: ZendeskTicket[];
  namesById: Map<number, string>;
  now: Date;
  staleHoursThreshold: number;
}): HighPriorityRiskTicket[] {
  return params.unsolvedTickets
    .filter((ticket) => isHighPriorityTicket(ticket) && staleInHours(ticket.updated_at, params.now) >= params.staleHoursThreshold)
    .sort((a, b) => staleInHours(b.updated_at, params.now) - staleInHours(a.updated_at, params.now))
    .slice(0, 15)
    .map((ticket) => ({
      id: ticket.id,
      subject: normalizeSubject(ticket.subject),
      status: ticket.status,
      priority: ticket.priority ?? "normal",
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      stale_hours: staleInHours(ticket.updated_at, params.now),
      assignee_id: ticket.assignee_id,
      assignee_name: ticket.assignee_id ? (params.namesById.get(ticket.assignee_id) ?? `Agent ${ticket.assignee_id}`) : "Unassigned"
    }));
}

function buildReopenedTicketAudit(params: {
  reopenedTickets30d: ZendeskTicket[];
  namesById: Map<number, string>;
  now: Date;
  limit: number;
}): ReopenedTicketAudit[] {
  return params.reopenedTickets30d
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, params.limit)
    .map((ticket) => ({
      id: ticket.id,
      subject: normalizeSubject(ticket.subject),
      status: ticket.status,
      priority: ticket.priority ?? "normal",
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      last_solved_at: ticket.solved_at ?? ticket.updated_at,
      assignee_id: ticket.assignee_id,
      assignee_name: ticket.assignee_id ? (params.namesById.get(ticket.assignee_id) ?? `Agent ${ticket.assignee_id}`) : "Unassigned",
      age_hours: ageInHours(ticket.created_at, params.now),
      stale_hours: staleInHours(ticket.updated_at, params.now)
    }));
}

function buildTrends30d(params: {
  startDate: CalendarDate;
  endDate: CalendarDate;
  createdTickets30d: ZendeskTicket[];
  solvedTickets30d: ZendeskTicket[];
  unsolvedCountNow: number;
  timeZone: string;
  resolutionTargetHours: number;
}): Trend30d {
  const days = buildDateRange(params.startDate, params.endDate);
  const intakeByDate = new Map<string, number>();
  const solvedByDate = new Map<string, number>();
  const slaWithinByDate = new Map<string, number>();
  const slaTotalByDate = new Map<string, number>();

  for (const ticket of params.createdTickets30d) {
    const key = getDateKeyFromIso(ticket.created_at, params.timeZone);
    if (!key) {
      continue;
    }
    intakeByDate.set(key, (intakeByDate.get(key) ?? 0) + 1);
  }

  for (const ticket of params.solvedTickets30d) {
    const solvedReference = ticket.solved_at ?? ticket.updated_at;
    const key = getDateKeyFromIso(solvedReference, params.timeZone);
    if (!key) {
      continue;
    }
    solvedByDate.set(key, (solvedByDate.get(key) ?? 0) + 1);
    const resHours = resolutionHours(ticket);
    if (resHours !== null) {
      slaTotalByDate.set(key, (slaTotalByDate.get(key) ?? 0) + 1);
      if (resHours <= params.resolutionTargetHours) {
        slaWithinByDate.set(key, (slaWithinByDate.get(key) ?? 0) + 1);
      }
    }
  }

  const backlogByDate = new Map<string, number>();
  let runningBacklog = params.unsolvedCountNow;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    backlogByDate.set(day, runningBacklog);
    const intake = intakeByDate.get(day) ?? 0;
    const solved = solvedByDate.get(day) ?? 0;
    runningBacklog = Math.max(0, runningBacklog - intake + solved);
  }

  const points: TrendPoint[] = days.map((day) => ({
    date: day,
    intake_count: intakeByDate.get(day) ?? 0,
    solved_count: solvedByDate.get(day) ?? 0,
    backlog_estimate: backlogByDate.get(day) ?? 0,
    sla_within_target_pct: toPercent(slaWithinByDate.get(day) ?? 0, slaTotalByDate.get(day) ?? 0)
  }));

  return { points };
}

export async function buildZendeskSnapshot({
  client,
  dashboardConfig,
  maxTicketScan,
  maxSolvedAuditTickets,
  maxAgentScan,
  pollIntervalSeconds,
  includeHeavyData,
  previousSnapshot,
  timeZone,
  alertThresholds,
  slaTargets,
  highPriorityStaleHours,
  directoryCacheTtlSeconds,
  logger
}: BuildSnapshotParams): Promise<ZendeskSnapshot> {
  const now = new Date();
  const todayDate = getCalendarDateInTimeZone(now, timeZone);
  const yesterdayDate = shiftCalendarDate(todayDate, -1);
  const lastSevenDaysStartDate = shiftCalendarDate(todayDate, -6);
  const lastThirtyDaysStartDate = shiftCalendarDate(todayDate, -29);

  const today = toZendeskDate(todayDate);
  const yesterday = toZendeskDate(yesterdayDate);
  const lastSevenDaysStart = toZendeskDate(lastSevenDaysStartDate);
  const lastThirtyDaysStart = toZendeskDate(lastThirtyDaysStartDate);
  const solvedTicketScanLimit = Math.max(maxTicketScan, maxSolvedAuditTickets);

  if (!includeHeavyData && previousSnapshot) {
    const [unsolvedCount, dailyTodayCount, dailyYesterdayCount, dailyLast7DaysCount, solvedLast7DaysCount, unassignedResponse, attentionResponse] =
      await Promise.all([
        client.searchCount("type:ticket -status:solved -status:closed"),
        client.searchCount(`type:ticket created>=${today}`),
        client.searchCount(`type:ticket created>=${yesterday} created<${today}`),
        client.searchCount(`type:ticket created>=${lastSevenDaysStart}`),
        client.searchCount(`type:ticket solved>=${lastSevenDaysStart}`),
        client.searchTickets("type:ticket assignee:none -status:solved -status:closed", {
          perPage: 10,
          sortBy: "created_at",
          sortOrder: "asc"
        }),
        client.searchTickets("type:ticket status<pending priority>normal", {
          perPage: 15,
          sortBy: "created_at",
          sortOrder: "asc"
        })
      ]);

    const alerts = buildAlerts({
      unsolvedCount,
      attentionCount: attentionResponse.count ?? attentionResponse.results.length,
      unassignedCount: unassignedResponse.count ?? unassignedResponse.results.length,
      thresholds: alertThresholds
    });

    const snapshot: ZendeskSnapshot = {
      unsolved_count: unsolvedCount,
      daily_tickets: {
        today: dailyTodayCount,
        yesterday: dailyYesterdayCount,
        last_7_days: dailyLast7DaysCount
      },
      sla_health_7d: previousSnapshot.sla_health_7d,
      backlog_aging: previousSnapshot.backlog_aging,
      unassigned_tickets: unassignedResponse.results.slice(0, 10).map((ticket) => mapSnapshotTicket(ticket, now)),
      top_solvers: previousSnapshot.top_solvers,
      agent_audit: previousSnapshot.agent_audit,
      all_agents: previousSnapshot.all_agents,
      agent_performance_7d: previousSnapshot.agent_performance_7d,
      solved_tickets_7d: previousSnapshot.solved_tickets_7d,
      reopened_tickets_30d: previousSnapshot.reopened_tickets_30d,
      assignment_lag: previousSnapshot.assignment_lag,
      group_workload: previousSnapshot.group_workload,
      high_priority_risk_tickets: previousSnapshot.high_priority_risk_tickets,
      trends_30d: previousSnapshot.trends_30d,
      attention_tickets: attentionResponse.results.slice(0, 15).map((ticket) => mapAttentionTicket(ticket, now)),
      tickets_by_tag: previousSnapshot.tickets_by_tag,
      daily_summary: {
        date: today,
        generated_at: now.toISOString(),
        unsolved_count: unsolvedCount,
        created_today: dailyTodayCount,
        solved_count_7d: solvedLast7DaysCount,
        attention_count: attentionResponse.results.length,
        sla_within_target_pct: previousSnapshot.sla_health_7d.combined_within_target_pct,
        active_alert_count: alerts.active_count
      },
      alerts,
      snapshot_mode: "light",
      core_generated_at: now.toISOString(),
      heavy_generated_at: previousSnapshot.heavy_generated_at ?? previousSnapshot.generated_at,
      generated_at: now.toISOString(),
      poll_interval_seconds: pollIntervalSeconds,
      window_timezone: timeZone
    };

    logger.debug(
      {
        unsolved_count: snapshot.unsolved_count,
        unassigned_count: snapshot.unassigned_tickets.length,
        attention_count: snapshot.attention_tickets.length,
        active_alert_count: snapshot.alerts.active_count
      },
      "Built lightweight Zendesk snapshot payload"
    );

    return snapshot;
  }

  const [
    unsolvedCount,
    dailyTodayCount,
    dailyYesterdayCount,
    dailyLast7DaysCount,
    unassignedResponse,
    attentionResponse,
    solvedTickets7d,
    unsolvedTickets,
    reopenedTickets30d,
    createdTickets30d,
    solvedTickets30d,
    agentUsers,
    groups,
    ticketsByTag
  ] = await Promise.all([
    client.searchCount("type:ticket -status:solved -status:closed"),
    client.searchCount(`type:ticket created>=${today}`),
    client.searchCount(`type:ticket created>=${yesterday} created<${today}`),
    client.searchCount(`type:ticket created>=${lastSevenDaysStart}`),
    client.searchTickets("type:ticket assignee:none -status:solved -status:closed", {
      perPage: 10,
      sortBy: "created_at",
      sortOrder: "asc"
    }),
    client.searchTickets("type:ticket status<pending priority>normal", {
      perPage: 15,
      sortBy: "created_at",
      sortOrder: "asc"
    }),
    client.searchAllTickets(`type:ticket solved>=${lastSevenDaysStart}`, {
      limit: solvedTicketScanLimit,
      pageSize: 100,
      sortBy: "updated_at",
      sortOrder: "desc"
    }),
    client.searchAllTickets("type:ticket -status:solved -status:closed", {
      limit: maxTicketScan,
      pageSize: 100,
      sortBy: "updated_at",
      sortOrder: "asc"
    }),
    client.searchAllTickets(`type:ticket -status:solved -status:closed solved>=${lastThirtyDaysStart}`, {
      limit: maxTicketScan,
      pageSize: 100,
      sortBy: "updated_at",
      sortOrder: "desc"
    }),
    client.searchAllTickets(`type:ticket created>=${lastThirtyDaysStart}`, {
      limit: maxTicketScan,
      pageSize: 100,
      sortBy: "created_at",
      sortOrder: "asc"
    }),
    client.searchAllTickets(`type:ticket solved>=${lastThirtyDaysStart}`, {
      limit: maxTicketScan,
      pageSize: 100,
      sortBy: "updated_at",
      sortOrder: "desc"
    }),
    getAgentDirectory(client, maxAgentScan, directoryCacheTtlSeconds),
    getGroupsDirectory(client, dashboardConfig, directoryCacheTtlSeconds),
    getTagCounts(client, dashboardConfig.tags)
  ]);

  const assigneeIds = collectAssigneeIds([
    solvedTickets7d,
    unsolvedTickets,
    reopenedTickets30d,
    attentionResponse.results
  ]);
  const knownAgentIds = new Set(agentUsers.map((user) => user.id));
  const missingAssigneeIds = assigneeIds.filter((agentId) => !knownAgentIds.has(agentId));
  const fallbackUsersById = missingAssigneeIds.length > 0 ? await client.getUsersByIds(missingAssigneeIds) : new Map<number, ZendeskUser>();
  const namesById = buildAssigneeNameResolver(agentUsers, fallbackUsersById);

  const solvedCountsByAgent = new Map<number, number>();
  const resolutionHoursByAgent = new Map<number, number[]>();
  const resolutionWithinByAgent = new Map<number, number>();
  const resolutionEvaluatedByAgent = new Map<number, number>();
  const openBacklogByAgent = new Map<number, number>();
  const reopenProxyByAgent = new Map<number, number>();

  for (const ticket of solvedTickets7d) {
    if (!ticket.assignee_id) {
      continue;
    }
    incrementCounter(solvedCountsByAgent, ticket.assignee_id);
    const hours = resolutionHours(ticket);
    if (hours === null) {
      continue;
    }
    const existing = resolutionHoursByAgent.get(ticket.assignee_id) ?? [];
    existing.push(hours);
    resolutionHoursByAgent.set(ticket.assignee_id, existing);
    resolutionEvaluatedByAgent.set(ticket.assignee_id, (resolutionEvaluatedByAgent.get(ticket.assignee_id) ?? 0) + 1);
    if (hours <= slaTargets.resolutionHours) {
      resolutionWithinByAgent.set(ticket.assignee_id, (resolutionWithinByAgent.get(ticket.assignee_id) ?? 0) + 1);
    }
  }

  for (const ticket of unsolvedTickets) {
    if (!ticket.assignee_id) {
      continue;
    }
    incrementCounter(openBacklogByAgent, ticket.assignee_id);
  }

  for (const ticket of reopenedTickets30d) {
    if (!ticket.assignee_id) {
      continue;
    }
    incrementCounter(reopenProxyByAgent, ticket.assignee_id);
  }

  const { allAgents, agentAudit, topSolvers } = buildAgentRows(namesById, solvedCountsByAgent);

  const solvedTicketRows: SolvedTicketAudit[] = solvedTickets7d
    .filter((ticket) => ticket.assignee_id && (ticket.solved_at || ticket.updated_at))
    .sort((a, b) => Date.parse(b.solved_at ?? b.updated_at) - Date.parse(a.solved_at ?? a.updated_at))
    .slice(0, maxSolvedAuditTickets)
    .map((ticket) => ({
      id: ticket.id,
      subject: normalizeSubject(ticket.subject),
      created_at: ticket.created_at,
      solved_at: ticket.solved_at ?? ticket.updated_at,
      assignee_id: ticket.assignee_id as number,
      assignee_name: namesById.get(ticket.assignee_id as number) ?? `Agent ${ticket.assignee_id}`,
      age_hours: ageInHours(ticket.created_at, now)
    }));

  const createdTicketsLast7d = createdTickets30d.filter((ticket) => {
    const createdKey = getDateKeyFromIso(ticket.created_at, timeZone);
    return createdKey !== null && createdKey >= lastSevenDaysStart;
  });

  const slaHealth = buildSlaHealth({
    createdTicketsLast7d,
    solvedTicketsLast7d: solvedTickets7d,
    now,
    slaTargets
  });

  const backlogAging = buildBacklogAging(unsolvedTickets, now);
  const assignmentLag = buildAssignmentLag(unsolvedTickets, now);
  const agentPerformance = buildAgentPerformance({
    allAgents,
    solvedCountsByAgent,
    resolutionHoursByAgent,
    resolutionWithinByAgent,
    resolutionEvaluatedByAgent,
    reopenProxyByAgent,
    openBacklogByAgent
  });
  const groupWorkload = buildGroupWorkload({
    dashboardConfig,
    groups,
    unsolvedTickets,
    solvedTickets7d
  });
  const highPriorityRiskTickets = buildHighPriorityRiskTickets({
    unsolvedTickets,
    namesById,
    now,
    staleHoursThreshold: highPriorityStaleHours
  });
  const reopenedTicketAudit = buildReopenedTicketAudit({
    reopenedTickets30d,
    namesById,
    now,
    limit: Math.min(maxSolvedAuditTickets, 50)
  });
  const trends30d = buildTrends30d({
    startDate: lastThirtyDaysStartDate,
    endDate: todayDate,
    createdTickets30d,
    solvedTickets30d,
    unsolvedCountNow: unsolvedCount,
    timeZone,
    resolutionTargetHours: slaTargets.resolutionHours
  });

  const alerts = buildAlerts({
    unsolvedCount,
    attentionCount: attentionResponse.count ?? attentionResponse.results.length,
    unassignedCount: unassignedResponse.count ?? unassignedResponse.results.length,
    thresholds: alertThresholds
  });

  const snapshot: ZendeskSnapshot = {
    unsolved_count: unsolvedCount,
    daily_tickets: {
      today: dailyTodayCount,
      yesterday: dailyYesterdayCount,
      last_7_days: dailyLast7DaysCount
    },
    sla_health_7d: slaHealth,
    backlog_aging: backlogAging,
    unassigned_tickets: unassignedResponse.results.slice(0, 10).map((ticket) => mapSnapshotTicket(ticket, now)),
    top_solvers: topSolvers,
    agent_audit: agentAudit,
    all_agents: allAgents,
    agent_performance_7d: agentPerformance,
    solved_tickets_7d: solvedTicketRows,
    reopened_tickets_30d: reopenedTicketAudit,
    assignment_lag: assignmentLag,
    group_workload: groupWorkload,
    high_priority_risk_tickets: highPriorityRiskTickets,
    trends_30d: trends30d,
    attention_tickets: attentionResponse.results.slice(0, 15).map((ticket) => mapAttentionTicket(ticket, now)),
    tickets_by_tag: ticketsByTag,
    daily_summary: {
      date: today,
      generated_at: now.toISOString(),
      unsolved_count: unsolvedCount,
      created_today: dailyTodayCount,
      solved_count_7d: solvedTickets7d.length,
      attention_count: attentionResponse.results.length,
      sla_within_target_pct: slaHealth.combined_within_target_pct,
      active_alert_count: alerts.active_count
    },
    alerts,
    snapshot_mode: "heavy",
    core_generated_at: now.toISOString(),
    heavy_generated_at: now.toISOString(),
    generated_at: now.toISOString(),
    poll_interval_seconds: pollIntervalSeconds,
    window_timezone: timeZone
  };

  logger.debug(
    {
      unsolved_count: snapshot.unsolved_count,
      unassigned_count: snapshot.unassigned_tickets.length,
      top_solver_count: snapshot.top_solvers.length,
      audit_agent_count: snapshot.agent_audit.length,
      all_agent_count: snapshot.all_agents.length,
      solved_ticket_audit_count: snapshot.solved_tickets_7d.length,
      reopened_ticket_audit_count: snapshot.reopened_tickets_30d.length,
      group_workload_count: snapshot.group_workload.length,
      risk_ticket_count: snapshot.high_priority_risk_tickets.length,
      trend_point_count: snapshot.trends_30d.points.length,
      attention_count: snapshot.attention_tickets.length,
      tag_count: snapshot.tickets_by_tag.length,
      active_alert_count: snapshot.alerts.active_count
    },
    "Built Zendesk snapshot payload"
  );

  return snapshot;
}
