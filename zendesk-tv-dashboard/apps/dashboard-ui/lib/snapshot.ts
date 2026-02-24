import type { ZendeskSnapshot } from "@zendesk/zendesk-client";

export function parseRefreshSeconds(value: string | undefined): number {
  if (!value) {
    return 20;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 20;
  }
  return Math.max(5, parsed);
}

export async function getInitialSnapshot(apiBaseUrl: string): Promise<ZendeskSnapshot | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/metrics/snapshot`, {
      cache: "no-store"
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ZendeskSnapshot;
  } catch {
    return null;
  }
}
