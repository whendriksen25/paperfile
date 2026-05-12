import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reconcile a bank statement's transactions against the user's open
 * `pay` actions. Reads transactions from the `bank_transactions` table
 * (NOT from in-memory state) so the database is always the source of
 * truth — running this after analyze, manually via the Re-reconcile
 * button, or later via a batch sweep all give the same answer.
 *
 *  Match heuristic (all conjunctive):
 *   1. Amount within ±€0.50 or ±0.5% of the transaction (whichever larger).
 *   2. At least ONE strong identifier overlap:
 *        - counterparty_iban === any IBAN extracted from the source doc
 *        - counterparty_name fuzzy-matches the source doc's sender
 *        - reference contains the source doc's invoice / payment_reference
 *
 *  When multiple actions match the same transaction → ambiguous (skipped).
 *  When a unique action matches → close it, mark source doc paid, record
 *  the match on the bank_transactions row (matched_action_id, matched_at,
 *  match_reason), log to maintenance_log.
 *
 * Re-running clears matched_* on the statement's transactions first, so
 * the latest reconciliation state always reflects the current set of
 * open actions.
 */

export interface ReconciliationResult {
  considered: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /**
   * Count of matches where the in-memory match succeeded (action closed,
   * doc marked paid) but the back-link write to bank_transactions failed.
   * Should always be 0; if non-zero, the matcher is "matching" but the
   * `matched_action_id` column never gets stamped — exactly the symptom
   * that left bank-stats reporting 0% even with maintenance_log entries.
   */
  back_link_write_failures: number;
  matches: Array<{
    transaction_id: string;
    action_id: string;
    document_id: string;
    amount: number;
    reason: string;
  }>;
}

