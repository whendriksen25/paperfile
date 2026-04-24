-- ============================================================
-- Document Archive — Migration 003: Actions + categorisation extras
--
-- Adds:
--   - new columns on documents (purchase_category, action fields, handoff_status)
--   - actions table (one row per actionable document)
-- ============================================================

-- New columns on documents
ALTER TABLE public.documents
  ADD COLUMN purchase_category TEXT,                       -- food, material, clothing, transport, health, ...
  ADD COLUMN needs_action      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN action_type       TEXT,                       -- pay | respond | sign | file_with_authority | none
  ADD COLUMN due_date          DATE,
  ADD COLUMN action_summary    TEXT,
  ADD COLUMN handoff_status    TEXT NOT NULL DEFAULT 'not_applicable'
                                  CHECK (handoff_status IN ('not_applicable', 'pending', 'sent', 'failed', 'acked'));

CREATE INDEX documents_purchase_category_idx ON public.documents(purchase_category);
CREATE INDEX documents_needs_action_idx      ON public.documents(needs_action) WHERE needs_action = TRUE;
CREATE INDEX documents_due_date_idx          ON public.documents(due_date) WHERE due_date IS NOT NULL;

-- ============================================================
-- actions
-- ============================================================

CREATE TABLE public.actions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  document_id   UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  profile_id    INTEGER REFERENCES public.profiles(id) ON DELETE SET NULL,

  action_type   TEXT NOT NULL
                  CHECK (action_type IN ('pay', 'respond', 'sign', 'file_with_authority', 'other')),
  summary       TEXT NOT NULL,
  due_date      DATE,

  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'done', 'dismissed', 'snoozed')),
  snooze_until  DATE,
  notes         TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX actions_user_id_idx       ON public.actions(user_id);
CREATE INDEX actions_document_id_idx   ON public.actions(document_id);
CREATE INDEX actions_profile_id_idx    ON public.actions(profile_id);
CREATE INDEX actions_status_idx        ON public.actions(status);
CREATE INDEX actions_due_date_idx      ON public.actions(due_date)
  WHERE status IN ('open', 'snoozed');
CREATE UNIQUE INDEX actions_one_per_document
  ON public.actions(document_id);

CREATE TRIGGER actions_touch_updated_at
BEFORE UPDATE ON public.actions
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS
ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY actions_owner_select ON public.actions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY actions_owner_insert ON public.actions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY actions_owner_update ON public.actions
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY actions_owner_delete ON public.actions
  FOR DELETE USING (auth.uid() = user_id);
