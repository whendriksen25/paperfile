import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * POST /api/analyze-job/[jobId]/cancel
 *
 * Marks a running analyze job as 'cancelled'. The worker
 * (processNextAnalyzeStep) checks for this status at the start of each
 * step and bails out, and the status-poll endpoint stops auto-kicking
 * the worker. Any children already spawned are left in place — the
 * user can re-analyse the parent to redo the split from scratch.
 *
 * Only pending/processing jobs can be cancelled; done/failed/cancelled
 * jobs return their current state unchanged (idempotent).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
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
      .from("analyze_jobs")
      .select("id, user_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const jobRow = job as { id: string; user_id: string; status: string };
    if (jobRow.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (jobRow.status === "pending" || jobRow.status === "processing") {
      await admin
        .from("analyze_jobs")
        .update({
          status: "cancelled",
          phase: "cancelled",
          error: "Cancelled by user",
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
      console.log(`[api/analyze-job/cancel] job ${jobId} cancelled by user`);
      return NextResponse.json({ status: "cancelled" });
    }

    // Already terminal — nothing to do.
    return NextResponse.json({ status: jobRow.status });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Cancel failed";
    console.error("[api/analyze-job/cancel] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
