import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/documents/[id]/confirm-profile
 *
 * Marks a doc's profile assignment as user-confirmed: clears needs_review
 * without changing the actual profile_id. Used by the per-card "Confirm"
 * button when the AI's suggestion was correct and the user just wants to
 * acknowledge it (instead of going through the full RefileWidget).
 *
 * If the user wants to CHANGE the profile, they use /refile instead —
 * that one moves the file in storage too.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("documents")
    .update({ needs_review: false })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
