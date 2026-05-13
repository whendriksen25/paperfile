import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * First-class representation of one bank transaction. Backed by the
 * `bank_transactions` Postgres table (migration 012).
 *
 * Statement-level metadata (account holder, period, balances) still lives
 * on the parent documents row's `extracted_fields`. Transactions are
 * exploded out so we can query, reconcile, and aggregate them in SQL.
 */
export interface BankTransactionRow {
  id: string;
  user_id: string;
  statement_id: string;
  position: number | null;

  amount: number;
  currency: string;

  booking_date: string | null;
  value_date: string | null;

  counterparty_name: string | null;
  counterparty_iban: string | null;

  description: string | null;
  reference: string | null;

  transaction_id: string | null;

  category: string | null;
  notes: string | null;

  matched_action_id: string | null;
  matched_document_id: string | null;
  matched_at: string | null;
  match_reason: string | null;
  /** Reconcile verdict: 'matched' | 'ambiguous' | 'unmatched' | null */
  match_status: string | null;

  created_at: string;
  updated_at: string;
}

export interface BankTransactionInsert {
  user_id: string;
  statement_id: string;
  position: number;
  amount: number;
  currency: string;
  booking_date: string | null;
  value_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  reference: string | null;
  transaction_id: string | null;
}

/**
 * Replace ALL transactions for a given statement with a fresh set.
 * Used during analyze (initial + re-analyse). DELETE-then-INSERT.
 *
 * Preserves `matched_*` columns across the replace: before DELETE we
 * snapshot rows that already have a reconciliation back-link, then after
 * INSERT we re-stamp the same back-link onto the new row that carries
 * the same signature (amount + booking_date + counterparty_iban +
 * reference + transaction_id). Why: when a re-analyse runs after a
 * reconcile that closed pay-actions, the closed actions are filtered out
 * of any subsequent reconcile (status='open' only), so without snapshot+
 * restore the back-link is silently lost and bank-stats reports 0% even
 * though the actions side is correctly closed.
 */
export async function replaceStatementTransactions(
  admin: SupabaseClient,
  userId: string,
  statementId: string,
  rows: Omit<BankTransactionInsert, "user_id" | "statement_id" | "position">[]
): Promise<{ inserted: number; restored_matches: number }> {
  // 0. Snapshot any existing matched_* state keyed by transaction signature.
  // We rely on amount + booking_date + counterparty_iban + reference +
  // transaction_id being effectively unique within a statement.
  const { data: prior, error: snapErr } = await admin
    .from("bank_transactions")
    .select(
      "amount, booking_date, counterparty_iban, reference, transaction_id, matched_action_id, matched_document_id, matched_at, match_reason, match_status"
    )
    .eq("statement_id", statementId)
    .not("matched_action_id", "is", null);
  if (snapErr) throw snapErr;
  const sigOf = (r: {
    amount: number | string;
    booking_date: string | null;
    counterparty_iban: string | null;
    reference: string | null;
    transaction_id: string | null;
  }) =>
    [
      Number(r.amount).toFixed(2),
      r.booking_date || "",
      r.counterparty_iban || "",
      r.reference || "",
      r.transaction_id || "",
    ].join("|");
  const snapshot = new Map<
    string,
    {
      matched_action_id: string;
      matched_document_id: string | null;
      matched_at: string | null;
      match_reason: string | null;
      match_status: string | null;
    }
  >();
  for (const r of prior || []) {
    snapshot.set(sigOf(r), {
      matched_action_id: r.matched_action_id as string,
      matched_document_id: r.matched_document_id as string | null,
      matched_at: r.matched_at as string | null,
      match_reason: r.match_reason as string | null,
      match_status: (r as Record<string, unknown>).match_status as string | null,
    });
  }

  const { error: delErr } = await admin
    .from("bank_transactions")
    .delete()
    .eq("statement_id", statementId);
  if (delErr) throw delErr;

  if (rows.length === 0) return { inserted: 0, restored_matches: 0 };

  const payload: BankTransactionInsert[] = rows.map((r, i) => ({
    ...r,
    user_id: userId,
    statement_id: statementId,
    position: i,
  }));

  // Chunk inserts — Supabase's REST gateway is reliable for ≤500 rows
  // per call. A full-year Rabobank statement can be 1000+ transactions
  // and would otherwise blow past payload limits.
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK);
    const { error: insErr } = await admin
      .from("bank_transactions")
      .insert(slice);
    if (insErr) {
      console.error(
        `[replaceStatementTransactions] chunk insert failed at ${i}/${payload.length}:`,
        insErr
      );
      // PostgrestError isn't a real Error instance — wrap it so the
      // caller's `e instanceof Error` + e.message handling works and
      // the user sees a useful string in review_notes, not [object Object].
      const e = insErr as {
        message?: string;
        code?: string;
        details?: string;
        hint?: string;
      };
      const parts = [
        e.message || JSON.stringify(insErr),
        e.code ? `(code ${e.code})` : null,
        e.details ? `details: ${e.details}` : null,
        e.hint ? `hint: ${e.hint}` : null,
      ].filter(Boolean);
      throw new Error(
        `bank_transactions insert failed at row ${i}/${payload.length}: ${parts.join(" — ")}`
      );
    }
    inserted += slice.length;
  }

  // Restore matched_* on the new rows by signature. Done in one shot per
  // signature: query the fresh row's id, then update it. We only restore
  // when exactly one new row matches the signature — ties are skipped
  // and left for the user's `diag repair-matches` to resolve manually.
  let restored_matches = 0;
  if (snapshot.size > 0) {
    for (const [sig, snap] of Array.from(snapshot.entries())) {
      const [amountStr, bookingDate, iban, reference, txid] = sig.split("|");
      let q = admin
        .from("bank_transactions")
        .select("id")
        .eq("statement_id", statementId)
        .eq("amount", Number(amountStr));
      if (bookingDate) q = q.eq("booking_date", bookingDate);
      if (iban) q = q.eq("counterparty_iban", iban);
      if (reference) q = q.eq("reference", reference);
      if (txid) q = q.eq("transaction_id", txid);
      const { data: cands, error: findErr } = await q.limit(2);
      if (findErr) continue;
      if (!cands || cands.length !== 1) continue;
      const { error: stampErr } = await admin
        .from("bank_transactions")
        .update({
          matched_action_id: snap.matched_action_id,
          matched_document_id: snap.matched_document_id,
          matched_at: snap.matched_at,
          match_reason: snap.match_reason
            ? `${snap.match_reason} (restored after re-analyze)`
            : "restored after re-analyze",
          match_status: snap.match_status || "matched",
        })
        .eq("id", cands[0].id);
      if (!stampErr) restored_matches++;
    }
    console.log(
      `[replaceStatementTransactions] restored ${restored_matches}/${snapshot.size} matched_* back-links across re-analyze`
    );
  }

  return { inserted, restored_matches };
}

/** Fetch all transactions for a statement, in original ordering. */
export async function getStatementTransactions(
  client: SupabaseClient,
  statementId: string
): Promise<BankTransactionRow[]> {
  const { data, error } = await client
    .from("bank_transactions")
    .select("*")
    .eq("statement_id", statementId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data || []) as BankTransactionRow[];
}
