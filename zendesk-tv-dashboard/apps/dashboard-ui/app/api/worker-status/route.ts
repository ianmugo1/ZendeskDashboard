import { NextResponse } from "next/server";
import { getMetricsApiHeaders } from "../../../lib/metrics-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";

  try {
    const response = await fetch(`${apiBaseUrl}/api/metrics/worker-status`, {
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
