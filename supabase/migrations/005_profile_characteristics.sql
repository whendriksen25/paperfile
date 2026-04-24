-- ============================================================
-- Migration 005: Profile characteristics
--
-- Lets Claude reliably auto-assign documents to profiles by giving each
-- profile rich identifying signals: free-form description, alternative
-- names (aliases), and flexible attributes (national_id, IBAN, address,
-- insurer, etc.).
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS aliases     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS attributes  JSONB  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_summary  TEXT;

CREATE INDEX IF NOT EXISTS profiles_aliases_idx
  ON public.profiles USING gin(aliases);

-- Make PostgREST pick up the new columns without a restart
NOTIFY pgrst, 'reload schema';
