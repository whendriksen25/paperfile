import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reconcileBankStatement } from "@/lib/services/bank-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/reconcile
 *
 * Re-runs bank-statement reconciliation for the given doc using the
 * line_items already saved in extracted_fields. Use this after refiling,
 * after correcting a mismatched action, or just to retry if more actions
 * have appeared since the original analyze run.
 *
 * Returns the same { matched, ambiguous, unmatched, considered } summary
 * the auto-trigger writes to extracted_fields._reconciliation.
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

    const ef = (doc.extracted_fields || {}) as Record<string, unknown>;
    const items = ((ef["line_items"] as unknown) ||
      []) as Array<Record<string, unknown>>;

    const transactions = items
      .map((it) => {
        const totalRaw = it["total"];
        let total = typeof totalRaw === "number" ? totalRaw : Number(totalRaw);
        if (!Number.isFinite(total)) return null;
        const cdtDbt = (it["cdt_dbt"] as string | undefined) || null;
        if (cdtDbt === "DBIT" && total > 0) total = -total;
        if (cdtDbt === "CRDT" && total < 0) total = -total;
        return {
          amount: total,
          currency: (it["currency"] as string | undefined) || null,
          booking_date:
            (it["booking_date"] as string | undefined) ||
            (it["transaction_date"] as string | undefined) ||
            null,
          value_date:
            (it["value_date"] as string | undefined) ||
            (it["transaction_date"] as string | undefined) ||
            null,
          counterparty_name:
            (it["counterparty_name"] as string | undefined) ||
            (it["description"] as string | undefined) ||
            null,
          counterparty_iban:
            (it["counterparty_iban"] as string | undefined) || null,
          reference:
            (it["reference"] as string | undefined) ||
            (it["description"] as string | undefined) ||
            null,
          transaction_id:
            (it["transaction_id"] as string | undefined) || null,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const r = await reconcileBankStatement(admin, user.id, id, transactions);

    // Persist updated summary
    await admin
      .from("documents")
      .update({
        extracted_fields: {
          ...ef,
          _reconciliation: { ran_at: new Date().toISOString(), ...r },
        },
      })
      .eq("id", id);

    return NextResponse.json({ ok: true, result: r });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Reconcile failed";
    console.error("[api/documents/[id]/reconcile] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
