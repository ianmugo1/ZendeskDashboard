import type { ReactElement } from "react";
import { Dashboard } from "../components/dashboard";
import { getInitialSnapshot, parseRefreshSeconds, parseStaleWarningSeconds } from "../lib/snapshot";

function parseSplashDelayMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 6000;
  }
  return Math.max(0, Math.min(15000, Math.round(parsed)));
}

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
  const splashDelayMs = parseSplashDelayMs(process.env.DASHBOARD_SPLASH_MIN_MS);
  if (splashDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, splashDelayMs));
  }
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const refreshSeconds = parseRefreshSeconds(process.env.DASHBOARD_REFRESH_SECONDS);
  const staleWarningSeconds = parseStaleWarningSeconds(process.env.DASHBOARD_STALE_WARNING_SECONDS, refreshSeconds);
  const widgetToggles = {
    topSolvers: parseBooleanFlag(process.env.WIDGETS_TOP_SOLVERS, true),
    ticketsByTag: parseBooleanFlag(process.env.WIDGETS_TICKETS_BY_TAG, true),
    unassigned: parseBooleanFlag(process.env.WIDGETS_UNASSIGNED, true),
    attention: parseBooleanFlag(process.env.WIDGETS_ATTENTION, true),
    dailyVolume: parseBooleanFlag(process.env.WIDGETS_DAILY_VOLUME, true)
  };
  const opsUiEnabled = parseBooleanFlag(process.env.OPS_UI_ENABLED, true);
  const initialSnapshot = await getInitialSnapshot(apiBaseUrl);

  return (
    <Dashboard
      initialSnapshot={initialSnapshot}
      refreshSeconds={refreshSeconds}
      staleWarningSeconds={staleWarningSeconds}
      opsUiEnabled={opsUiEnabled}
      widgetToggles={widgetToggles}
    />
  );
}
