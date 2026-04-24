import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Record<string, unknown>)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Public routes
  const publicRoutes = ["/login", "/register", "/reset-password"];
  const isPublicRoute =
    publicRoutes.some((route) => pathname.startsWith(route)) ||
    pathname.startsWith("/api/shortcut") || // iOS Shortcut endpoint uses its own token auth
    pathname.startsWith("/api/auth/dev-login"); // dev-login needs to be reachable unauthenticated

  const devAutoLogin = process.env.DEV_AUTO_LOGIN === "true";

  // Unauthenticated + protected path
  if (!user && !isPublicRoute && !pathname.startsWith("/api/")) {
    const url = request.nextUrl.clone();
    if (devAutoLogin) {
      // Skip the login page entirely — go straight through dev-login
      url.pathname = "/api/auth/dev-login";
      url.searchParams.set("redirect", pathname);
    } else {
      url.pathname = "/login";
    }
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from auth pages
  if (user && (pathname === "/login" || pathname === "/register")) {
    const url = request.nextUrl.clone();
    url.pathname = "/upload";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
