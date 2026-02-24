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

export function middleware(request: NextRequest): NextResponse {
  const username = process.env.DASHBOARD_BASIC_AUTH_USERNAME;
  const password = process.env.DASHBOARD_BASIC_AUTH_PASSWORD;

  if (!username || !password) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorized();
  }

  const encoded = authHeader.replace("Basic ", "").trim();
  const decoded = atob(encoded);
  const separatorIndex = decoded.indexOf(":");
  const suppliedUsername = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
  const suppliedPassword = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  if (suppliedUsername !== username || suppliedPassword !== password) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
