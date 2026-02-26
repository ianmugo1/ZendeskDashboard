import type { ZendeskSnapshot } from "@zendesk/zendesk-client";
import { getMetricsApiHeaders } from "./metrics-auth";

export function parseRefreshSeconds(value: string | undefined): number {
  if (!value) {
    return 900;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 900;
  }
  return Math.max(5, parsed);
}

export function parseStaleWarningSeconds(value: string | undefined, refreshSeconds: number): number {
  if (!value) {
    return Math.max(refreshSeconds * 3, 300);
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return Math.max(refreshSeconds * 3, 300);
  }
  return Math.max(30, parsed);
}

export async function getInitialSnapshot(apiBaseUrl: string): Promise<ZendeskSnapshot | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/metrics/snapshot`, {
      cache: "no-store",
      headers: getMetricsApiHeaders()
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ZendeskSnapshot;
  } catch {
    return null;
  }
}
