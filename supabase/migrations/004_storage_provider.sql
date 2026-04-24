-- ============================================================
-- Document Archive — Migration 004: Storage provider column
--
-- Lays groundwork for swappable file storage backends. Today only Dropbox
-- is implemented; future adapters can be added (gdrive, onedrive, s3, local)
-- without changing the schema again.
--
-- The dropbox_path / dropbox_shared_link column names are kept for historical
-- consistency. Treat them as "the path/link in whichever provider
-- storage_provider names." A future migration may rename them to storage_path
-- / share_link if desired.
-- ============================================================

ALTER TABLE public.documents
  ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'dropbox'
    CHECK (storage_provider IN ('dropbox', 'gdrive', 'onedrive', 's3', 'local'));

CREATE INDEX documents_storage_provider_idx
  ON public.documents(storage_provider);
