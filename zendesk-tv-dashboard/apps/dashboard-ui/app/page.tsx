import type { ReactElement } from "react";
import { Dashboard } from "../components/dashboard";
import { getInitialSnapshot, parseRefreshSeconds } from "../lib/snapshot";

function parseBooleanFlag(value: string | undefined, defaultValue = true): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export default async function HomePage(): Promise<ReactElement> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const refreshSeconds = parseRefreshSeconds(process.env.DASHBOARD_REFRESH_SECONDS);
  const widgetToggles = {
    topSolvers: parseBooleanFlag(process.env.WIDGETS_TOP_SOLVERS, true),
    ticketsByTag: parseBooleanFlag(process.env.WIDGETS_TICKETS_BY_TAG, true),
    unassigned: parseBooleanFlag(process.env.WIDGETS_UNASSIGNED, true),
    attention: parseBooleanFlag(process.env.WIDGETS_ATTENTION, true),
    dailyVolume: parseBooleanFlag(process.env.WIDGETS_DAILY_VOLUME, true)
  };
  const initialSnapshot = await getInitialSnapshot(apiBaseUrl);

  return <Dashboard initialSnapshot={initialSnapshot} refreshSeconds={refreshSeconds} widgetToggles={widgetToggles} />;
}
