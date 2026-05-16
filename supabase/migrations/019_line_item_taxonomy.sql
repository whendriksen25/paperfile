-- =============================================================================
-- 019_line_item_taxonomy.sql
-- Growing per-user "glossary" of canonical sub-category tokens used in
-- line_items.category_path. Prevents the apple / apples / appel / Apple
-- drift across receipts.
--
-- Each row is one canonical token (e.g. "apple") under one top-level
-- category ("groceries"). aliases is the list of variants we've folded
-- into this canonical form ("apples", "Apple ", "appels"). usage_count
-- tracks how often we've seen it so we can sort taxonomy listings by
-- popularity.
--
-- The taxonomy is per-user — different households categorise differently.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.line_item_taxonomy (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  top_category  TEXT NOT NULL, -- one of the 25 canonical keys in lib/categories.ts
  token         TEXT NOT NULL, -- canonical lowercase singular form
  aliases       TEXT[] NOT NULL DEFAULT '{}',
  usage_count   INT NOT NULL DEFAULT 1,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, top_category, token)
);

CREATE INDEX IF NOT EXISTS line_item_taxonomy_user_top_idx
  ON public.line_item_taxonomy (user_id, top_category);

-- Fast lookup by alias when canonicalising a new token: "did anyone
-- ever register a variant that maps to a canonical we already have?"
CREATE INDEX IF NOT EXISTS line_item_taxonomy_aliases_gin_idx
  ON public.line_item_taxonomy USING GIN (aliases);

ALTER TABLE public.line_item_taxonomy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "line_item_taxonomy_owner_select"
  ON public.line_item_taxonomy;
CREATE POLICY "line_item_taxonomy_owner_select"
  ON public.line_item_taxonomy FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "line_item_taxonomy_owner_modify"
  ON public.line_item_taxonomy;
CREATE POLICY "line_item_taxonomy_owner_modify"
  ON public.line_item_taxonomy FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_line_item_taxonomy_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS line_item_taxonomy_set_updated_at
  ON public.line_item_taxonomy;
CREATE TRIGGER line_item_taxonomy_set_updated_at
  BEFORE UPDATE ON public.line_item_taxonomy
  FOR EACH ROW EXECUTE FUNCTION public.touch_line_item_taxonomy_updated_at();

NOTIFY pgrst, 'reload schema';