interface BankTransactionRow {
  id: string;
  amount: number;
  currency: string | null;
  booking_date: string | null;
  value_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  reference: string | null;
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

function matchSignals(
  tx: BankTransactionRow,
  action: PendingAction
): string[] {
  const reasons: string[] = [];

  const txAbs = Math.abs(tx.amount);
  const docAbs =
    action.document?.amount != null
      ? Math.abs(Number(action.document.amount))
      : null;
  if (docAbs == null || !Number.isFinite(docAbs)) return [];
  const tolerance = Math.max(0.5, txAbs * 0.005);
  if (Math.abs(txAbs - docAbs) > tolerance) return [];
  reasons.push(`amount ≈ €${docAbs.toFixed(2)}`);

  let strong = false;

  const docIban = extractDocIban(action.document?.extracted_fields);
  const txIban = ibanNorm(tx.counterparty_iban);
  if (docIban && txIban && docIban === txIban) {
    reasons.push(`IBAN ${docIban}`);
    strong = true;
  }

  const senderN = nameNorm(action.document?.sender);
  const counterN = nameNorm(tx.counterparty_name || tx.description);
  if (
    senderN &&
    counterN &&
    (counterN.includes(senderN) || senderN.includes(counterN))
  ) {
    reasons.push(`sender ~= "${tx.counterparty_name || tx.description}"`);
    strong = true;
  }

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

/**
 * Reconcile a single statement. Reads bank_transactions, queries open
 * pay actions, applies matches, persists matched_* columns back onto
 * the bank_transactions rows.
 *
 * Idempotent: any prior matched_* values for this statement's
 * transactions are cleared before re-evaluating, so re-running after
 * the user has corrected a source doc (or opened new actions) gives
 * the latest answer.
 */
export async function reconcileBankStatement(
  admin: SupabaseClient,
  userId: string,
  statementDocId: string
): Promise<ReconciliationResult> {
  // 1. Load transactions from the table (source of truth). Supabase's
  // PostgREST is configured with `db-max-rows: 1000` — `.range()` from
  // the client can't override that hard cap. Workaround: paginate by
  // offset until a short page returns. Full-year statements can have
  // 1000-2000 transactions; pagination guarantees we see them all.
  const PAGE = 1000;
  const txRows: BankTransactionRow[] = [];
  let offset = 0;
  // Safety bound — refuse to loop more than 50 pages (50k rows). No
  // realistic personal bank statement gets near this.
  for (let i = 0; i < 50; i++) {
    const { data: pageData, error: txErr } = await admin
      .from("bank_transactions")
      .select(
        "id, amount, currency, booking_date, value_date, counterparty_name, counterparty_iban, description, reference"
      )
      .eq("user_id", userId)
      .eq("statement_id", statementDocId)
      .order("position", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (txErr) throw txErr;
    const rows = (pageData || []) as BankTransactionRow[];
    txRows.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  // 2. Clear any prior matches on these rows so re-runs reflect today's state
  if (txRows.length > 0) {
    const { error: clearErr } = await admin
      .from("bank_transactions")
      .update({
        matched_action_id: null,
        matched_document_id: null,
        matched_at: null,
        match_reason: null,
      })
      .eq("statement_id", statementDocId);
    if (clearErr) {
      console.error("[reconcile] clear matched_* failed:", clearErr);
      throw new Error(
        `bank_transactions clear failed: ${clearErr.message || JSON.stringify(clearErr)}`
      );
    }
  }

  // 3. Load all open pay actions, with source doc joined
  const { data: actionsRaw, error: aErr } = await admin
    .from("actions")
    .select(
      "id, user_id, document_id, profile_id, action_type, summary, due_date, status, document:documents(id, sender, amount, currency, extracted_fields)"
    )
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("action_type", "pay");
  if (aErr) throw aErr;
  const pending = ((actionsRaw || []) as unknown as PendingAction[]).filter(
    (a) => a.document_id !== statementDocId
  );

  const result: ReconciliationResult = {
    considered: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    back_link_write_failures: 0,
    matches: [],
  };

  // 4. Per-transaction matching
  for (const tx of txRows) {
    if (tx.amount >= 0) continue; // only debits settle pay actions
    result.considered++;

    const candidates: Array<{
      action: PendingAction;
      reasons: string[];
    }> = [];
    for (const a of pending) {
      const reasons = matchSignals(tx, a);
      if (reasons.length > 0) candidates.push({ action: a, reasons });
    }

    if (candidates.length === 0) {
      result.unmatched++;
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous++;
      continue;
    }

    const { action, reasons } = candidates[0];
    const reasonStr = reasons.join(" + ");
    const paidDate = tx.value_date || tx.booking_date || null;
    const now = new Date().toISOString();

    // Close the action
    const { error: closeErr } = await admin
      .from("actions")
      .update({
        status: "done",
        completed_at: now,
        notes: `Auto-matched to bank transaction (${reasonStr}) on ${paidDate || "unknown date"}.`,
      })
      .eq("id", action.id);
    if (closeErr) {
      console.warn("[reconcile] close action failed", closeErr);
      continue;
    }

    // Mark source doc paid
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

    // Record the match on the bank_transaction row itself. Loud error
    // logging here because a silent failure here is invisible: the action
    // is closed, the doc is marked paid, the maintenance_log gets an entry
    // — but the bank_transactions row stays unmatched, so `bank-stats`
    // reports 0 even though everything else worked.
    const { error: txUpdErr } = await admin
      .from("bank_transactions")
      .update({
        matched_action_id: action.id,
        matched_document_id: action.document_id,
        matched_at: now,
        match_reason: reasonStr,
      })
      .eq("id", tx.id);
    if (txUpdErr) {
      console.error(
        `[reconcile] FAILED to write matched_* on tx ${tx.id} (action ${action.id}):`,
        JSON.stringify(txUpdErr)
      );
      result.back_link_write_failures++;
      // Don't throw — the action is already closed, no point bailing the
      // whole run. But surface the count.
    }

    await admin.from("maintenance_log").insert({
      user_id: userId,
      document_id: action.document_id,
      kind: "bank_reconcile",
      reason: `Auto-paid via bank statement: ${reasonStr}`,
      payload: {
        statement_doc_id: statementDocId,
        bank_transaction_id: tx.id,
        action_id: action.id,
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
      transaction_id: tx.id,
      action_id: action.id,
      document_id: action.document_id,
      amount: tx.amount,
      reason: reasonStr,
    });
  }

  console.log("[reconcile] done", JSON.stringify(result));
  return result;
}
