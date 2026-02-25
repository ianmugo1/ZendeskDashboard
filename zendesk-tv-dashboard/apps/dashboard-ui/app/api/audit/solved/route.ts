import { NextResponse } from "next/server";
import { getMetricsApiHeaders } from "../../../../lib/metrics-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request): Promise<NextResponse> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const agentId = url.searchParams.get("agent_id") ?? "all";
  const page = url.searchParams.get("page") ?? "1";
  const pageSize = url.searchParams.get("page_size") ?? "25";
  const metricsUrl = `${apiBaseUrl}/api/metrics/audit/solved?q=${encodeURIComponent(q)}&agent_id=${encodeURIComponent(
    agentId
  )}&page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(pageSize)}`;

  try {
    const response = await fetch(metricsUrl, {
      cache: "no-store",
      headers: getMetricsApiHeaders()
    });

    const payload = (await response.json().catch(() => ({ error: "Invalid API response." }))) as unknown;
    if (!response.ok) {
      return NextResponse.json(payload, { status: response.status });
    }

    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to reach metrics API."
      },
      { status: 502 }
    );
  }
}
