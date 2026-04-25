import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Count of documents that landed without a confident profile match (or were
 * explicitly flagged for human review). Drives the "Needs review" banner on
 * the inbox so unassigned scans never get hidden behind an active profile
 * filter — they're always one click away from triage.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .neq("status", "deleted")
    .or("primary_profile_id.is.null,needs_review.eq.true");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ count: count || 0 });
}
