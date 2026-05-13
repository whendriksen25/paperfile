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
    /** Date the invoice/bill was issued — strongest temporal anchor. */
    document_date: string | null;
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

/**
 * Pull EVERY plausible reference identifier the AI extracted into a list.
 * Different doc types use different field names:
 *   - invoices: invoice_number, factuurnummer, factuur_number
 *   - direct-debit mandates: mandate_reference, payment_reference,
 *     betalingskenmerk (Dutch structured payment ref), mededeling
 *   - utility bills: customer_number, klantnummer, customer_reference
 *   - tax/parking/etc: payment_id, kenmerk, dossier_number
 *
 * Plus any pure-digit run of length ≥ 6 hiding inside a string-valued
 * extracted field (catches cases where AI dumped the whole footer line
 * into `reference` without parsing it apart).
 */
function extractDocReferences(
  ef: Record<string, unknown> | null | undefined
): string[] {
  if (!ef) return [];
  const KEYS = [
    "payment_reference",
    "invoice_number",
    "factuurnummer",
    "factuur_number",
    "reference",
    "customer_reference",
    "customer_number",
    "klantnummer",
    "mandate_reference",
    "betalingskenmerk",
    "mededeling",
    "payment_id",
    "kenmerk",
    "dossier_number",
    "ovi_number",
    "transaction_reference",
  ];
  const found: string[] = [];
  const push = (s: string | number | null | undefined) => {
    if (s == null) return;
    const v = typeof s === "number" ? String(s) : String(s).trim();
    if (v && v.length >= 4) found.push(v);
  };
  for (const k of KEYS) push(ef[k] as string | number | undefined);
  // Catch-all: hunt for digit-only runs ≥ 6 in any string field.
  const digitRe = /\b\d{6,}\b/g;
  for (const v of Object.values(ef)) {
    if (typeof v !== "string") continue;
    let m;
    while ((m = digitRe.exec(v)) !== null) found.push(m[0]);
  }
  // De-dup while preserving order.
  const seen = new Set<string>();
  return found.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

/** Aggressive normalisation — keep only [a-z0-9], so "F-2026/0042" and
 * "F 2026 0042" both collapse to "f20260042". */
function refNorm(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Window (in days) for date proximity between a bill's reference date
 * (invoice date or due date) and a bank transaction's booking date.
 * 35d covers a monthly billing cycle plus typical late-pay slack; tighter
 * than this risks rejecting late payments, wider risks the Frank Energie
 * "1 invoice ↔ 5 monthly debits" over-match. Calibrate later if needed. */
const DATE_WINDOW_DAYS = 35;

function dayDiff(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.POSITIVE_INFINITY;
  return Math.abs(ta - tb) / 86400000;
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

  // Temporal proximity. When BOTH a transaction date and an action
  // reference date are present, require them to be within
  // DATE_WINDOW_DAYS. This is what stops a single Feb invoice for
  // €272.57 from matching the Jan/Mar/Apr/May €272.57 direct-debit
  // charges to the same vendor. We prefer document_date (invoice
  // issued) > due_date (computed from terms); both are sensible
  // anchors. If either side is missing we skip this check — better
  // to fall back to amount+identifier than reject silently.
  const txDate = tx.booking_date || tx.value_date;
  const refDate = action.document?.document_date || action.due_date;
  if (txDate && refDate) {
    const days = dayDiff(txDate, refDate);
    if (days > DATE_WINDOW_DAYS) return [];
    reasons.push(`date ≈ ${days.toFixed(0)}d`);
  }

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

  // Reference matching: try every extracted identifier against tx.reference
  // AND tx.description (bank tx structured-ref vs human-readable description
  // — many statements split the data across both). Both sides are
  // aggressively normalised so formatting differences ("F-2026-0042" vs
  // "F20260042") don't defeat substring matching. Match is bidirectional:
  // the tx can contain the doc's ref OR the doc's ref can contain the tx
  // ref (covers cases where the tx string is just an embedded fragment).
  const docRefs = extractDocReferences(action.document?.extracted_fields);
  const txRefBlob =
    refNorm(tx.reference) + " " + refNorm(tx.description);
  for (const docRef of docRefs) {
    const refN = refNorm(docRef);
    if (refN.length < 4) continue;
    if (txRefBlob.includes(refN) || refN.includes(refNorm(tx.reference))) {
      reasons.push(`reference "${docRef}"`);
      strong = true;
      break;
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

  // 2. Clear any prior matches on these rows so re-runs reflect today's state.
  // Also reset match_status so old verdicts ('matched'/'ambiguous'/'unmatched')
  // don't leak through.
  if (txRows.length > 0) {
    const { error: clearErr } = await admin
      .from("bank_transactions")
      .update({
        matched_action_id: null,
        matched_document_id: null,
        matched_at: null,
        match_reason: null,
        match_status: null,
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
      "id, user_id, document_id, profile_id, action_type, summary, due_date, status, document:documents(id, sender, amount, currency, document_date, extracted_fields)"
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

  // Track which actions have already been settled in THIS run so we
  // don't stamp a single open pay-action onto multiple bank transactions.
  // Without this, a monthly direct-debit (5 €272.57 Frank Energie charges
  // in the period) all match the one open invoice for €272.57, and the
  // matcher cheerfully back-links the action to every one of them.
  const matchedThisRun = new Set<string>();

  // 4. Per-transaction matching
  for (const tx of txRows) {
    if (tx.amount >= 0) continue; // only debits settle pay actions
    result.considered++;

    const candidates: Array<{
      action: PendingAction;
      reasons: string[];
    }> = [];
    for (const a of pending) {
      if (matchedThisRun.has(a.id)) continue; // many-to-one guard
      const reasons = matchSignals(tx, a);
      if (reasons.length > 0) candidates.push({ action: a, reasons });
    }

    if (candidates.length === 0) {
      result.unmatched++;
      // Intentionally NO per-row UPDATE here: with 800+ unmatched debits
      // per statement, the round-trip latency to Supabase (30-50ms × 800)
      // alone blows past Vercel's 60s function limit before the AI pass
      // even starts. The panel treats NULL match_status as unmatched, so
      // leaving it NULL is identical visually and saves the entire
      // bottleneck. Re-runs clear matched_* + match_status in one bulk
      // UPDATE at the top, so there's no stale "matched" state to worry
      // about.
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous++;
      const labels = candidates
        .map((c) => `${c.action.id.slice(0, 8)} (${c.reasons.join(",")})`)
        .join(" | ");
      await admin
        .from("bank_transactions")
        .update({
          match_status: "ambiguous",
          match_reason: `Ambiguous: ${labels}`,
        })
        .eq("id", tx.id);
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
        match_status: "matched",
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
    matchedThisRun.add(action.id);
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
