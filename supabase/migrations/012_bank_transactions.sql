-- =============================================================================
-- 012_bank_transactions.sql
-- First-class storage for bank statement transactions.
--
-- Each row is one line on a bank statement. Statements (document_type =
-- 'bank_statement') still live in `documents`; their per-transaction lines
-- get exploded out into this table so we can:
--   - reconcile across many statements (SQL JOIN against `actions`)
--   - index by amount, date, counterparty IBAN for fast lookups
--   - aggregate spending across statements without unpacking JSONB blobs
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL,
  -- The statement this transaction came from. Cascade so re-analysing a
  -- statement (which clears and re-inserts) doesn't strand orphan rows.
  statement_id        UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  -- Position inside the statement (preserves the bank's original ordering
  -- when sorting by booking_date alone would tie).
  position            INT,

  -- Signed amount: negative = debit (outgoing), positive = credit (incoming)
  amount              NUMERIC(14,2) NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'EUR',

  -- Dates
  booking_date        DATE,
  value_date          DATE,

  -- Counterparty
  counterparty_name   TEXT,
  counterparty_iban   TEXT,

  -- Description + reference
  description         TEXT,
  reference           TEXT,

  -- Bank's per-line transaction id (used for in-statement dedup on re-analyze)
  transaction_id      TEXT,

  -- Optional user-driven tagging
  category            TEXT,
  notes               TEXT,

  -- Reconciliation link: which pay-action this transaction settled, if any
  matched_action_id   UUID REFERENCES public.actions(id) ON DELETE SET NULL,
  matched_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL,
  matched_at          TIMESTAMPTZ,
  match_reason        TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user list views (cross-statement transactions page, reports)
CREATE INDEX IF NOT EXISTS bank_transactions_user_date_idx
  ON public.bank_transactions (user_id, booking_date DESC NULLS LAST);

-- Statement detail page
CREATE INDEX IF NOT EXISTS bank_transactions_statement_idx
  ON public.bank_transactions (statement_id, position);

-- Fast IBAN reverse-lookup for reconciliation
CREATE INDEX IF NOT EXISTS bank_transactions_iban_idx
  ON public.bank_transactions (user_id, counterparty_iban)
  WHERE counterparty_iban IS NOT NULL;

-- Amount range queries for reports
CREATE INDEX IF NOT EXISTS bank_transactions_amount_idx
  ON public.bank_transactions (user_id, amount);

-- NOTE (intentionally removed): a (statement_id, transaction_id) partial
-- UNIQUE index was originally created here. Migration 014 dropped it
-- because Rabobank's SDD batches share Transactiereferentie across batch
-- members, which violated the constraint on real data. Removing the
-- CREATE statement from this file (rather than relying on 014 to undo
-- it later) makes the apply-migrations script — which has no tracking
-- table and re-runs every file every invocation — idempotent against
-- populated data. End state is identical: no unique index on
-- (statement_id, transaction_id).

-- RLS: every read/write is scoped to the calling user
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_transactions_owner_select" ON public.bank_transactions;
CREATE POLICY "bank_transactions_owner_select"
  ON public.bank_transactions FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "bank_transactions_owner_modify" ON public.bank_transactions;
CREATE POLICY "bank_transactions_owner_modify"
  ON public.bank_transactions FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- updated_at auto-touch trigger
CREATE OR REPLACE FUNCTION public.touch_bank_transactions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_transactions_set_updated_at ON public.bank_transactions;
CREATE TRIGGER bank_transactions_set_updated_at
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.touch_bank_transactions_updated_at();

NOTIFY pgrst, 'reload schema';
