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
 * Builds the final Dropbox path for a classified document:
 *   {root}/{profile}/{year}/{type}/{filename}
 *
 * Falls back to "_unsorted" when profile or type are missing.
 */
export function buildDestinationPath(params: {
  profileSlug?: string | null;
  documentType?: string | null;
  documentDateISO?: string | null;
  filename: string;
}): string {
  const root = dropboxRootFolder();
  const profile = safeSegment(params.profileSlug || "_unsorted");
  const year =
    (params.documentDateISO && /^\d{4}/.test(params.documentDateISO)
      ? params.documentDateISO.slice(0, 4)
      : new Date().getFullYear().toString());
  const type = safeSegment(params.documentType || "_unsorted");
  const filename = safeSegment(params.filename);
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
