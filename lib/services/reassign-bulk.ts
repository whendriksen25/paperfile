import type { SupabaseClient } from "@supabase/supabase-js";
import { getStorage } from "@/lib/storage";

/**
 * Shared engine for bulk-reassigning documents to a different profile.
 *
 * Both surfaces use this:
 *   - the diag CLI subcommand `bulk-reassign` (filter-driven)
 *   - the inbox multi-select UI (checkbox-driven, via the
 *     /api/documents/bulk-reassign endpoint)
 *
 * Per doc, this:
 *   1. Computes the new Dropbox destination path under the target profile
 *   2. Moves the file via the storage adapter
 *   3. Refreshes the shared link
 *   4. Updates the DB row (primary_profile_id, dropbox_path,
 *      dropbox_shared_link, needs_review=false)
 *   5. Logs to maintenance_log
 *
 * Fail-soft: one doc failing doesn't stop the rest. Each result is
 * returned individually so the caller can surface per-doc status.
 */

export interface ReassignDocResult {
  document_id: string;
  status: "moved" | "skipped" | "failed" | "dry_run";
  from_path?: string | null;
  to_path?: string | null;
  reason?: string;
}

export interface ReassignBulkResult {
  attempted: number;
  moved: number;
  skipped: number;
  failed: number;
  dry_run: boolean;
  results: ReassignDocResult[];
}

interface DocRow {
  id: string;
  user_id: string;
  file_name: string | null;
  document_type: string | null;
  document_date: string | null;
  sender: string | null;
  title: string | null;
  primary_profile_id: number | null;
  dropbox_path: string | null;
  dropbox_shared_link: string | null;
  storage_provider: string | null;
  status: string | null;
}

interface ProfileRow {
  id: number;
  name: string;
  user_id: string;
}

export async function reassignDocumentsToProfile(
  admin: SupabaseClient,
  docIds: string[],
  toProfileId: number,
  opts: { dryRun?: boolean; userId?: string } = {}
): Promise<ReassignBulkResult> {
  const dryRun = !!opts.dryRun;
  const out: ReassignBulkResult = {
    attempted: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
    dry_run: dryRun,
    results: [],
  };
  if (docIds.length === 0) return out;

  // 1. Resolve target profile.
  const { data: toP, error: pErr } = await admin
    .from("profiles")
    .select("id, name, user_id")
    .eq("id", toProfileId)
    .maybeSingle();
  if (pErr || !toP) {
    throw new Error(`Target profile id=${toProfileId} not found`);
  }
  const toProfile = toP as ProfileRow;

  // 2. Load the docs. Cap at a sane batch size so a runaway call can't
  // try to move thousands at once.
  const MAX_BATCH = 500;
  const safeIds = docIds.slice(0, MAX_BATCH);
  let q = admin
    .from("documents")
    .select(
      "id, user_id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, dropbox_shared_link, storage_provider, status"
    )
    .in("id", safeIds);
  if (opts.userId) q = q.eq("user_id", opts.userId);
  const { data: docsRaw, error: dErr } = await q;
  if (dErr) throw dErr;
  const docs = (docsRaw || []) as DocRow[];

  // 3. Per-doc move.
  for (const d of docs) {
    out.attempted++;

    // Sanity: cross-user refusal (service role bypasses RLS so we enforce here).
    if (d.user_id !== toProfile.user_id) {
      out.failed++;
      out.results.push({
        document_id: d.id,
        status: "failed",
        reason: "doc owner differs from target profile owner",
      });
      continue;
    }

    if (d.primary_profile_id === toProfile.id) {
      out.skipped++;
      out.results.push({
        document_id: d.id,
        status: "skipped",
        reason: "already on target profile",
      });
      continue;
    }

    const storage = getStorage(d.storage_provider);
    const destination = storage.buildDestinationPath({
      profileSlug: toProfile.name,
      documentType: d.document_type,
      documentDateISO: d.document_date,
      filename: d.file_name || "file.bin",
      sender: d.sender,
      title: d.title,
    });

    if (dryRun) {
      out.results.push({
        document_id: d.id,
        status: "dry_run",
        from_path: d.dropbox_path,
        to_path: destination,
      });
      continue;
    }

    try {
      let newPath = d.dropbox_path;
      if (d.dropbox_path && destination !== d.dropbox_path) {
        newPath = await storage.moveFile(d.dropbox_path, destination);
      }
      let shareLink: string | null = d.dropbox_shared_link;
      try {
        shareLink = newPath
          ? await storage.getOrCreateShareLink(newPath)
          : shareLink;
      } catch (e) {
        console.warn(
          `[reassign-bulk] share link refresh failed for ${d.id}:`,
          e instanceof Error ? e.message : String(e)
        );
      }

      const update: Record<string, unknown> = {
        primary_profile_id: toProfile.id,
        needs_review: false,
      };
      if (newPath) update.dropbox_path = newPath;
      if (shareLink) update.dropbox_shared_link = shareLink;

      const { error: upErr } = await admin
        .from("documents")
        .update(update)
        .eq("id", d.id);
      if (upErr) {
        out.failed++;
        out.results.push({
          document_id: d.id,
          status: "failed",
          from_path: d.dropbox_path,
          to_path: newPath,
          reason: `db update failed: ${upErr.message}`,
        });
        continue;
      }

      await admin.from("maintenance_log").insert({
        user_id: d.user_id,
        document_id: d.id,
        kind: "reassign_profile",
        reason: `Bulk reassign → ${toProfile.name}`,
        payload: {
          from_profile_id: d.primary_profile_id,
          to_profile_id: toProfile.id,
          to_profile_name: toProfile.name,
          from_path: d.dropbox_path,
          to_path: newPath,
        },
      });

      out.moved++;
      out.results.push({
        document_id: d.id,
        status: "moved",
        from_path: d.dropbox_path,
        to_path: newPath,
      });
    } catch (e) {
      out.failed++;
      out.results.push({
        document_id: d.id,
        status: "failed",
        from_path: d.dropbox_path,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return out;
}
