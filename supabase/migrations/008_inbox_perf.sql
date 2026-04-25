-- =============================================================================
-- 008_inbox_perf.sql
-- Performance work for the documents table at scale (1k+ docs per user).
--
-- 1. Composite indexes that match how the inbox actually queries
-- 2. Server-side aggregate function for category-pill counts
--    (replaces a "select document_type from documents" full scan)
-- 3. GIN index on extracted_fields so future JSONB filters are cheap
-- =============================================================================

-- Drop the single-column status / type / created_at indexes — they're now
-- subsumed by composite indexes below. Keep them as IF EXISTS in case a
-- user is on an older partial migration.
-- (Postgres will still use composite indexes for single-column filters as
-- long as user_id is the leading column and we filter on it — which we
-- always do via RLS + .eq("user_id", ...).)

-- (a) The main inbox query: WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS documents_user_status_created_idx
  ON public.documents (user_id, status, created_at DESC);

-- (b) Profile-filtered inbox: WHERE user_id = ? AND primary_profile_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS documents_user_profile_created_idx
  ON public.documents (user_id, primary_profile_id, created_at DESC);

-- (c) Type-filtered inbox: WHERE user_id = ? AND document_type = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS documents_user_type_created_idx
  ON public.documents (user_id, document_type, created_at DESC);

-- (d) Bookkeeping handoff lookups: WHERE user_id = ? AND sent_to_bookkeeping_at IS NULL
CREATE INDEX IF NOT EXISTS documents_user_unsent_idx
  ON public.documents (user_id)
  WHERE sent_to_bookkeeping_at IS NULL;

-- (e) JSONB indexing — supports future filters like extracted_fields->>'payment_status' = 'paid'
CREATE INDEX IF NOT EXISTS documents_extracted_fields_gin_idx
  ON public.documents USING gin (extracted_fields);

-- (f) Action-list queries: WHERE user_id = ? AND status = 'open' ORDER BY due_date
CREATE INDEX IF NOT EXISTS actions_user_status_due_idx
  ON public.actions (user_id, status, due_date);

-- =============================================================================
-- Aggregate function for category pills.
-- Returns each (document_type, count) pair for the calling user, computed
-- server-side via GROUP BY instead of pulling N rows over the wire.
-- Uses SECURITY INVOKER so RLS still applies (the user only sees their counts).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.documents_type_counts()
RETURNS TABLE (document_type TEXT, n BIGINT)
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT document_type, COUNT(*)::bigint AS n
  FROM public.documents
  WHERE user_id = auth.uid()
    AND status <> 'deleted'
    AND document_type IS NOT NULL
  GROUP BY document_type
  ORDER BY n DESC;
$$;

GRANT EXECUTE ON FUNCTION public.documents_type_counts() TO authenticated;

-- Refresh PostgREST schema cache so the new function and indexes
-- become callable immediately.
NOTIFY pgrst, 'reload schema';
