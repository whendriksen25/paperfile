import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reconcileBankStatement } from "@/lib/services/bank-reconciliation";
import { prepareAiReconcileJob } from "@/lib/services/ai-reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/reconcile
 *
 * Re-runs bank-statement reconciliation against the latest open `pay`
 * actions. Reads transactions from `bank_transactions` (the table is
 * the source of truth — not in-memory state, not the JSON shadow on
 * the doc). Use after refiling, after correcting a wrong action, or
 * when new pay actions have appeared since the last run.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/[id]/reconcile] start", id);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = await createServiceClient();
    const { data: doc, error } = await admin
      .from("documents")
      .select("id, document_type, extracted_fields, user_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (doc.document_type !== "bank_statement") {
      return NextResponse.json(
        { error: "This doc is not a bank statement" },
        { status: 400 }
      );
    }

    const r = await reconcileBankStatement(admin, user.id, id);

    // Prepare the AI background job — does NOT run the AI here. The
    // job tracker is created with all chunks pending, and the panel
    // drives the per-chunk processing via /api/reconcile-step/[id]
    // polling. This is the only way to stay inside Vercel's 60s
    // function limit on real statements (>30 bills, hundreds of
    // candidate debits).
    let aiJob;
    try {
      aiJob = await prepareAiReconcileJob(admin, user.id, id);
    } catch (e) {
      console.warn("[reconcile] AI job prepare failed (continuing):", e);
      aiJob = { error: e instanceof Error ? e.message : String(e), job_id: null, total_chunks: 0 };
    }

    // Mirror the deterministic summary into extracted_fields. The AI
    // sub-block gets filled in when the job's last chunk completes.
    await admin
      .from("documents")
      .update({
        extracted_fields: {
          ...(doc.extracted_fields || {}),
          _reconciliation: {
            ran_at: new Date().toISOString(),
            ...r,
            ai_job: aiJob && "job_id" in aiJob ? {
              job_id: aiJob.job_id,
              total_chunks: aiJob.total_chunks,
              status: aiJob.job_id ? "pending" : "skipped",
              skipped: "skipped" in aiJob ? aiJob.skipped : undefined,
            } : aiJob,
          },
        },
      })
      .eq("id", id);

    return NextResponse.json({ ok: true, result: r, ai_job: aiJob });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Reconcile failed";
    console.error("[api/documents/[id]/reconcile] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
