import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Dev-only: exchanges a Dropbox OAuth authorization code for access + refresh
 * tokens. Called once to bootstrap the refresh-token-based flow.
 *
 * Body: { code: string }
 * Returns: { access_token, refresh_token, expires_in, ... }
 */
export async function POST(request: NextRequest) {
  if (process.env.DEV_AUTO_LOGIN !== "true") {
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  }
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  }
  const host = (request.headers.get("host") || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") {
    return NextResponse.json({ error: "Localhost only." }, { status: 403 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { code } = await request.json().catch(() => ({}));
  if (!code) return NextResponse.json({ error: "Provide code" }, { status: 400 });

  const clientId = process.env.DROPBOX_APP_KEY;
  const clientSecret = process.env.DROPBOX_APP_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "DROPBOX_APP_KEY / DROPBOX_APP_SECRET missing" },
      { status: 500 }
    );
  }

  const params = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: "Dropbox rejected", dropbox: json }, { status: res.status });
  }

  // Save to a file so we can retrieve the refresh_token without truncation.
  try {
    const { writeFileSync } = await import("fs");
    const path = (await import("path")).default.resolve(
      process.cwd(),
      "dropbox-token-response.json"
    );
    writeFileSync(path, JSON.stringify(json, null, 2), "utf8");
  } catch (e) {
    console.warn("[exchange-dropbox-code] could not write file", e);
  }

  return NextResponse.json({
    ok: true,
    has_refresh_token: Boolean(json.refresh_token),
    has_access_token: Boolean(json.access_token),
    refresh_token_preview: json.refresh_token
      ? json.refresh_token.slice(0, 20) + "…" + json.refresh_token.slice(-10)
      : null,
    refresh_token_length: json.refresh_token?.length || 0,
    expires_in: json.expires_in,
    scope: json.scope,
    saved_to: "dropbox-token-response.json",
  });
}
