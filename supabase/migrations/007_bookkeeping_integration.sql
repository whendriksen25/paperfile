-- =============================================================================
-- 007_bookkeeping_integration.sql
-- Adds the plumbing for "Send to bookkeeping" — an opt-in handoff that copies
-- the file + metadata to a separate bookkeeping app.
--
-- 1. New columns on documents to track whether/when/how the doc was sent.
-- 2. New action_type 'send_to_bookkeeping' so each pending handoff appears in
--    the user's actions list (a separate process they do later).
-- 3. New user_settings table — keyed by user_id — stores the bookkeeping app
--    URL + shared secret. URL/secret are configurable per user so different
--    users can wire to their own bookkeeping instance.
-- =============================================================================

-- 1. Tracking columns on documents
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS sent_to_bookkeeping_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bookkeeping_doc_id     TEXT,
  ADD COLUMN IF NOT EXISTS bookkeeping_url        TEXT;

-- 2. Allow the new action_type. Drop and recreate the CHECK constraint to
--    avoid a migration-incompatible name; we use IF EXISTS for idempotency.
ALTER TABLE public.actions
  DROP CONSTRAINT IF EXISTS actions_action_type_check;
ALTER TABLE public.actions
  ADD CONSTRAINT actions_action_type_check
  CHECK (action_type IN (
    'pay',
    'respond',
    'sign',
    'file_with_authority',
    'send_to_bookkeeping',
    'other'
  ));

-- 2b. A document can now legitimately have MULTIPLE actions
-- ("Pay €76.60" AND "Send to bookkeeping"), so swap the existing
-- one-action-per-document unique index for a one-per-(document, type) one.
DROP INDEX IF EXISTS public.actions_one_per_document;
CREATE UNIQUE INDEX IF NOT EXISTS actions_one_per_document_type
  ON public.actions(document_id, action_type);

-- 3. Per-user settings (bookkeeping URL, shared secret, future preferences)
CREATE TABLE IF NOT EXISTS public.user_settings (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS so each user only sees their own settings row
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_settings_select_own" ON public.user_settings;
CREATE POLICY "user_settings_select_own" ON public.user_settings
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_settings_insert_own" ON public.user_settings;
CREATE POLICY "user_settings_insert_own" ON public.user_settings
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_settings_update_own" ON public.user_settings;
CREATE POLICY "user_settings_update_own" ON public.user_settings
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Refresh PostgREST schema cache so the new column + table become queryable
NOTIFY pgrst, 'reload schema';
