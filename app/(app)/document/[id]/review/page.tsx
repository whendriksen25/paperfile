import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ReviewQueue } from "@/components/inbox/review-queue";
import { compareTxToBill } from "@/lib/services/reconcile-compare";
import type { ReviewItem, ReviewBill } from "@/components/inbox/review-queue";

export const dynamic = "force-dynamic";

/** Pull a plausible IBAN out of an extracted_fields blob. */
function extractIban(ef: Record<string, unknown> | null | undefined): string | null {
  if (!ef) return null;
  const direct =
    (ef["payment_iban"] as string | undefined) ||
    (ef["iban"] as string | undefined) ||
    (ef["account_iban"] as string | undefined);
  if (typeof direct === "string") {
    const c = direct.replace(/\s+/g, "");
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i.test(c)) return c.toUpperCase();
  }
  const re = /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/i;
  for (const v of Object.values(ef)) {
    if (typeof v === "string") {
      const m = v.replace(/\s+/g, "").match(re);
      if (m) return m[0].toUpperCase();
    }
  }
  return null;
}
function extractRef(ef: Record<string, unknown> | null | undefined): string | null {
  if (!ef) return null;
  for (const k of [
    "payment_reference",
    "invoice_number",
    "factuurnummer",
    "reference",
    "customer_reference",
    "betalingskenmerk",
  ]) {
    const v = ef[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Suspicion review queue for one bank statement.
 *
 * Walks every bank transaction the AI pass flagged as a "suspicion"
 * (low-confidence possible match) and lets the user book it against a
 * bill or dismiss it. Each item shows the transaction on the left and
 * candidate bills on the right, with deterministic comparison signals
 * (amount Δ, date Δ, sender/IBAN/reference) so the user can see *why*
 * it was flagged, not just the AI's prose.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, document_type, sender, document_date")
    .eq("id", id)
    .maybeSingle();
  if (error || !doc) notFound();
  if (doc.document_type !== "bank_statement") notFound();

  // 1. Load every transaction on this statement that has suspicions.
  const PAGE = 1000;
  type TxRow = {
    id: string;
    amount: number;
    currency: string | null;
    booking_date: string | null;
    value_date: string | null;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    reference: string | null;
    description: string | null;
    match_status: string | null;
    suspicions:
      | Array<{
          possible_action_ids?: string[];
          possible_doc_ids?: string[];
          reasoning: string;
          confidence: number;
        }>
      | null;
  };
  const txRows: TxRow[] = [];
  let offset = 0;
  for (let i = 0; i < 50; i++) {
    const { data: pageData } = await supabase
      .from("bank_transactions")
      .select(
        "id, amount, currency, booking_date, value_date, counterparty_name, counterparty_iban, reference, description, match_status, suspicions"
      )
      .eq("statement_id", id)
      .not("suspicions", "is", null)
      .order("position", { ascending: true })
      .range(offset, offset + PAGE - 1);
    const rows = (pageData || []) as TxRow[];
    txRows.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  // Only ones still unresolved (not matched) with a non-empty suspicions array.
  const flagged = txRows.filter(
    (t) =>
      t.match_status !== "matched" &&
      Array.isArray(t.suspicions) &&
      t.suspicions.length > 0
  );

  // 2. Gather every candidate doc id referenced across all suspicions.
  const candidateDocIds = new Set<string>();
  for (const t of flagged) {
    for (const s of t.suspicions || []) {
      for (const docId of s.possible_doc_ids || []) candidateDocIds.add(docId);
    }
  }

  // 3. Load all OPEN pay-actions with their source docs — this is both
  // the candidate pool AND the "pick a different bill" search list.
  const { data: actionsRaw } = await supabase
    .from("actions")
    .select(
      "id, document_id, due_date, document:documents(id, sender, amount, currency, document_date, file_name, file_type, extracted_fields)"
    )
    .eq("status", "open")
    .eq("action_type", "pay")
    .limit(1000);

  const allBills: ReviewBill[] = (actionsRaw || []).map((a) => {
    const d = (a as {
      document?: {
        id?: string;
        sender?: string;
        amount?: number;
        currency?: string;
        document_date?: string;
        file_name?: string;
        file_type?: string;
        extracted_fields?: Record<string, unknown>;
      };
    }).document;
    return {
      action_id: (a as { id: string }).id,
      document_id: (a as { document_id: string }).document_id,
      sender: d?.sender || null,
      amount: d?.amount ?? null,
      currency: d?.currency || null,
      document_date: d?.document_date || null,
      due_date: (a as { due_date: string | null }).due_date,
      file_name: d?.file_name || null,
      file_type: d?.file_type || null,
      iban: extractIban(d?.extracted_fields),
      reference: extractRef(d?.extracted_fields),
    };
  });
  const billByDocId = new Map(allBills.map((b) => [b.document_id, b]));

  // 4. Build the review items: each flagged tx + its candidate bills,
  // each candidate scored with deterministic comparison signals.
  const items: ReviewItem[] = flagged.map((t) => {
    // Merge possible_doc_ids across all suspicion entries on this tx.
    const docIds = new Set<string>();
    let reasoning = "";
    let confidence = 0;
    for (const s of t.suspicions || []) {
      for (const docId of s.possible_doc_ids || []) docIds.add(docId);
      if (s.reasoning && !reasoning) reasoning = s.reasoning;
      if (s.confidence > confidence) confidence = s.confidence;
    }
    const candidates = Array.from(docIds)
      .map((docId) => {
        const bill = billByDocId.get(docId);
        if (!bill) return null;
        return {
          bill,
          signals: compareTxToBill(
            {
              amount: t.amount,
              booking_date: t.booking_date,
              value_date: t.value_date,
              counterparty_name: t.counterparty_name,
              counterparty_iban: t.counterparty_iban,
              reference: t.reference,
              description: t.description,
            },
            {
              sender: bill.sender,
              amount: bill.amount,
              document_date: bill.document_date,
              due_date: bill.due_date,
              iban: bill.iban,
              reference: bill.reference,
            }
          ),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      // Best deterministic match first.
      .sort((a, b) => b.signals.score - a.signals.score);

    return {
      tx: {
        id: t.id,
        amount: t.amount,
        currency: t.currency,
        booking_date: t.booking_date,
        value_date: t.value_date,
        counterparty_name: t.counterparty_name,
        counterparty_iban: t.counterparty_iban,
        reference: t.reference,
        description: t.description,
      },
      ai_reasoning: reasoning,
      ai_confidence: confidence,
      candidates,
    };
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <Link
        href={`/document/${id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to statement
      </Link>
      <h1 className="text-xl font-bold mb-1">Review suspicions</h1>
      <p className="text-sm text-muted-foreground mb-5">
        {items.length} transaction{items.length === 1 ? "" : "s"} the AI
        flagged as a possible bill payment but wasn&apos;t confident enough
        to book automatically. For each, pick the bill it belongs to — or
        dismiss it if it isn&apos;t a tracked bill.
      </p>
      {items.length === 0 ? (
        <div className="surface p-6 text-sm text-muted-foreground">
          No suspicions to review. Either none were flagged, or they&apos;ve
          all been resolved.
        </div>
      ) : (
        <ReviewQueue items={items} allBills={allBills} />
      )}
    </div>
  );
}
