-- ============================================================
-- Document Archive — Initial Schema Migration
-- One user, one documents table. Originals live in Dropbox.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- documents
-- ============================================================

CREATE TABLE public.documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- File reference (originals live in Dropbox)
  dropbox_path        TEXT NOT NULL,
  dropbox_shared_link TEXT,
  file_name           TEXT,
  file_type           TEXT,
  file_size_bytes     BIGINT,
  page_count          INTEGER,

  -- Classification
  document_type       TEXT,
  document_subtype    TEXT,
  confidence          NUMERIC(3, 2),

  -- Core metadata
  document_date       DATE,
  received_date       DATE DEFAULT CURRENT_DATE,
  sender              TEXT,
  recipient           TEXT,
  person              TEXT,
  language            TEXT,

  -- Financial (nullable)
  amount              NUMERIC(12, 2),
  currency            TEXT,

  -- Free-form / flexible
  title               TEXT,
  summary             TEXT,
  tags                TEXT[] DEFAULT ARRAY[]::TEXT[],
  extracted_fields    JSONB DEFAULT '{}'::jsonb,

  -- Full-text search source
  ocr_text            TEXT,
  fts                 TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sender, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(ocr_text, '')), 'C')
  ) STORED,

  -- Batch / workflow
  batch               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',
  needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
  review_notes        TEXT,

  -- Audit
  uploaded_by         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX documents_user_id_idx         ON public.documents(user_id);
CREATE INDEX documents_fts_idx             ON public.documents USING gin(fts);
CREATE INDEX documents_document_type_idx   ON public.documents(document_type);
CREATE INDEX documents_document_date_idx   ON public.documents(document_date);
CREATE INDEX documents_person_idx          ON public.documents(person);
CREATE INDEX documents_batch_idx           ON public.documents(batch);
CREATE INDEX documents_status_idx          ON public.documents(status);
CREATE INDEX documents_tags_idx            ON public.documents USING gin(tags);
CREATE INDEX documents_created_at_idx      ON public.documents(created_at DESC);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_touch_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- shortcut_tokens — used by iOS Shortcut for Share Sheet auth
-- ============================================================

CREATE TABLE public.shortcut_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX shortcut_tokens_user_id_idx ON public.shortcut_tokens(user_id);

-- ============================================================
-- Row Level Security
-- ============================================================

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shortcut_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_owner_select ON public.documents
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY documents_owner_insert ON public.documents
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY documents_owner_update ON public.documents
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY documents_owner_delete ON public.documents
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY shortcut_tokens_owner_all ON public.shortcut_tokens
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
