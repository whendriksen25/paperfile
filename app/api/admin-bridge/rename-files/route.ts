import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
// Long-running: each move is a Dropbox API call. Allow plenty of headroom.
export const maxDuration = 300;

/**
 * Dev-only: walks every document for the calling user, computes the new
 * logical filename via the storage adapter (YYYYMMDD_{sender}.{ext}),
 * moves the file in Dropbox, refreshes the share link, and writes the
 * new path back to the documents row.
 *
 *   POST /api/admin-bridge/rename-files
 *   POST /api/admin-bridge/rename-files?dry_run=1   (preview only, no moves)
 *   POST /api/admin-bridge/rename-files?limit=20    (process at most N rows)
 *
 * Skips:
 *   - rows with no sender AND no title (nothing to slug)
 *   - rows whose computed destination equals the current path
 *   - rows still sitting in the inbox/staging area or with no path
 */
export async function POST(request: NextRequest) {
  if (process.env.DEV_AUTO_LOGIN !== "true")
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  if (process.env.NODE_ENV === "production")
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  const host = (request.headers.get("host") || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1")
    return NextResponse.json({ error: "Localhost only." }, { status: 403 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const dryRun = sp.get("dry_run") === "1";
  const limit = sp.get("limit") ? Math.max(1, Number(sp.get("limit"))) : 1000;

  console.log(
    "[admin-bridge/rename-files] start user",
    user.id,
    "dryRun",
    dryRun,
    "limit",
    limit
  );

  const admin = await createServiceClient();

  // Pull the docs we care about — anything classified enough to have a
  // sender or title is fair game. Skip drafts/failures.
  const { data: docs, error } = await admin
    .from("documents")
    .select(
      "id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, storage_provider, status"
    )
    .eq("user_id", user.id)
    .in("status", ["processed"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!docs || docs.length === 0)
    return NextResponse.json({ ok: true, scanned: 0, renamed: 0, skipped: 0, results: [] });

  // Pre-load all profiles for this user once so we can look up names cheaply.
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, name")
    .eq("user_id", user.id);
  const profileNameById = new Map<number, string>(
    (profiles || []).map((p) => [p.id as number, p.name as string])
  );

  type RowResult = {
    id: string;
    from: string | null;
    to?: string;
    new_path?: string;
    skipped?: string;
    error?: string;
  };
  const results: RowResult[] = [];
  let renamed = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    // Nothing to slug? skip.
    if (!doc.sender && !doc.title) {
      skipped++;
      results.push({ id: doc.id, from: doc.dropbox_path, skipped: "no sender or title" });
      continue;
    }
    if (!doc.dropbox_path) {
      skipped++;
      results.push({ id: doc.id, from: null, skipped: "no path" });
      continue;
    }

    const profileName = doc.primary_profile_id
      ? profileNameById.get(doc.primary_profile_id) || null
      : null;

    let storage;
    try {
      storage = getStorage(doc.storage_provider);
    } catch (e) {
      failed++;
      results.push({
        id: doc.id,
        from: doc.dropbox_path,
        error: e instanceof Error ? e.message : "unknown storage provider",
      });
      continue;
    }

    const destination = storage.buildDestinationPath({
      profileSlug: profileName,
      documentType: doc.document_type,
      documentDateISO: doc.document_date,
      filename: doc.file_name || "file.bin",
      sender: doc.sender,
      title: doc.title,
    });

    if (destination === doc.dropbox_path) {
      skipped++;
      results.push({ id: doc.id, from: doc.dropbox_path, skipped: "already correct" });
      continue;
    }

    if (dryRun) {
      results.push({ id: doc.id, from: doc.dropbox_path, to: destination });
      renamed++;
      continue;
    }

    try {
      const newPath = await storage.moveFile(doc.dropbox_path, destination);
      let shareLink: string | null = null;
      try {
        shareLink = await storage.getOrCreateShareLink(newPath);
      } catch (e) {
        console.warn("[admin-bridge/rename-files] share link refresh failed", e);
      }
      const update: Record<string, unknown> = { dropbox_path: newPath };
      if (shareLink) update.dropbox_shared_link = shareLink;
      const { error: updateErr } = await admin
        .from("documents")
        .update(update)
        .eq("id", doc.id);
      if (updateErr) {
        failed++;
        results.push({
          id: doc.id,
          from: doc.dropbox_path,
          to: destination,
          error: `db update: ${updateErr.message}`,
        });
        continue;
      }
      renamed++;
      results.push({ id: doc.id, from: doc.dropbox_path, to: destination, new_path: newPath });
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "move failed";
      results.push({ id: doc.id, from: doc.dropbox_path, to: destination, error: msg });
    }
  }

  console.log(
    "[admin-bridge/rename-files] done — scanned",
    docs.length,
    "renamed",
    renamed,
    "skipped",
    skipped,
    "failed",
    failed
  );

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    scanned: docs.length,
    renamed,
    skipped,
    failed,
    results,
  });
}
