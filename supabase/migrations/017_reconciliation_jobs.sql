-- =============================================================================
-- 017_reconciliation_jobs.sql
-- Background job table for AI reconciliation.
--
-- Why: the AI pass exceeds Vercel's 60s function limit on real
-- statements (46+ bills × hundreds of candidate debits, ~8 chunks per
-- run). Processing the chunks inline kills the function before the
-- summary is persisted. Solution: each chunk gets its own short HTTP
-- invocation; the panel polls until all chunks are done.
--
-- Lifecycle of a job:
--   1. Reset/Re-reconcile route runs deterministic pass + creates a
--      row with status='pending', bills/chunks pre-computed.
--   2. Worker route /api/reconcile-step/[job_id] picks up the next
--      pending chunk, processes it, increments completed_chunks,
--      writes any matches/suspicions to bank_transactions and updates
--      the actions/documents rows.
--   3. When completed_chunks == total_chunks, status flips to 'done'
--      and the summary is mirrored into the statement's
--      extracted_fields._reconciliation.ai block.
--
-- Idempotency: bills + their chunk assignment are frozen at job creation.
-- Re-running the same chunk produces the same match results (deterministic
-- AI behavior aside). The worker skips chunks whose status is already
-- 'done'.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.reconciliation_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL,
  statement_id       UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'pending',
                     -- 'pending' | 'processing' | 'done' | 'failed'

  total_chunks       INT NOT NULL DEFAULT 0,
  completed_chunks   INT NOT NULL DEFAULT 0,

  -- Snapshot of bills + per-chunk assignment, computed once at job
  -- creation so each step works against a stable set.
  -- Shape: { bills: UnmatchedBill[], chunks: number[][] }
  -- where chunks[i] is the array of bill indices in chunk i.
  payload            JSONB,

  -- Per-chunk status + processed timestamp + result counts.
  -- Shape: [{ index, status, processed_at, matches, suspicions, error }]
  chunks_state       JSONB DEFAULT '[]'::jsonb,

  -- Sets of bill/debit IDs already claimed across chunks. Worker
  -- merges its newly-used IDs into these so later chunks exclude them.
  used_bill_ids      JSONB DEFAULT '[]'::jsonb,
  used_debit_ids     JSONB DEFAULT '[]'::jsonb,

  -- Final aggregate counts (mirror of what the panel shows).
  ai_matches_applied   INT DEFAULT 0,
  ai_matches_flagged   INT DEFAULT 0,
  ai_suspicions_recorded INT DEFAULT 0,

  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reconciliation_jobs_statement_idx
  ON public.reconciliation_jobs (statement_id, created_at DESC);

CREATE INDEX IF NOT EXISTS reconciliation_jobs_user_status_idx
  ON public.reconciliation_jobs (user_id, status)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.reconciliation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reconciliation_jobs_owner_select" ON public.reconciliation_jobs;
CREATE POLICY "reconciliation_jobs_owner_select"
  ON public.reconciliation_jobs FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "reconciliation_jobs_owner_modify" ON public.reconciliation_jobs;
CREATE POLICY "reconciliation_jobs_owner_modify"
  ON public.reconciliation_jobs FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_reconciliation_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reconciliation_jobs_set_updated_at ON public.reconciliation_jobs;
CREATE TRIGGER reconciliation_jobs_set_updated_at
  BEFORE UPDATE ON public.reconciliation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_reconciliation_jobs_updated_at();

NOTIFY pgrst, 'reload schema';
