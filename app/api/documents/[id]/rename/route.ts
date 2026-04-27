import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/rename
 * Body: { filename: "mary_dental_2025" }
 *
 * User-supplied filename for a single document. Keeps the file in its
 * current Dropbox folder, only changes the filename. Original extension
 * is preserved automatically — the user doesn't need to type it.
 *
 * The filename is lightly sanitised (strip path-illegal chars, collapse
 * whitespace) but otherwise honoured as-is. This is the user expressing
 * a preference, not the auto-naming logic — so we don't force the
 * YYYYMMDD prefix or run the slugify pipeline.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/[id]/rename] start", id);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const rawInput = (body.filename ?? "").toString().trim();
    if (!rawInput) {
      return NextResponse.json(
        { error: "Provide a filename" },
        { status: 400 }
      );
    }

    const admin = await createServiceClient();
    const { data: doc, error } = await admin
      .from("documents")
      .select("id, dropbox_path, storage_provider, file_name")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!doc.dropbox_path) {
      return NextResponse.json(
        { error: "Document has no storage path yet" },
        { status: 400 }
      );
    }

    // Pull the folder + extension off the current path
    const lastSlash = doc.dropbox_path.lastIndexOf("/");
    const folder = doc.dropbox_path.slice(0, lastSlash); // no trailing slash
    const currentFilename = doc.dropbox_path.slice(lastSlash + 1);
    const extMatch = /\.([a-zA-Z0-9]{1,8})$/.exec(currentFilename);
    const extension = extMatch ? "." + extMatch[1].toLowerCase() : "";

    // Sanitise the user input — strip the bits that would break a path,
    // but otherwise keep what they typed.
    const userBase = rawInput
      .replace(/\.[a-zA-Z0-9]{1,8}$/, "") // drop any extension they typed
      .replace(/[\\/:*?"<>|]/g, "_") // path-illegal chars
      .replace(/\s+/g, "_") // collapse whitespace
      .replace(/^[._]+|[._]+$/g, "") // trim leading/trailing dots/underscores
      .slice(0, 120); // sanity cap

    if (!userBase) {
      return NextResponse.json(
        { error: "Filename is empty after cleanup" },
        { status: 400 }
      );
    }

    const newFilename = `${userBase}${extension}`;
    const destination = `${folder}/${newFilename}`;

    // Same path? nothing to do.
    if (destination === doc.dropbox_path) {
      return NextResponse.json({ ok: true, new_path: doc.dropbox_path });
    }

    const storage = getStorage(doc.storage_provider);
    const newPath = await storage.moveFile(doc.dropbox_path, destination);

    let shareLink: string | null = null;
    try {
      shareLink = await storage.getOrCreateShareLink(newPath);
    } catch (e) {
      console.warn("[api/documents/[id]/rename] share-link refresh failed", e);
    }

    const update: Record<string, unknown> = { dropbox_path: newPath };
    if (shareLink) update.dropbox_shared_link = shareLink;
    const { error: updateErr } = await admin
      .from("documents")
      .update(update)
      .eq("id", id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    console.log("[api/documents/[id]/rename] done", id, "→", newPath);
    return NextResponse.json({ ok: true, new_path: newPath });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Rename failed";
    console.error("[api/documents/[id]/rename] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
