import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  // This is only the optimistic navigation check. Every API verifies the database session.
  const token = request.cookies.get("instaloom_session")?.value;
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/inbox/:path*", "/settings/:path*", "/post/:path*", "/story/:path*"] };
