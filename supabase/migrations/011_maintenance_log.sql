-- =============================================================================
-- 011_maintenance_log.sql
-- Audit trail for the self-healing pipeline.
--
-- Every change the sanity-check service or refile-propagation makes is
-- recorded here so the user can see what was changed automatically.
-- Enables a "recent maintenance activity" view and (later) an undo flow.
--
-- Kept intentionally simple: one row per change, JSON payload for the
-- before/after diff, no FKs to documents (so deleting a doc doesn't
-- cascade-wipe its history).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.maintenance_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  document_id UUID,                    -- soft ref; no FK by design
  kind        TEXT NOT NULL,           -- 'orphan_repoint' | 'reclassify' | 'propagate_refile'
  reason      TEXT,                    -- short human-readable explanation
  payload     JSONB,                   -- {from: ..., to: ..., sender: ..., etc}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS maintenance_log_user_idx
  ON public.maintenance_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS maintenance_log_doc_idx
  ON public.maintenance_log (document_id)
  WHERE document_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
