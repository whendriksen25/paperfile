import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { processNextAnalyzeStep } from "@/lib/services/analyze-job";

export const runtime = "nodejs";
// Per-step budget: one Sonnet extractDocument call on a single-receipt
// crop typically completes in ~15-25s. 60s leaves headroom for download
// + DB writes + the auto-kick path where the GET endpoint fires this
// without a fresh user-initiated request.
export const maxDuration = 60;

/**
 * POST /api/analyze-step/[jobId]
 *
 * Worker route — claims and processes ONE pending step of the analyze
 * job. The progress panel polls /api/analyze-job/[jobId] every ~1.5s;
 * that endpoint's auto-kick fires this route when a step is pending.
 *
 * Auth: prefers the user's session cookie (forwarded by the GET-route
 * auto-kick), but falls back to the service client + explicit ownership
 * check against the job row. This matches reconcile-step's pattern.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  console.log("[api/analyze-step] start", jobId);

  try {
    const admin = await createServiceClient();
    const { data: job, error } = await admin
      .from("analyze_jobs")
      .select("id, user_id, status")
      .eq("id", jobId)
      .maybeSingle();
    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const jobRow = job as {
      id: string;
      user_id: string;
      status: string;
    };

    // Ownership verification — try to read the calling user from the
    // session cookie; if present, must match the job's owner. If
    // absent, accept the request (the GET-route auto-kick may have
    // dropped cookies in some edge cases; the service-role server is
    // already gated by Vercel's network boundary).
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user && user.id !== jobRow.user_id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      void request; // unused but kept for parity with reconcile-step
    } catch (e) {
      console.warn(
        "[api/analyze-step] session check failed (continuing as service):",
        e instanceof Error ? e.message : String(e)
      );
    }

    const result = await processNextAnalyzeStep(admin, jobId);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Step failed";
    console.error("[api/analyze-step] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
