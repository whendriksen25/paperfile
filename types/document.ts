export type DocumentStatus =
  | "pending"
  | "processing"
  | "processed"
  | "reviewed"
  | "archived"
  | "deleted"
  | "failed";

export type ActionType =
  | "pay"
  | "respond"
  | "sign"
  | "file_with_authority"
  | "send_to_bookkeeping"
  | "other";

export type ActionStatus = "open" | "done" | "dismissed" | "snoozed";

export type HandoffStatus =
  | "not_applicable"
  | "pending"
  | "sent"
  | "failed"
  | "acked";

export interface DocumentRow {
  id: string;
  user_id: string;

  dropbox_path: string;          // canonical storage path; semantics depend on storage_provider
  dropbox_shared_link: string | null;
  storage_provider: "dropbox" | "gdrive" | "onedrive" | "s3" | "local";
  file_name: string | null;
  file_type: string | null;
  file_size_bytes: number | null;
  page_count: number | null;

  document_type: string | null;
  document_subtype: string | null;
  confidence: number | null;

  document_date: string | null;
  received_date: string | null;
  sender: string | null;
  recipient: string | null;
  person: string | null; // legacy free-text
  language: string | null;

  primary_profile_id: number | null;
  purchase_category: string | null;

  amount: number | null;
  currency: string | null;

  title: string | null;
  summary: string | null;
  tags: string[] | null;
  extracted_fields: Record<string, unknown> | null;

  ocr_text: string | null;

  needs_action: boolean;
  action_type: ActionType | null;
  due_date: string | null;
  action_summary: string | null;
  handoff_status: HandoffStatus;

  batch: string | null;
  status: DocumentStatus;
  needs_review: boolean;
  review_notes: string | null;

  // Bookkeeping handoff (one-way push to a separate bookkeeping app)
  sent_to_bookkeeping_at: string | null;
  bookkeeping_doc_id: string | null;
  bookkeeping_url: string | null;

  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentExtraction {
  document_type: string;
  document_subtype?: string | null;
  confidence: number;
  document_date?: string | null;
  sender?: string | null;
  recipient?: string | null;
  language?: string | null;
  profile_hint?: string | null;
  amount?: number | null;
  currency?: string | null;
  purchase_category?: string | null;
  title?: string | null;
  summary?: string | null;
  tags?: string[];
  extracted_fields?: Record<string, unknown>;
  ocr_text?: string;
  needs_action?: boolean;
  action_type?: ActionType | null;
  due_date?: string | null;
  action_summary?: string | null;
}

export interface ProfileRow {
  id: number;
  user_id: string;
  name: string;
  type: "person" | "business";
  color: string | null;
  is_default: boolean;

  // Identifying signals — used by Claude to auto-match documents to this profile.
  description: string | null;
  aliases: string[];
  attributes: Record<string, string>;
  ai_summary: string | null;
  website: string | null;

  created_at: string;
  updated_at: string;
}

export interface ProfileSuggestion {
  profileId: number | null;
  confidence: number;
  reason: string;
  ranked: {
    profileId: number;
    name: string;
    probability: number;
    reason: string;
  }[];
}

export interface ActionRow {
  id: string;
  user_id: string;
  document_id: string;
  profile_id: number | null;
  action_type: ActionType;
  summary: string;
  due_date: string | null;
  status: ActionStatus;
  snooze_until: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface UploadResult {
  id: string;
  dropbox_path: string;
  status: DocumentStatus;
}
