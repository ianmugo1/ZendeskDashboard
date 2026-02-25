import type { ReactElement } from "react";
import { SolvedAuditPage } from "../../components/solved-audit-page";
import { getInitialSnapshot, parseRefreshSeconds } from "../../lib/snapshot";

function parseSplashDelayMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 7000;
  }
  return Math.max(0, Math.min(8000, Math.round(parsed)));
}

export default async function AuditPage(): Promise<ReactElement> {
  const splashDelayMs = parseSplashDelayMs(process.env.DASHBOARD_SPLASH_MIN_MS);
  if (splashDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, splashDelayMs));
  }
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const refreshSeconds = parseRefreshSeconds(process.env.DASHBOARD_REFRESH_SECONDS);
  const initialSnapshot = await getInitialSnapshot(apiBaseUrl);

  return <SolvedAuditPage initialSnapshot={initialSnapshot} refreshSeconds={refreshSeconds} />;
}
