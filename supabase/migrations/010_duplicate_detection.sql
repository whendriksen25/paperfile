-- =============================================================================
-- 010_duplicate_detection.sql
-- Two-layer duplicate detection.
--
--  Layer 1: content_hash — SHA-256 of the uploaded buffer (after combine for
--    multi-page docs). Used at upload time to block exact-byte duplicates
--    before they reach Dropbox or create a new row.
--
--  Layer 2: possible_duplicate_of — soft pointer set during analyze when
--    another document owned by the same user matches on sender + date +
--    amount + document_type. Surfaces a banner on the detail page; doesn't
--    block. The user can decide to keep both or delete one.
-- =============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS content_hash         TEXT,
  ADD COLUMN IF NOT EXISTS possible_duplicate_of UUID REFERENCES public.documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_user_hash_idx
  ON public.documents (user_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_possible_duplicate_idx
  ON public.documents (possible_duplicate_of)
  WHERE possible_duplicate_of IS NOT NULL;

NOTIFY pgrst, 'reload schema';
