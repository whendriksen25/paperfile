import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { processNextAiChunk } from "@/lib/services/ai-reconcile";

export const runtime = "nodejs";
export const maxDuration = 30; // each call processes ONE chunk

/**
 * POST /api/reconcile-step/[id]
 *
 * Process one AI chunk for the given reconciliation_jobs row, then
 * return progress. The panel polls this endpoint until status='done'.
 *
 * Each call:
 *   - picks the next chunk whose status is 'pending'
 *   - filters candidates against CURRENT unmatched debits (so earlier
 *     chunks' progress is respected)
 *   - calls Claude Haiku (~6-10s)
 *   - applies matches + records suspicions to DB
 *   - updates the job row (completed_chunks, used_id sets)
 *
 * Why this exists: the AI pass for 40+ bills exceeds Vercel's 60s
 * function limit if run all in one HTTP call. One chunk per
 * invocation comfortably fits inside the function timeout.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/reconcile-step] start", id);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = await createServiceClient();
    // Verify the job belongs to the calling user (defense in depth — the
    // service-role client bypasses RLS).
    const { data: job, error } = await admin
      .from("reconciliation_jobs")
      .select("id, user_id, status")
      .eq("id", id)
      .maybeSingle();
    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if ((job as { user_id: string }).user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const step = await processNextAiChunk(admin, id);
    return NextResponse.json(step);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Step failed";
    console.error("[api/reconcile-step] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET — return job status without processing a chunk. Useful for the
 * panel to show "this job is X% done" without firing work. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const admin = await createServiceClient();
    const { data: job, error } = await admin
      .from("reconciliation_jobs")
      .select(
        "id, user_id, status, total_chunks, completed_chunks, ai_matches_applied, ai_matches_flagged, ai_suspicions_recorded, chunks_state, error"
      )
      .eq("id", id)
      .maybeSingle();
    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    if ((job as { user_id: string }).user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(job);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Status fetch failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
