-- ============================================================
-- Migration 006: Profile website
-- For business profiles, store the homepage URL. Used by the AI enrichment
-- endpoint to auto-fill description / aliases / attributes.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS website TEXT;

-- Make PostgREST pick up the new column without a restart
NOTIFY pgrst, 'reload schema';
