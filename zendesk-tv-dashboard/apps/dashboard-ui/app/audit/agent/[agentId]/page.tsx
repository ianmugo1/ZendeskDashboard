import type { ReactElement } from "react";
import { AgentDetailPage } from "../../../../components/agent-detail-page";
import { getInitialAgentDetail } from "../../../../lib/agent-detail";
import { parseRefreshSeconds } from "../../../../lib/snapshot";

interface AgentDetailRouteProps {
  params: Promise<{ agentId: string }>;
  searchParams?: Promise<{ window_days?: string }>;
}

function parseSplashDelayMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 7000;
  }
  return Math.max(0, Math.min(8000, Math.round(parsed)));
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

export default async function AgentAuditDetailPage({ params, searchParams }: AgentDetailRouteProps): Promise<ReactElement> {
  const splashDelayMs = parseSplashDelayMs(process.env.DASHBOARD_SPLASH_MIN_MS);
  if (splashDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, splashDelayMs));
  }

  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const refreshSeconds = parseRefreshSeconds(process.env.DASHBOARD_REFRESH_SECONDS);
  const resolvedParams = await params;
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const agentId = Number.parseInt(resolvedParams.agentId, 10);
  const initialWindowDays = parseWindowDays(resolvedSearchParams.window_days);
  const initialData =
    Number.isInteger(agentId) && agentId > 0
      ? await getInitialAgentDetail(apiBaseUrl, agentId, String(initialWindowDays))
      : null;

  return (
    <AgentDetailPage
      initialData={initialData}
      agentId={Number.isInteger(agentId) && agentId > 0 ? agentId : 0}
      initialWindowDays={initialWindowDays}
      refreshSeconds={refreshSeconds}
    />
  );
}
