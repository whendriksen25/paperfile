-- =============================================================================
-- 020_analyze_jobs.sql
-- Background job table for multi-document analyze ("re-analyse full scan").
--
-- Why: when a user clicks "Re-analyse full scan" on a multi-receipt
-- scan, the existing /api/analyze/[id] route does detection + cropping
-- + per-crop re-extraction all inline. On Vercel Hobby (60s function
-- limit), scans with ≥4 receipts blow past the timeout — detection
-- alone is ~10s and each per-crop Sonnet call is another ~20s. Even
-- with parallel crop extraction, a 4-receipt scan can flirt with the
-- ceiling, and 5+ receipts reliably die before the parent doc gets
-- updated.
--
-- Mirrors the reconciliation_jobs design (migration 017). One row per
-- "re-analyse full scan" invocation; the worker advances one crop per
-- HTTP call, so each call comfortably finishes inside the function
-- budget.
--
-- Lifecycle of a job:
--   1. /api/analyze-job/start runs the synchronous prepare step
--      (download original full scan, auto-rotate, call Sonnet for
--      multi-doc detection, crop each receipt, upload crops to
--      storage). Inserts a row with status='processing', one step per
--      crop in steps_state.
--   2. The progress panel polls /api/analyze-job/[jobId] every ~1.5s
--      for state; the GET endpoint auto-kicks the worker if a step is
--      pending and nothing is in-flight.
--   3. /api/analyze-step/[jobId] picks the first pending step, runs
--      Sonnet extractDocument on that one crop (~15-25s), inserts the
--      child document row, increments completed_crops.
--   4. When the last step finishes, the worker runs the dedup-on-
--      resplit cleanup (delete OLD children + their actions where
--      parent_document_id = parent.id AND id NOT IN newly-spawned set),
--      writes _original_scan_path into the parent's extracted_fields,
--      flips status='done'.
--
-- Idempotency: detected boxes + crop paths are snapshotted in payload
-- at job creation. Re-running an already-processed step is skipped
-- (status check); the only mutable state is the per-step status and
-- the parent's final dedup.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.analyze_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL,
  document_id        UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,

  status             TEXT NOT NULL DEFAULT 'pending',
                     -- 'pending' | 'processing' | 'done' | 'failed'

  -- Current phase label for the progress UI. Keeps the user oriented
  -- ("cropping", "extracting", "finalising") without needing to derive
  -- it from completed_crops vs total_crops alone.
  phase              TEXT,
                     -- 'detecting' | 'cropping' | 'extracting' | 'finalising' | 'done' | 'failed'

  total_crops        INT NOT NULL DEFAULT 0,
  completed_crops    INT NOT NULL DEFAULT 0,

  -- Frozen snapshot at job creation. Shape:
  --   { from_original: bool,
  --     force_profile: bool,
  --     original_path:  string,
  --     detected_docs:  [{sender, amount, document_date, summary}, ...],
  --     boxes:          [{x, y, w, h}, ...],
  --     crop_paths:     [string, ...] }
  payload            JSONB,

  -- Per-step state: one entry per crop, in detection order.
  -- Shape: [{ index, status: 'pending'|'processing'|'done'|'failed',
  --           started_at, completed_at, child_doc_id, error,
  --           sender_hint, amount_hint }]
  steps_state        JSONB DEFAULT '[]'::jsonb,

  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analyze_jobs_document_idx
  ON public.analyze_jobs (document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS analyze_jobs_user_status_idx
  ON public.analyze_jobs (user_id, status)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.analyze_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "analyze_jobs_owner_select" ON public.analyze_jobs;
CREATE POLICY "analyze_jobs_owner_select"
  ON public.analyze_jobs FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "analyze_jobs_owner_modify" ON public.analyze_jobs;
CREATE POLICY "analyze_jobs_owner_modify"
  ON public.analyze_jobs FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_analyze_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS analyze_jobs_set_updated_at ON public.analyze_jobs;
CREATE TRIGGER analyze_jobs_set_updated_at
  BEFORE UPDATE ON public.analyze_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_analyze_jobs_updated_at();

NOTIFY pgrst, 'reload schema';
