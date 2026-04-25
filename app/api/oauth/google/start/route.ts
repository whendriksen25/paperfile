import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { googleAuthUrl } from "@/lib/integrations/google-tasks";

export const runtime = "nodejs";

/**
 * GET /api/oauth/google/start
 *
 * Initiates the OAuth flow. Generates a CSRF state token, stores it in a
 * short-lived signed cookie, then redirects the user to Google's consent
 * screen. The callback validates the cookie matches the state Google
 * echoes back.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  // Random unguessable state — Google echoes it back; we compare to the cookie.
  const state = crypto.randomUUID();

  let url: string;
  try {
    url = googleAuthUrl(request.nextUrl.origin, state);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "OAuth not configured";
    return NextResponse.redirect(
      new URL(`/settings?google_error=${encodeURIComponent(msg)}`, request.url)
    );
  }

  const res = NextResponse.redirect(url);
  res.cookies.set("g_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/oauth/google",
    maxAge: 600, // 10 min
    secure: request.nextUrl.protocol === "https:",
  });
  return res;
}
