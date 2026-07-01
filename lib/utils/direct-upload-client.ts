"use client";

/**
 * Client helpers for the direct-to-Dropbox upload flow.
 *
 * The file bytes go straight from the browser to Dropbox (via a one-time link
 * our server mints), so they never pass through the Vercel function and are not
 * subject to its ~4.5 MB request-body limit. Only small metadata touches our
 * app server.
 */

/** SHA-256 of a Blob/File as a lowercase hex string (matches the server's crypto hash). */
export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface DirectUploadMeta {
  combine?: boolean;
  batch?: string | null;
  profileId?: number | string | null;
  tags?: string[];
}

export interface FinalizeResult {
  data?: { id: string; status?: string; dropbox_path?: string };
  duplicate?: boolean;
  duplicate_of?: string;
  duplicate_reason?: string;
}

/**
 * Upload a single file directly to storage and finalize it into a documents
 * row. Three hops:
 *   1) ask our server for a one-time upload URL (POST /api/upload/dropbox-link)
 *   2) send the bytes straight to Dropbox (POST to that URL)
 *   3) tell our server to record + analyse it (POST /api/upload/finalize)
 */
export async function directUpload(
  file: File,
  meta: DirectUploadMeta = {}
): Promise<FinalizeResult> {
  // 1. One-time upload URL from our server (Dropbox token stays server-side).
  const linkRes = await fetch("/api/upload/dropbox-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: file.name }),
  });
  if (!linkRes.ok) throw new Error(await linkRes.text());
  const { uploadUrl, path } = (await linkRes.json()) as {
    uploadUrl: string;
    path: string;
  };

  // 2. Hash the exact bytes (for server-side dedup) and send them straight to
  //    Dropbox. A Dropbox temporary upload link takes the raw body via POST.
  const contentHash = await sha256Hex(file);
  const putRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => "");
    throw new Error(`Storage upload failed (${putRes.status}). ${detail}`.trim());
  }

  // 3. Finalize → documents row + async analysis.
  const finRes = await fetch("/api/upload/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path,
      fileName: file.name,
      fileType: file.type || null,
      fileSizeBytes: file.size,
      contentHash,
      combine: !!meta.combine,
      batch: meta.batch ?? null,
      profileId: meta.profileId ?? null,
      tags: meta.tags ?? [],
    }),
  });
  if (!finRes.ok) throw new Error(await finRes.text());
  return (await finRes.json()) as FinalizeResult;
}
