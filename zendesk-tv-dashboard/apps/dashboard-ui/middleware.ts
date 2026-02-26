import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Emerald Park IT Ticket Dashboard"'
    }
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

type DashboardRole = "viewer" | "analyst" | "admin" | "none";

export function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) {
    return true;
  }
  if (pathname === "/favicon.ico") {
    return true;
  }
  return /\.[^/]+$/.test(pathname);
}

function parseBooleanFlag(value: string | undefined, defaultValue: boolean): boolean {
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

export function middleware(request: NextRequest): NextResponse {
  if (isStaticAssetPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const opsUiEnabled = parseBooleanFlag(process.env.OPS_UI_ENABLED, true);
  const isOpsPath = request.nextUrl.pathname === "/ops" || request.nextUrl.pathname.startsWith("/ops/");
  if (isOpsPath && !opsUiEnabled) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const viewerUsername = process.env.DASHBOARD_BASIC_AUTH_USERNAME;
  const viewerPassword = process.env.DASHBOARD_BASIC_AUTH_PASSWORD;
  const analystUsername = process.env.DASHBOARD_ANALYST_AUTH_USERNAME;
  const analystPassword = process.env.DASHBOARD_ANALYST_AUTH_PASSWORD;
  const adminUsername = process.env.DASHBOARD_ADMIN_AUTH_USERNAME;
  const adminPassword = process.env.DASHBOARD_ADMIN_AUTH_PASSWORD;

  if (!viewerUsername || !viewerPassword) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorized();
  }

  const encoded = authHeader.replace("Basic ", "").trim();
  let decoded = "";
  try {
    decoded = atob(encoded);
  } catch {
    return unauthorized();
  }
  const separatorIndex = decoded.indexOf(":");
  const suppliedUsername = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const suppliedPassword = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  const isViewer = safeEqual(suppliedUsername, viewerUsername) && safeEqual(suppliedPassword, viewerPassword);
  const hasAnalystCredentialsConfigured = Boolean(analystUsername && analystPassword);
  const isAnalyst =
    hasAnalystCredentialsConfigured &&
    safeEqual(suppliedUsername, analystUsername as string) &&
    safeEqual(suppliedPassword, analystPassword as string);
  const hasAdminCredentialsConfigured = Boolean(adminUsername && adminPassword);
  const isAdmin =
    hasAdminCredentialsConfigured &&
    safeEqual(suppliedUsername, adminUsername as string) &&
    safeEqual(suppliedPassword, adminPassword as string);

  const role: DashboardRole = isAdmin ? "admin" : isAnalyst ? "analyst" : isViewer ? "viewer" : "none";
  if (role === "none") {
    return unauthorized();
  }

  const requiresAdmin = request.nextUrl.pathname.startsWith("/api/export/");
  const requiresAnalystOrAdmin = request.nextUrl.pathname.startsWith("/api/audit/presets");
  if (requiresAdmin && hasAdminCredentialsConfigured && role !== "admin") {
    return unauthorized();
  }
  if (isOpsPath && !(role === "admin" || role === "analyst")) {
    return unauthorized();
  }
  if (requiresAnalystOrAdmin && (request.method === "POST" || request.method === "DELETE")) {
    if (!(role === "admin" || role === "analyst")) {
      return unauthorized();
    }
  }

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set("x-dashboard-role", role);
  return NextResponse.next({
    request: {
      headers: forwardedHeaders
    }
  });
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|.*\\..*).*)"]
};
