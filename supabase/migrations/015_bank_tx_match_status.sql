-- =============================================================================
-- 015_bank_tx_match_status.sql
-- Add a match_status column to bank_transactions so the reconciliation panel
-- can drill-down into matched / ambiguous / unmatched debits, not just show
-- the count. The matcher writes this for every debit it considers; credits
-- and zero-amount rows stay NULL.
--
-- Possible values:
--   'matched'    — uniquely paired to an open pay-action, action closed
--   'ambiguous'  — overlapped with >1 open pay-action, skipped
--   'unmatched'  — no open pay-action overlapped on amount + identifier
--                  within the 35-day window
--   NULL         — not a debit, or never run through reconcile
-- =============================================================================

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS match_status TEXT;

CREATE INDEX IF NOT EXISTS bank_transactions_status_idx
  ON public.bank_transactions (statement_id, match_status);

NOTIFY pgrst, 'reload schema';
