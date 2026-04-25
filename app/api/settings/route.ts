import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserSettings, saveUserSettings } from "@/lib/services/user-settings";

export const runtime = "nodejs";

/** GET — returns the current user's settings (no secrets logged). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = await getUserSettings(supabase, user.id);
  return NextResponse.json({ data: settings });
}

/** PATCH — merges the provided fields onto the user's settings row. */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(body, "bookkeeping_url")) {
    const v = body.bookkeeping_url;
    patch.bookkeeping_url =
      typeof v === "string" ? v.trim().replace(/\/+$/, "") || null : null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "bookkeeping_token")) {
    const v = body.bookkeeping_token;
    patch.bookkeeping_token = typeof v === "string" ? v.trim() || null : null;
  }

  const next = await saveUserSettings(supabase, user.id, patch);
  return NextResponse.json({ data: next });
}
