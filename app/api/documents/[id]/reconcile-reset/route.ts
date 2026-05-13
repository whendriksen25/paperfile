import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reconcileBankStatement } from "@/lib/services/bank-reconciliation";
import { prepareAiReconcileJob } from "@/lib/services/ai-reconcile";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/reconcile-reset
 *
 * Destructive variant of /reconcile: re-opens every pay-action this
 * statement previously closed, clears the paid-status on the source
 * docs, then runs the full reconcile flow (deterministic + AI). The
 * effect is "redo everything from scratch, including the matches we'd
 * already accepted".
 *
 * Surgical scope — only actions whose maintenance_log entry tags
 * statement_doc_id == THIS statement are touched. An action closed by
 * a different statement (or manually) is left alone. Use this when:
 *   - you don't trust the prior matches and want a fresh evaluation
 *   - you've materially changed the source docs or pay-actions and want
 *     the matcher to reconsider with the new information
 *   - you're debugging the matcher
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/[id]/reconcile-reset] start", id);

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

    // 1. Find every (action_id, document_id) this statement previously
    // closed. maintenance_log is the canonical record of reconcile-driven
    // closures, regardless of whether the close came from the
    // deterministic matcher, the AI fallback, or a user-confirmed
    // suspicion — they all write entries with kind='bank_reconcile'.
    const { data: logRows, error: logErr } = await admin
      .from("maintenance_log")
      .select("payload")
      .eq("kind", "bank_reconcile")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (logErr) throw logErr;
    const actionIds = new Set<string>();
    const docIds = new Set<string>();
    for (const r of logRows || []) {
      const p = (r as { payload: Record<string, unknown> | null }).payload;
      if (!p) continue;
      if (p.statement_doc_id !== id) continue;
      if (typeof p.action_id === "string") actionIds.add(p.action_id);
      if (typeof p.document_id === "string") docIds.add(p.document_id);
    }

    let reopenedActions = 0;
    let restoredDocs = 0;

    // 2. Re-open the actions.
    if (actionIds.size > 0) {
      const { error: aErr, count } = await admin
        .from("actions")
        .update(
          { status: "open", completed_at: null, notes: null },
          { count: "exact" }
        )
        .in("id", Array.from(actionIds));
      if (aErr) throw aErr;
      reopenedActions = count || 0;
    }

    // 3. Clear payment_status on each source doc. Has to be per-row
    // because extracted_fields is JSONB and we're deleting specific keys.
    for (const docId of Array.from(docIds)) {
      const { data: srcDoc } = await admin
        .from("documents")
        .select("extracted_fields")
        .eq("id", docId)
        .single();
      if (!srcDoc) continue;
      const ef = {
        ...((srcDoc as { extracted_fields: Record<string, unknown> | null })
          .extracted_fields || {}),
      };
      delete (ef as Record<string, unknown>).payment_status;
      delete (ef as Record<string, unknown>).paid_date;
      delete (ef as Record<string, unknown>).paid_note;
      const { error: dErr } = await admin
        .from("documents")
        .update({ extracted_fields: ef })
        .eq("id", docId);
      if (!dErr) restoredDocs++;
    }

    console.log(
      `[reconcile-reset] reopened ${reopenedActions} actions, restored ${restoredDocs} docs`
    );

    // 4. Run deterministic reconcile (fast) + prepare the AI background
    // job (does NOT run AI here — the panel drives the per-chunk
    // worker route after this returns).
    const r = await reconcileBankStatement(admin, user.id, id);
    let aiJob;
    try {
      aiJob = await prepareAiReconcileJob(admin, user.id, id);
    } catch (e) {
      console.warn("[reconcile-reset] AI job prepare failed (continuing):", e);
      aiJob = { error: e instanceof Error ? e.message : String(e), job_id: null, total_chunks: 0 };
    }

    // 5. Mirror the summary into extracted_fields like the regular route.
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
            reset: {
              reopened_actions: reopenedActions,
              restored_docs: restoredDocs,
            },
          },
        },
      })
      .eq("id", id);

    return NextResponse.json({
      ok: true,
      reopened_actions: reopenedActions,
      restored_docs: restoredDocs,
      result: r,
      ai_job: aiJob,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Reset failed";
    console.error("[api/documents/[id]/reconcile-reset] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
