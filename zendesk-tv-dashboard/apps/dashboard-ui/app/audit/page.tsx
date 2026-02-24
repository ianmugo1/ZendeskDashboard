import type { ReactElement } from "react";
import { SolvedAuditPage } from "../../components/solved-audit-page";
import { getInitialSnapshot, parseRefreshSeconds } from "../../lib/snapshot";

export default async function AuditPage(): Promise<ReactElement> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const refreshSeconds = parseRefreshSeconds(process.env.DASHBOARD_REFRESH_SECONDS);
  const initialSnapshot = await getInitialSnapshot(apiBaseUrl);

  return <SolvedAuditPage initialSnapshot={initialSnapshot} refreshSeconds={refreshSeconds} />;
}
