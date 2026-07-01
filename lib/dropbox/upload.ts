import { createDropbox, dropboxRootFolder } from "./client";

/**
 * Sanitises a string so it's safe as a Dropbox folder/file segment.
 */
export function safeSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}

/**
 * Uploads a file buffer to the inbox staging folder:
 *   {root}/_inbox/{timestamp}_{filename}
 *
 * Returns the canonical Dropbox path. After Claude classifies the file,
 * call moveDropboxFile() to relocate it to the structured destination.
 */
export async function uploadToDropboxInbox(params: {
  buffer: Buffer;
  filename: string;
}): Promise<{ path: string; size: number }> {
  console.log("[dropbox/upload] uploading to inbox:", params.filename);

  const dbx = createDropbox();
  const root = dropboxRootFolder();
  const filename = safeSegment(params.filename);
  const stamp = Date.now();
  const path = `${root}/_inbox/${stamp}_${filename}`;

  const result = await dbx.filesUpload({
    path,
    contents: params.buffer,
    mode: { ".tag": "add" },
    autorename: true,
    mute: true,
  });

  const dropboxPath = result.result.path_display || path;
  console.log("[dropbox/upload] uploaded:", dropboxPath);

  return {
    path: dropboxPath,
    size: result.result.size,
  };
}

/**
 * Returns a one-time, credential-free upload URL the browser can send the raw
 * file bytes to (POST, application/octet-stream), landing the file directly in
 * the inbox staging folder WITHOUT the bytes passing through our app server.
 *
 * This is what lets large / multipage documents bypass Vercel's ~4.5 MB
 * request-body limit: the phone talks straight to Dropbox. The Dropbox token
 * stays server-side — the client only ever sees this short-lived link.
 *
 * Temporary upload links accept a single file up to 150 MB and expire after a
 * few hours. Returns the link plus the canonical inbox path the bytes land at.
 */
export async function getTemporaryUploadLink(params: {
  filename: string;
}): Promise<{ uploadUrl: string; path: string }> {
  const dbx = createDropbox();
  const root = dropboxRootFolder();
  const filename = safeSegment(params.filename);
  const stamp = Date.now();
  const path = `${root}/_inbox/${stamp}_${filename}`;

  const res = await dbx.filesGetTemporaryUploadLink({
    commit_info: {
      path,
      mode: { ".tag": "add" },
      autorename: true,
      mute: true,
    },
  });

  console.log("[dropbox/upload] issued temporary upload link for:", path);
  return { uploadUrl: res.result.link, path };
}

/**
 * Authoritative file size (bytes) for a Dropbox path, or null if the file
 * isn't found / isn't a file. Used by the finalize step to confirm a
 * direct-to-Dropbox upload actually landed before we insert a document row.
 */
export async function getDropboxFileSize(path: string): Promise<number | null> {
  const dbx = createDropbox();
  try {
    const res = await dbx.filesGetMetadata({ path });
    const meta = res.result as { ".tag"?: string; size?: number };
    if (meta[".tag"] === "file" && typeof meta.size === "number") {
      return meta.size;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull the file extension off the original upload, defaulting sensibly.
 * Always lowercase, always with leading dot.
 */
function fileExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name);
  if (!m) return ".bin";
  return "." + m[1].toLowerCase();
}

/**
 * Compress a sender or title string into a tidy filename slug:
 *   - keep letters / digits / single underscores
 *   - collapse repeated separators
 *   - strip diacritics so "Apothéék BV" → "apotheek_bv"
 *   - cap at maxLen (default 40) so filenames stay scannable
 */
function slugify(input: string, maxLen = 40): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen)
    .replace(/_+$/g, "")
    .toLowerCase();
}

/**
 * Construct a logical, human-scannable filename from the doc's metadata:
 *   YYYYMMDD_{sender_or_title}.{ext}
 * e.g. "20250819_b_r_de_klyn_arts.jpg"
 *
 * Falls back gracefully when metadata is incomplete:
 *   - no date: uses today's date
 *   - no sender: tries title
 *   - no title:  uses sanitized original filename without its extension
 */
export function buildLogicalFilename(params: {
  documentDateISO?: string | null;
  sender?: string | null;
  title?: string | null;
  originalFilename: string;
}): string {
  const ext = fileExtension(params.originalFilename);
  const date = params.documentDateISO || new Date().toISOString().slice(0, 10);
  const datePart = date.replace(/-/g, "").slice(0, 8); // YYYYMMDD
  const senderSlug = slugify(params.sender || "");
  const titleSlug = slugify(params.title || "");
  const fallback = slugify(params.originalFilename.replace(/\.[^.]+$/, ""));
  const subject = senderSlug || titleSlug || fallback || "document";
  return `${datePart}_${subject}${ext}`;
}

