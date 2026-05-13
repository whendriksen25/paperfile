-- =============================================================================
-- 016_match_method_and_suspicions.sql
-- Adds the metadata needed for autonomous-with-transparency reconciliation:
--
--   match_method      — provenance of the match (which layer matched it)
--                       'deterministic' | 'ai_high' | 'ai_review' | 'manual'
--                       (null on rows that haven't been touched yet)
--   match_confidence  — 0.0–1.0 score from the matcher
--                       ('deterministic' rows get 1.0; 'ai_high' >= 0.8,
--                        'ai_review' 0.5–0.79; below 0.5 → no match, see
--                        suspicions instead)
--   suspicions        — JSONB array of low-confidence observations on rows
--                       that weren't matched outright: cash withdrawals
--                       coinciding with an invoice amount, transfers without
--                       a clear reference, that sort of thing. Shape:
--                       [{
--                         possible_doc_id: uuid,
--                         possible_action_id: uuid,
--                         reasoning: text,
--                         confidence: 0..1
--                       }, ...]
--                       null when the matcher had nothing to say.
-- =============================================================================

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS match_method TEXT,
  ADD COLUMN IF NOT EXISTS match_confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS suspicions JSONB;

-- Index suspicions by JSONB existence so "show me debits with any
-- suspicion to review" is a fast query.
CREATE INDEX IF NOT EXISTS bank_transactions_has_suspicions_idx
  ON public.bank_transactions (statement_id)
  WHERE suspicions IS NOT NULL AND jsonb_array_length(suspicions) > 0;

NOTIFY pgrst, 'reload schema';
