-- ============================================================
-- Document Archive — Migration 002: Profiles
-- Adds the per-person/per-entity profile concept.
-- A document can be filed under a profile (e.g. "Wim", "Father", "LLC").
-- ============================================================

CREATE TABLE public.profiles (
  id           SERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'person'
                  CHECK (type IN ('person', 'business')),
  color        TEXT,
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX profiles_user_id_idx ON public.profiles(user_id);
CREATE UNIQUE INDEX profiles_user_default_unique
  ON public.profiles(user_id) WHERE is_default = TRUE;

CREATE TRIGGER profiles_touch_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Add the FK on documents
ALTER TABLE public.documents
  ADD COLUMN primary_profile_id INTEGER REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX documents_primary_profile_id_idx
  ON public.documents(primary_profile_id);

-- RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_owner_select ON public.profiles
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY profiles_owner_insert ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY profiles_owner_update ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY profiles_owner_delete ON public.profiles
  FOR DELETE USING (auth.uid() = user_id);

-- Auto-create a default profile when a user signs up
CREATE OR REPLACE FUNCTION public.ensure_default_profile()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, name, type, is_default)
  VALUES (NEW.id, 'Me', 'person', TRUE)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS auth_users_create_default_profile ON auth.users;
CREATE TRIGGER auth_users_create_default_profile
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.ensure_default_profile();

-- Backfill: any existing user without a profile gets one
INSERT INTO public.profiles (user_id, name, type, is_default)
SELECT u.id, 'Me', 'person', TRUE
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.user_id = u.id
);