/**
 * Builds the final Dropbox path for a classified document:
 *   {root}/{profile}/{year}/{type}/YYYYMMDD_{sender}.{ext}
 *
 * The logical-name layer is opt-in via the `sender` / `title` fields — when
 * the caller passes those, we synthesise a tidy filename. When they're not
 * passed (e.g. a doc the user manually re-files without re-running Claude),
 * we keep whatever filename was supplied.
 *
 * Falls back to "_unsorted" when profile or type are missing.
 */
export function buildDestinationPath(params: {
  profileSlug?: string | null;
  documentType?: string | null;
  documentDateISO?: string | null;
  filename: string;
  /** When provided, drives the new YYYYMMDD_{sender} naming. Optional. */
  sender?: string | null;
  /** Title fallback when sender is empty. Optional. */
  title?: string | null;
}): string {
  const root = dropboxRootFolder();
  const profile = safeSegment(params.profileSlug || "_unsorted");
  const year =
    params.documentDateISO && /^\d{4}/.test(params.documentDateISO)
      ? params.documentDateISO.slice(0, 4)
      : new Date().getFullYear().toString();
  const type = safeSegment(params.documentType || "_unsorted");

  // Use the new logical name when we have any signal to build one;
  // otherwise keep the caller's filename (preserves backward compat).
  const useLogical = !!(params.sender || params.title);
  const filename = useLogical
    ? safeSegment(
        buildLogicalFilename({
          documentDateISO: params.documentDateISO,
          sender: params.sender,
          title: params.title,
          originalFilename: params.filename,
        })
      )
    : safeSegment(params.filename);
  return `${root}/${profile}/${year}/${type}/${filename}`;
}

/**
 * Upload a buffer to an explicit Dropbox path (used for exports etc.).
 */
export async function uploadDropboxAt(params: {
  buffer: Buffer;
  path: string;
}): Promise<{ path: string; size: number }> {
  console.log("[dropbox/uploadAt]", params.path);
  const dbx = createDropbox();
  const result = await dbx.filesUpload({
    path: params.path,
    contents: params.buffer,
    mode: { ".tag": "overwrite" },
    autorename: false,
    mute: true,
  });
  return {
    path: result.result.path_display || params.path,
    size: result.result.size,
  };
}

/**
 * Move a file inside Dropbox. Returns the new path (which may differ from
 * `to` if Dropbox auto-renamed to avoid a collision).
 */
export async function moveDropboxFile(
  from: string,
  to: string
): Promise<string> {
  console.log("[dropbox/move]", from, "->", to);
  const dbx = createDropbox();
  const result = await dbx.filesMoveV2({
    from_path: from,
    to_path: to,
    autorename: true,
    allow_shared_folder: false,
    allow_ownership_transfer: false,
  });
  // metadata is on result.result.metadata
  const meta = result.result.metadata as { path_display?: string };
  return meta.path_display || to;
}

/**
 * Generates (or fetches the existing) shared link for a path so the UI can
 * render the file inline. Returns null on failure (the app will fall back to
 * an on-demand temporary link).
 */
export async function getOrCreateShareLink(
  dropboxPath: string
): Promise<string | null> {
  const dbx = createDropbox();
  try {
    const link = await dbx.sharingCreateSharedLinkWithSettings({
      path: dropboxPath,
    });
    return link.result.url.replace(
      "www.dropbox.com",
      "dl.dropboxusercontent.com"
    );
  } catch {
    try {
      const existing = await dbx.sharingListSharedLinks({
        path: dropboxPath,
        direct_only: true,
      });
      if (existing.result.links.length > 0) {
        return existing.result.links[0].url.replace(
          "www.dropbox.com",
          "dl.dropboxusercontent.com"
        );
      }
    } catch {
      /* swallow */
    }
    return null;
  }
}

/**
 * Returns a temporary signed link so the frontend can render the file.
 */
export async function getTemporaryLink(dropboxPath: string): Promise<string> {
  const dbx = createDropbox();
  const result = await dbx.filesGetTemporaryLink({ path: dropboxPath });
  return result.result.link;
}

/**
 * Downloads a file from Dropbox for re-extraction / analysis.
 */
export async function downloadFromDropbox(dropboxPath: string): Promise<Buffer> {
  const dbx = createDropbox();
  const result = await dbx.filesDownload({ path: dropboxPath });
  const fileBinary = (
    result.result as unknown as { fileBinary: ArrayBuffer | Buffer }
  ).fileBinary;
  if (!fileBinary) throw new Error("Dropbox download returned no content");
  return Buffer.from(fileBinary as ArrayBuffer);
}
