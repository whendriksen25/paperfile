/**
 * Storage adapter interface — abstracts where original document files live.
 *
 * Today only `dropbox` is implemented (lib/storage/dropbox-adapter.ts).
 * Future adapters (gdrive, onedrive, s3, local) implement this interface
 * and are wired into lib/storage/index.ts.
 *
 * Each `documents` row has a `storage_provider` column saying which adapter
 * its `dropbox_path` (legacy column name; treat as "storage path") refers to.
 */

export type StorageProvider =
  | "dropbox"
  | "gdrive"
  | "onedrive"
  | "s3"
  | "local";

export interface UploadResult {
  /** Canonical path returned by the storage backend (may differ from requested path). */
  path: string;
  /** File size in bytes as reported by the backend. */
  size: number;
}

export interface BuildDestinationParams {
  profileSlug?: string | null;
  documentType?: string | null;
  documentDateISO?: string | null;
  filename: string;
  /** When provided, drives the YYYYMMDD_{sender} logical filename. */
  sender?: string | null;
  /** Title fallback when sender is empty. */
  title?: string | null;
}

export interface StorageAdapter {
  /** Identifier stored in the documents.storage_provider column. */
  readonly provider: StorageProvider;

  /**
   * Upload a buffer to the staging "inbox" location. Used at upload time before
   * the document has been classified. Returns the canonical path.
   */
  uploadToInbox(params: {
    buffer: Buffer;
    filename: string;
  }): Promise<UploadResult>;

  /**
   * Move a file inside the storage backend. Returns the new path
   * (which may differ from `to` if the backend auto-renamed to avoid collision).
   */
  moveFile(from: string, to: string): Promise<string>;

  /** Download the file contents as a Buffer. */
  downloadFile(path: string): Promise<Buffer>;

  /**
   * Get-or-create a long-lived shareable URL. Returns null if the backend
   * doesn't support shared links or creation failed (caller should fall back
   * to a temporary link on demand).
   */
  getOrCreateShareLink(path: string): Promise<string | null>;

  /** Get a short-lived signed URL for inline rendering. */
  getTemporaryLink(path: string): Promise<string>;

  /**
   * Upload a buffer to an explicit path (used by export features that need
   * to write to a known location, not the inbox staging folder).
   */
  uploadAt(params: { buffer: Buffer; path: string }): Promise<UploadResult>;

  /**
   * Build the destination path for a classified document, given profile, type,
   * date, and filename. Each adapter decides the structure (typically
   * `{root}/{profile}/{year}/{type}/{filename}`).
   */
  buildDestinationPath(params: BuildDestinationParams): string;
}
