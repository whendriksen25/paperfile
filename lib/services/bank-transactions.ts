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
 * Used during analyze (initial + re-analyse). DELETE-then-INSERT, in
 * that order, so we're idempotent.
 *
 * Keeps `matched_*` columns intentionally NULL on the new rows — a
 * subsequent reconciliation pass fills them in. If you want to preserve
 * an existing match across a re-analyse, snapshot it before calling here
 * and re-apply after (we don't do that yet — re-analyse re-runs
 * reconciliation anyway).
 */
export async function replaceStatementTransactions(
  admin: SupabaseClient,
  userId: string,
  statementId: string,
  rows: Omit<BankTransactionInsert, "user_id" | "statement_id" | "position">[]
): Promise<{ inserted: number }> {
  const { error: delErr } = await admin
    .from("bank_transactions")
    .delete()
    .eq("statement_id", statementId);
  if (delErr) throw delErr;

  if (rows.length === 0) return { inserted: 0 };

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
  return { inserted };
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
