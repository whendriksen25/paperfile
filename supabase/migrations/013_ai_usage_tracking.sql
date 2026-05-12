-- =============================================================================
-- 013_ai_usage_tracking.sql
-- Per-document AI usage tracking + truncation detection.
--
-- Lets the user see what each Claude call cost (input/output tokens) and
-- catches the rare doc whose output hit the 64k cap so they can opt to
-- retry with the 128k beta cap.
-- =============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS ai_input_tokens   INTEGER,
  ADD COLUMN IF NOT EXISTS ai_output_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS ai_truncated      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_stop_reason    TEXT,
  ADD COLUMN IF NOT EXISTS ai_max_tokens_cap INTEGER;

CREATE INDEX IF NOT EXISTS documents_truncated_idx
  ON public.documents (ai_truncated)
  WHERE ai_truncated = TRUE;

NOTIFY pgrst, 'reload schema';
