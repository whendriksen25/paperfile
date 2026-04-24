import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Dev auto-login helper — bypasses the manual register/login flow.
 *
 * Only enabled when DEV_AUTO_LOGIN=true in .env.local.
 * When called:
 *   1. Checks if the dev user exists. If not, creates them via admin API.
 *   2. Signs in with their credentials and sets the Supabase auth cookies.
 *   3. Redirects to the `redirect` query param (default: /upload).
 *
 * To return to normal auth: set DEV_AUTO_LOGIN=false (or remove it).
 */
export async function GET(request: NextRequest) {
  console.log("[api/auth/dev-login] start");

  if (process.env.DEV_AUTO_LOGIN !== "true") {
    return NextResponse.json(
      { error: "Dev auto-login is disabled" },
      { status: 403 }
    );
  }

  const email = process.env.DEV_USER_EMAIL;
  const password = process.env.DEV_USER_PASSWORD;
  if (!email || !password) {
    return NextResponse.json(
      {
        error:
          "DEV_USER_EMAIL and DEV_USER_PASSWORD must be set when DEV_AUTO_LOGIN is true",
      },
      { status: 500 }
    );
  }

  const redirectTo = request.nextUrl.searchParams.get("redirect") || "/upload";

  // 1. Ensure the dev user exists
  try {
    const admin = await createServiceClient();
    const { data: existing } = await admin.auth.admin.listUsers();
    const exists = existing?.users?.some((u) => u.email === email);
    if (!exists) {
      console.log("[api/auth/dev-login] creating dev user");
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createErr && !createErr.message.toLowerCase().includes("already")) {
        console.error("[api/auth/dev-login] create failed", createErr);
        return NextResponse.json({ error: createErr.message }, { status: 500 });
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "admin check failed";
    console.error("[api/auth/dev-login] admin error", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // 2. Sign in (this sets auth cookies on the response)
  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr) {
    console.error("[api/auth/dev-login] signin failed", signInErr);
    return NextResponse.json({ error: signInErr.message }, { status: 500 });
  }

  console.log("[api/auth/dev-login] signed in, redirecting to", redirectTo);
  return NextResponse.redirect(new URL(redirectTo, request.nextUrl.origin));
}
