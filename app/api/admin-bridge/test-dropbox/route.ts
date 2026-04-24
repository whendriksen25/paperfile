import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createDropbox } from "@/lib/dropbox/client";

export const runtime = "nodejs";

/**
 * Dev-only: tests the configured Dropbox access token by calling
 * dbx.usersGetCurrentAccount(). Returns the account email on success, the
 * Dropbox error status+text on failure. Gated same as /api/admin-bridge/sql.
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const dbx = createDropbox();
    const account = await dbx.usersGetCurrentAccount();
    return NextResponse.json({
      ok: true,
      email: account.result.email,
      name: account.result.name?.display_name,
      token_first8: (process.env.DROPBOX_ACCESS_TOKEN || "").slice(0, 8),
      token_length: (process.env.DROPBOX_ACCESS_TOKEN || "").length,
    });
  } catch (e: unknown) {
    const err = e as { status?: number; error?: unknown; message?: string };
    return NextResponse.json({
      ok: false,
      dropbox_status: err.status || null,
      dropbox_error: err.error || err.message || "unknown",
      token_first8: (process.env.DROPBOX_ACCESS_TOKEN || "").slice(0, 8),
      token_length: (process.env.DROPBOX_ACCESS_TOKEN || "").length,
    });
  }
}
