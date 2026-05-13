import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/bank-transactions/[id]/suspicion-action
 *
 * Body: { action: "confirm" | "dismiss", possible_doc_id?: string }
 *
 * - confirm: turn a suspicion into a matched row. Looks up the action
 *   tied to `possible_doc_id`, closes it, stamps matched_* on this tx,
 *   logs to maintenance_log.
 * - dismiss: clear the suspicions array on this row. The tx stays
 *   match_status='unmatched' but the suspicions list is gone so the
 *   panel stops surfacing it.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: txId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    possible_doc_id?: string;
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await createServiceClient();
  const { data: tx, error: txErr } = await admin
    .from("bank_transactions")
    .select(
      "id, user_id, statement_id, amount, booking_date, counterparty_name, counterparty_iban, reference, suspicions"
    )
    .eq("id", txId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (txErr || !tx) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.action === "dismiss") {
    const { error } = await admin
      .from("bank_transactions")
      .update({ suspicions: null })
      .eq("id", txId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, dismissed: true });
  }

  if (body.action === "confirm") {
    if (!body.possible_doc_id) {
      return NextResponse.json(
        { error: "possible_doc_id required" },
        { status: 400 }
      );
    }
    // Look up the open pay-action attached to that doc.
    const { data: action, error: aErr } = await admin
      .from("actions")
      .select("id, document_id")
      .eq("document_id", body.possible_doc_id)
      .eq("user_id", user.id)
      .eq("action_type", "pay")
      .eq("status", "open")
      .maybeSingle();
    if (aErr || !action) {
      return NextResponse.json(
        { error: "No open pay-action found for that document" },
        { status: 400 }
      );
    }
    const now = new Date().toISOString();
    const reason = `User-confirmed AI suspicion → bill ${body.possible_doc_id.slice(0, 8)}`;

    await admin
      .from("actions")
      .update({
        status: "done",
        completed_at: now,
        notes: reason,
      })
      .eq("id", action.id);

    // Mark source doc paid
    const { data: srcDoc } = await admin
      .from("documents")
      .select("extracted_fields")
      .eq("id", action.document_id)
      .single();
    const sourceEf = (srcDoc?.extracted_fields || {}) as Record<
      string,
      unknown
    >;
    await admin
      .from("documents")
      .update({
        extracted_fields: {
          ...sourceEf,
          payment_status: "paid",
          paid_date: tx.booking_date,
          paid_note: reason,
        },
      })
      .eq("id", action.document_id);

    await admin
      .from("bank_transactions")
      .update({
        matched_action_id: action.id,
        matched_document_id: action.document_id,
        matched_at: now,
        match_reason: reason,
        match_status: "matched",
        match_method: "manual",
        match_confidence: 1.0,
        suspicions: null,
      })
      .eq("id", txId);

    await admin.from("maintenance_log").insert({
      user_id: user.id,
      document_id: action.document_id,
      kind: "bank_reconcile",
      reason,
      payload: {
        statement_doc_id: tx.statement_id,
        bank_transaction_id: txId,
        action_id: action.id,
        method: "manual",
        amount: tx.amount,
        counterparty: tx.counterparty_name,
        booking_date: tx.booking_date,
      },
    });

    return NextResponse.json({ ok: true, matched_action_id: action.id });
  }

  return NextResponse.json(
    { error: 'Invalid action — expected "confirm" or "dismiss"' },
    { status: 400 }
  );
}
