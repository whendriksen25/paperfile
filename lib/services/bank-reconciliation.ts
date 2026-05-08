import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reconcile a bank statement's transactions against the user's open
 * `pay` actions. For each debit transaction we attempt to find a single
 * unambiguous match — when found, we close the action, mark the source
 * document as paid, and log the match in maintenance_log.
 *
 *  Match heuristic (all conjunction):
 *   1. Amount within ±€0.50 (or ±0.5% of the transaction amount,
 *      whichever is greater) — covers rounding + small fees.
 *   2. At least ONE strong identifier overlap:
 *        - counterparty_iban === any IBAN extracted from the source doc
 *        - counterparty_name fuzzy-matches the source doc's sender
 *        - reference contains the source doc's invoice/payment_reference
 *
 *  When MULTIPLE actions match the same transaction, we don't auto-close
 *  any of them — ambiguity is unsafe; the user reviews manually.
 *
 * The source-doc-side data we use:
 *   - documents.amount (or extracted_fields.total_incl)
 *   - extracted_fields.payment_iban / iban
 *   - documents.sender
 *   - extracted_fields.payment_reference / invoice_number
 */

export interface BankTransactionLike {
  /** Negative for debit/outgoing. */
  amount: number;
  currency?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  counterparty_name?: string | null;
  counterparty_iban?: string | null;
  reference?: string | null;
  transaction_id?: string | null;
}

export interface ReconciliationResult {
  considered: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  matches: Array<{
    transaction_index: number;
    action_id: string;
    document_id: string;
    amount: number;
    reason: string;
  }>;
}

interface PendingAction {
  id: string;
  user_id: string;
  document_id: string;
  profile_id: number | null;
  action_type: string;
  summary: string;
  due_date: string | null;
  status: string;
  document?: {
    id: string;
    sender: string | null;
    amount: number | null;
    currency: string | null;
    extracted_fields: Record<string, unknown> | null;
  } | null;
}

function ibanNorm(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/\s+/g, "");
}

function nameNorm(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function extractDocIban(
  ef: Record<string, unknown> | null | undefined
): string | null {
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

function extractDocReference(
  ef: Record<string, unknown> | null | undefined
): string | null {
  if (!ef) return null;
  const candidates = [
    ef["payment_reference"],
    ef["invoice_number"],
    ef["reference"],
    ef["customer_reference"],
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Score a (transaction, action) pair. Returns a list of human-readable
 * reasons that fired, or an empty array if it doesn't match.
 */
function matchSignals(
  tx: BankTransactionLike,
  action: PendingAction
): string[] {
  const reasons: string[] = [];

  // 1. Amount tolerance — tx is signed; we only care about debits here
  const txAbs = Math.abs(tx.amount);
  const docAbs =
    action.document?.amount != null
      ? Math.abs(Number(action.document.amount))
      : null;
  if (docAbs == null || !Number.isFinite(docAbs)) return [];
  const tolerance = Math.max(0.5, txAbs * 0.005); // ±50 cents or 0.5%
  if (Math.abs(txAbs - docAbs) > tolerance) return [];
  reasons.push(`amount ≈ €${docAbs.toFixed(2)}`);

  // 2. At least one strong identifier overlap
  let strong = false;

  // IBAN
  const docIban = extractDocIban(action.document?.extracted_fields);
  const txIban = ibanNorm(tx.counterparty_iban);
  if (docIban && txIban && docIban === txIban) {
    reasons.push(`IBAN ${docIban}`);
    strong = true;
  }

  // Sender / counterparty fuzzy match
  const senderN = nameNorm(action.document?.sender);
  const counterN = nameNorm(tx.counterparty_name);
  if (senderN && counterN && (counterN.includes(senderN) || senderN.includes(counterN))) {
    reasons.push(`sender ~= "${tx.counterparty_name}"`);
    strong = true;
  }

  // Reference / invoice number contained in the bank's reference field
  const docRef = extractDocReference(action.document?.extracted_fields);
  if (docRef && tx.reference) {
    const refN = String(docRef).replace(/\s+/g, "").toLowerCase();
    const txRefN = tx.reference.replace(/\s+/g, "").toLowerCase();
    if (refN.length >= 4 && txRefN.includes(refN)) {
      reasons.push(`reference "${docRef}"`);
      strong = true;
    }
  }

  return strong ? reasons : [];
}

export async function reconcileBankStatement(
  admin: SupabaseClient,
  userId: string,
  statementDocId: string,
  transactions: BankTransactionLike[]
): Promise<ReconciliationResult> {
  // Pull every open `pay` action with its source doc joined in. Limit
  // scope to the user; profile_id doesn't restrict because a statement
  // could legitimately settle bills across profiles (Wim paying his
  // father's CAK from his own account, or vice versa).
  const { data: actions, error } = await admin
    .from("actions")
    .select(
      "id, user_id, document_id, profile_id, action_type, summary, due_date, status, document:documents(id, sender, amount, currency, extracted_fields)"
    )
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("action_type", "pay");
  if (error) throw error;

  const pending = ((actions || []) as unknown as PendingAction[]).filter(
    (a) => a.document_id !== statementDocId
  );

  const result: ReconciliationResult = {
    considered: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    matches: [],
  };

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    // Only debits — incoming transfers don't settle our pay actions.
    if (tx.amount >= 0) continue;
    result.considered++;

    const candidateMatches: Array<{
      action: PendingAction;
      reasons: string[];
    }> = [];
    for (const a of pending) {
      const reasons = matchSignals(tx, a);
      if (reasons.length > 0) candidateMatches.push({ action: a, reasons });
    }

    if (candidateMatches.length === 0) {
      result.unmatched++;
      continue;
    }
    if (candidateMatches.length > 1) {
      result.ambiguous++;
      continue;
    }

    const { action, reasons } = candidateMatches[0];
    const reasonStr = reasons.join(" + ");
    const paidDate = tx.value_date || tx.booking_date || null;

    // Close the action
    const { error: closeErr } = await admin
      .from("actions")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        notes: `Auto-matched to bank transaction (${reasonStr}) on ${paidDate || "unknown date"}.`,
      })
      .eq("id", action.id);
    if (closeErr) {
      console.warn("[reconcile] close action failed", closeErr);
      continue;
    }

    // Mark source doc as paid (merge into extracted_fields)
    const sourceEf = (action.document?.extracted_fields || {}) as Record<
      string,
      unknown
    >;
    const newEf = {
      ...sourceEf,
      payment_status: "paid",
      paid_date: paidDate,
      paid_note: `Matched to bank statement ${statementDocId.slice(0, 8)} (${reasonStr})`,
    };
    await admin
      .from("documents")
      .update({ extracted_fields: newEf })
      .eq("id", action.document_id);

    await admin.from("maintenance_log").insert({
      user_id: userId,
      document_id: action.document_id,
      kind: "bank_reconcile",
      reason: `Auto-paid via bank statement: ${reasonStr}`,
      payload: {
        statement_doc_id: statementDocId,
        action_id: action.id,
        transaction_index: i,
        amount: tx.amount,
        counterparty: tx.counterparty_name,
        counterparty_iban: tx.counterparty_iban,
        reference: tx.reference,
        booking_date: tx.booking_date,
        value_date: tx.value_date,
      },
    });

    result.matched++;
    result.matches.push({
      transaction_index: i,
      action_id: action.id,
      document_id: action.document_id,
      amount: tx.amount,
      reason: reasonStr,
    });
  }

  console.log("[reconcile] done", JSON.stringify(result));
  return result;
}
