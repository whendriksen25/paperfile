import type { DocumentRow } from "@/types/document";

/**
 * Slim projection for the inbox card list. Excludes the heavy `ocr_text`
 * and full `extracted_fields` blob — pulls only the single nested key the
 * card needs (payment_status). Both the server-rendered initial page and
 * the /api/documents pagination endpoint use this so the wire format is
 * identical.
 */
export const INBOX_CARD_FIELDS =
  "id, file_name, file_type, status, document_type, document_subtype, " +
  "document_date, sender, recipient, primary_profile_id, amount, currency, " +
  "purchase_category, title, summary, tags, batch, dropbox_path, " +
  "dropbox_shared_link, storage_provider, needs_action, action_type, " +
  "due_date, action_summary, sent_to_bookkeeping_at, bookkeeping_doc_id, " +
  "needs_review, review_notes, confidence, created_at, updated_at, " +
  "extracted_fields_payment_status:extracted_fields->payment_status";

/**
 * Convert one projected row back to the `DocumentRow` shape the cards expect.
 * Re-attaches the projected payment_status under `extracted_fields` so the
 * card's `extracted_fields.payment_status` lookup keeps working unchanged.
 */
export function reshapeInboxRow(row: Record<string, unknown>): DocumentRow {
  const ps = row.extracted_fields_payment_status;
  const out = { ...row };
  delete out.extracted_fields_payment_status;
  return {
    ...out,
    extracted_fields: ps ? { payment_status: ps } : null,
  } as unknown as DocumentRow;
}

export const INBOX_PAGE_SIZE = 10;
