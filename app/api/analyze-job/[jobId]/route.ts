import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 10;

/**
 * GET /api/analyze-job/[jobId]
 *
 * Returns the job's current state — used by the progress panel's poll
 * loop. Side-effect: if status is 'processing' and there's a pending
 * step (or a step is stuck in 'processing' for >90s), fires an
 * un-awaited POST to /api/analyze-step/[jobId] so the worker advances
 * even if the client driver loses interest.
 *
 * Why poll-driven worker advance: the panel already polls; we
 * piggy-back on that to avoid needing a separate background timer.
 * The stuck-step guard catches the edge case where a step's worker
 * crashed mid-flight (the row never flips to 'done' or 'failed'),
 * which would otherwise hang the job forever.
 */
export async function GET(
  request: NextRequest,
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
    const { data: jobRaw, error } = await admin
      .from("analyze_jobs")
      .select(
        "id, user_id, document_id, status, phase, total_crops, completed_crops, steps_state, payload, error, created_at, updated_at"
      )
      .eq("id", jobId)
      .maybeSingle();
    if (error || !jobRaw) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const job = jobRaw as {
      id: string;
      user_id: string;
      document_id: string;
      status: "pending" | "processing" | "done" | "failed";
      phase: string | null;
      total_crops: number;
      completed_crops: number;
      steps_state: Array<{
        index: number;
        status: "pending" | "processing" | "done" | "failed";
        started_at?: string | null;
        completed_at?: string | null;
        child_doc_id?: string | null;
        error?: string | null;
        sender_hint?: string | null;
        amount_hint?: number | null;
      }>;
      payload: {
        from_original?: boolean;
        force_profile?: boolean;
        original_path?: string;
        detected_docs?: Array<{
          sender: string | null;
          amount: number | null;
          document_date: string | null;
          summary: string | null;
        }>;
        boxes?: Array<{ x: number; y: number; w: number; h: number }>;
        crop_paths?: string[];
      };
      error: string | null;
      created_at: string;
      updated_at: string;
    };
    if (job.user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Auto-kick: if processing AND we have a pending step AND no step
    // is currently 'processing' (or one is stuck >90s), nudge the
    // worker. Fire-and-forget — we don't await the response.
    if (job.status === "processing") {
      const steps = job.steps_state || [];
      const hasPending = steps.some((s) => s.status === "pending");
      const inFlight = steps.find((s) => s.status === "processing");
      const stuckMs = 90_000;
      const inFlightAge = inFlight?.started_at
        ? Date.now() - new Date(inFlight.started_at).getTime()
        : 0;
      const isStuck = !!inFlight && inFlightAge > stuckMs;
      if (hasPending && (!inFlight || isStuck)) {
        // Build absolute URL so server-side fetch works (relative paths
        // don't resolve in Node). Forward auth cookies so the step
        // route's service-client + verification still pass.
        const proto =
          request.headers.get("x-forwarded-proto") || "https";
        const host = request.headers.get("host") || "";
        const url = `${proto}://${host}/api/analyze-step/${jobId}`;
        // Forward the user's cookies so the step route can verify
        // ownership (it uses the service client internally but the
        // auth path still works through Supabase's cookie session).
        const cookie = request.headers.get("cookie") || "";
        fetch(url, {
          method: "POST",
          headers: cookie ? { cookie } : undefined,
        }).catch((e) => {
          console.warn(
            "[api/analyze-job] auto-kick of step worker failed:",
            e instanceof Error ? e.message : String(e)
          );
        });
      }
    }

    // For convenience when status=done, expose the spawned child doc ids
    // so the UI can navigate without an extra query.
    const childDocIds =
      job.status === "done"
        ? (job.steps_state || [])
            .filter((s) => s.index !== 0 && s.child_doc_id)
            .map((s) => s.child_doc_id as string)
        : undefined;

    return NextResponse.json({
      id: job.id,
      document_id: job.document_id,
      status: job.status,
      phase: job.phase,
      total_crops: job.total_crops,
      completed_crops: job.completed_crops,
      steps_state: job.steps_state,
      error: job.error,
      payload: {
        detected_docs: job.payload?.detected_docs || [],
        crop_paths: job.payload?.crop_paths || [],
      },
      child_doc_ids: childDocIds,
      created_at: job.created_at,
      updated_at: job.updated_at,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Status fetch failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
