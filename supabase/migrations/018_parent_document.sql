-- =============================================================================
-- 018_parent_document.sql
-- Multi-document detection: when one scan contains multiple distinct
-- documents (e.g. four supermarket receipts on a single phone photo),
-- the analyze pipeline now splits them into separate rows. The first
-- becomes the "parent" (keeps the original row + dropbox_path), the
-- rest become children with parent_document_id pointing back at it.
--
-- All children share the SAME dropbox_path as the parent — the
-- physical scan in Dropbox is one file. Each row is independent in
-- every other respect: own sender, amount, line_items, profile,
-- actions, bank matches.
-- =============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS parent_document_id UUID REFERENCES public.documents(id) ON DELETE SET NULL;

-- Fast sibling lookup: "give me all docs that share this scan with me".
CREATE INDEX IF NOT EXISTS documents_parent_idx
  ON public.documents (parent_document_id)
  WHERE parent_document_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
