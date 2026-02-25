import { NextResponse } from "next/server";
import { getMetricsApiHeaders } from "../../../../lib/metrics-auth";

interface RouteParams {
  params: Promise<{ agentId: string }>;
}

export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const resolvedParams = await params;
  const agentId = resolvedParams.agentId;
  const url = new URL(request.url);
  const windowDays = url.searchParams.get("window_days") ?? "7";
  const metricsUrl = `${apiBaseUrl}/api/metrics/agent/${encodeURIComponent(agentId)}?window_days=${encodeURIComponent(windowDays)}`;

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
