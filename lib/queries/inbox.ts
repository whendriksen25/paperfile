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
  "extracted_fields_payment_status:extracted_fields->payment_status, " +
  // Bank-statement-only summaries — null for any other document type.
  // Used by the inbox card to render "5 txns · €294 out · 0/5 reconciled"
  // without joining bank_transactions or pulling the full extracted_fields.
  "extracted_fields_bank_summary:extracted_fields->_bank_summary, " +
  "extracted_fields_reconciliation:extracted_fields->_reconciliation, " +
  "extracted_fields_first_seen:extracted_fields->_first_seen_sender";

/**
 * Convert one projected row back to the `DocumentRow` shape the cards expect.
 * Re-attaches the projected payment_status under `extracted_fields` so the
 * card's `extracted_fields.payment_status` lookup keeps working unchanged.
 */
export function reshapeInboxRow(row: Record<string, unknown>): DocumentRow {
  const ps = row.extracted_fields_payment_status;
  const bs = row.extracted_fields_bank_summary;
  const rc = row.extracted_fields_reconciliation;
  const fs = row.extracted_fields_first_seen;
  const out = { ...row };
  delete out.extracted_fields_payment_status;
  delete out.extracted_fields_bank_summary;
  delete out.extracted_fields_reconciliation;
  delete out.extracted_fields_first_seen;
  // Re-attach the projected JSON keys under their canonical extracted_fields
  // shape so the card can keep reading `extracted_fields.X` unchanged.
  const ef: Record<string, unknown> = {};
  if (ps !== undefined && ps !== null) ef.payment_status = ps;
  if (bs !== undefined && bs !== null) ef._bank_summary = bs;
  if (rc !== undefined && rc !== null) ef._reconciliation = rc;
  if (fs !== undefined && fs !== null) ef._first_seen_sender = fs;
  return {
    ...out,
    extracted_fields: Object.keys(ef).length ? ef : null,
  } as unknown as DocumentRow;
}

export const INBOX_PAGE_SIZE = 10;
