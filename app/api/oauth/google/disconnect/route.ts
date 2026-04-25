import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { disconnectGoogle } from "@/lib/integrations/google-tasks";

export const runtime = "nodejs";

/**
 * POST /api/oauth/google/disconnect
 * Revokes the stored refresh token at Google and clears local settings.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await disconnectGoogle(user.id);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Disconnect failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
