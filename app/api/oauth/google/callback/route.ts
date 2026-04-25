import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { saveUserSettings } from "@/lib/services/user-settings";
import {
  exchangeCodeForTokens,
  emailFromIdToken,
} from "@/lib/integrations/google-tasks";

export const runtime = "nodejs";

/**
 * GET /api/oauth/google/callback
 *
 * Google redirects here after the user clicks Allow / Deny.
 *  - Validates the state cookie matches what Google echoed back (CSRF guard).
 *  - Exchanges the auth code for refresh + access tokens.
 *  - Stores the refresh token (+ display email) on the current user's settings.
 *  - Redirects back to /settings with a success/error flag.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const errorParam = sp.get("error");

  const expectedState = request.cookies.get("g_oauth_state")?.value || null;

  // Always clear the state cookie regardless of outcome
  function redirect(qs: string) {
    const url = new URL(`/settings?${qs}`, request.url);
    const res = NextResponse.redirect(url);
    res.cookies.delete("g_oauth_state");
    return res;
  }

  if (errorParam) {
    return redirect(`google_error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !state) {
    return redirect("google_error=Missing+code+or+state");
  }
  if (!expectedState || expectedState !== state) {
    return redirect("google_error=State+mismatch");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  try {
    const tok = await exchangeCodeForTokens(code, request.nextUrl.origin);
    const email = emailFromIdToken(tok.id_token);
    await saveUserSettings(supabase, user.id, {
      google_oauth: {
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
        email,
        task_list_id: null, // populated lazily on first push
      },
    });
    return redirect("google_connected=1");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "OAuth exchange failed";
    return redirect(`google_error=${encodeURIComponent(msg)}`);
  }
}
