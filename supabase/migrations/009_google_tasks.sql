-- =============================================================================
-- 009_google_tasks.sql
-- Tracks the link between a Paperfile action and a Google Task so we can
-- mark it done in both directions.
-- =============================================================================

ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS google_task_id      TEXT,
  ADD COLUMN IF NOT EXISTS google_task_list_id TEXT,
  ADD COLUMN IF NOT EXISTS google_task_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS actions_google_task_idx
  ON public.actions (google_task_id)
  WHERE google_task_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
