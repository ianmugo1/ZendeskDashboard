import { NextResponse } from "next/server";
import { getMetricsApiHeaders } from "../../../../lib/metrics-auth";

interface RouteParams {
  params: Promise<{ dataset: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  const apiBaseUrl = process.env.DASHBOARD_API_BASE_URL ?? "http://localhost:4000";
  const resolvedParams = await params;
  const dataset = resolvedParams.dataset;
  const url = new URL(_request.url);
  const includeMetadata = url.searchParams.get("meta") === "1";
  const exportUrl = `${apiBaseUrl}/api/metrics/export/${encodeURIComponent(dataset)}${includeMetadata ? "?meta=1" : ""}`;

  try {
    const response = await fetch(exportUrl, {
      cache: "no-store",
      headers: getMetricsApiHeaders()
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: "Export request failed." }))) as unknown;
      return NextResponse.json(payload, { status: response.status });
    }

    const csv = await response.text();
    const contentDisposition =
      response.headers.get("content-disposition") ?? `attachment; filename="${dataset.replace(/\.csv$/i, "")}.csv"`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": contentDisposition,
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
