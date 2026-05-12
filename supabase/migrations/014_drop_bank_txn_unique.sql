-- =============================================================================
-- 014_drop_bank_txn_unique.sql
-- Drop the partial unique index added in migration 012 on
-- (statement_id, transaction_id). It assumed banks emit a per-line
-- unique transaction reference, which Rabobank does not: SDD batch
-- members and related transfers share the same Transactiereferentie.
-- Real-world result: any Rabobank statement with batch debits failed
-- to insert.
--
-- The (statement_id, position) pair already enforces uniqueness within
-- a statement (position is 0..N-1 by construction), and DELETE-then-
-- INSERT in replaceStatementTransactions handles re-analyse dedup
-- correctly. So we don't lose anything by dropping this.
-- =============================================================================

DROP INDEX IF EXISTS public.bank_transactions_statement_txn_uniq;

NOTIFY pgrst, 'reload schema';
