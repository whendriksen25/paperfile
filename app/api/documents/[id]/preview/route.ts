import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Streams a document file inline for the document detail page preview pane.
 *
 *   - Auth: caller must be the owner of the row (RLS-style check via
 *     service-role lookup so we never leak rows we shouldn't).
 *   - Body: raw file bytes from whichever storage adapter the row uses.
 *   - Headers: Content-Type from the row (or sniffed from extension), and
 *     Content-Disposition: inline so browsers render rather than download.
 *
 * Used by the document detail page like:
 *   <img src="/api/documents/{id}/preview" />          for images
 *   <iframe src="/api/documents/{id}/preview" />       for PDFs
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ?original=1 — for multi-doc parents whose dropbox_path was
  // repointed to _part1.jpg after the split, this serves the FULL
  // original multi-receipt scan stored in extracted_fields
  // ._original_scan_path. Falls back to dropbox_path if not set.
  const wantOriginal = request.nextUrl.searchParams.get("original") === "1";
  // ?download=1 — serve as an attachment (browser saves to the user's
  // machine) instead of inline, named after the meaningful storage
  // filename (e.g. 20260106_ekoplaza_dieren.jpg) rather than the
  // generic upload name (image.jpg).
  const wantDownload = request.nextUrl.searchParams.get("download") === "1";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Look up the document via service role then verify ownership ourselves.
  const admin = await createServiceClient();
  const { data: doc, error } = await admin
    .from("documents")
    .select(
      "id, user_id, dropbox_path, storage_provider, file_name, file_type, extracted_fields"
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (doc.user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Pick which file to serve.
  let downloadPath = doc.dropbox_path;
  if (wantOriginal) {
    const ef = doc.extracted_fields as Record<string, unknown> | null;
    const originalPath =
      (ef?.["_original_scan_path"] as string | undefined) || null;
    if (originalPath) downloadPath = originalPath;
  }

  try {
    const storage = getStorage(doc.storage_provider);
    const buffer = await storage.downloadFile(downloadPath);

    const contentType =
      doc.file_type && doc.file_type.length > 0
        ? doc.file_type
        : sniffMime(doc.file_name || "");

    // For downloads prefer the logical archive filename from the storage
    // path — that's the name the user recognises from the library.
    const storageName = downloadPath.split("/").pop() || "";
    const filename = wantDownload
      ? storageName || doc.file_name || "document"
      : doc.file_name || "document";

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `${wantDownload ? "attachment" : "inline"}; filename="${escapeFilename(filename)}"`,
        // Brief private cache — file rarely changes once analysed but the URL
        // is per-doc so a new doc-id always re-fetches.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "preview failed";
    console.error("[api/documents/[id]/preview] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function sniffMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function escapeFilename(name: string): string {
  return name.replace(/[\\"]/g, "_");
}
