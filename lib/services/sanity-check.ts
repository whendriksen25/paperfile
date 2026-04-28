import type { SupabaseClient } from "@supabase/supabase-js";
import { Dropbox } from "dropbox";
import { getStorage } from "@/lib/storage";
import {
  normalizeSender,
  shouldApplyHistoryOverride,
} from "@/lib/services/sender-history";

/**
 * Self-healing maintenance service.
 *
 * Two phases, both safe-by-default:
 *
 *  1. **Orphan auto-repoint** — for each processed doc whose stored
 *     dropbox_path doesn't exist in Dropbox, search for a same-sender
 *     same-byte-size match. If exactly ONE candidate, repoint silently.
 *     If zero or multiple candidates, flag the doc with needs_review and
 *     a note explaining the situation — never guess.
 *
 *  2. **Sender-history reclassify** — for each sender with ≥2 prior
 *     processed docs and a clear ≥80% majority on document_type
 *     (excluding generic 'other'/'letter' winners), move any sibling
 *     docs whose type doesn't match the majority. Same guards as the
 *     manual reclassify script.
 *
 * Every change is logged to maintenance_log so the user can see what was
 * changed automatically.
 *
 * Runs are idempotent: re-running with no new docs since the last run
 * does nothing.
 */

const GENERIC_TYPES = new Set<string>(["other", "letter"]);
const HISTORY_RATIO_THRESHOLD = 0.8;

export interface SanityCheckResult {
  user_id: string;
  scanned: number;
  orphans: {
    detected: number;
    repointed: number;
    flagged_for_review: number;
  };
  reclassifications: {
    planned: number;
    applied: number;
    failed: number;
  };
  duration_ms: number;
}

interface DocRow {
  id: string;
  user_id: string;
  file_name: string | null;
  file_size_bytes: number | null;
  document_type: string | null;
  document_date: string | null;
  sender: string | null;
  title: string | null;
  primary_profile_id: number | null;
  dropbox_path: string | null;
  dropbox_shared_link: string | null;
  storage_provider: string;
  status: string;
  needs_review: boolean;
}

interface ProfileRow {
  id: number;
  name: string;
  user_id: string;
}

/** Fast-fail patched fetch for the Dropbox SDK (mirror of lib/dropbox/client). */
const patchedFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!(res as unknown as { buffer?: unknown }).buffer) {
    (res as unknown as { buffer: () => Promise<Buffer> }).buffer = async () =>
      Buffer.from(await res.arrayBuffer());
  }
  return res;
};

function makeDropbox(): Dropbox {
  return new Dropbox({
    clientId: process.env.DROPBOX_APP_KEY,
    clientSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    fetch: patchedFetch,
  });
}

async function logMaintenance(
  admin: SupabaseClient,
  row: {
    user_id: string;
    document_id: string | null;
    kind: string;
    reason: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await admin.from("maintenance_log").insert(row);
  } catch (e) {
    console.warn("[sanity-check] maintenance_log insert failed", e);
  }
}

/**
 * Phase 1: orphan recovery. For each processed doc, verify its stored
 * dropbox_path exists. If not, attempt size+sender match in the
 * Dropbox archive root.
 */
async function recoverOrphans(
  admin: SupabaseClient,
  userId: string,
  docs: DocRow[]
): Promise<SanityCheckResult["orphans"]> {
  const dbx = makeDropbox();
  const root = (process.env.DROPBOX_ROOT_FOLDER || "/Archive").startsWith("/")
    ? process.env.DROPBOX_ROOT_FOLDER || "/Archive"
    : "/" + (process.env.DROPBOX_ROOT_FOLDER || "Archive");

  let detected = 0,
    repointed = 0,
    flagged = 0;

  for (const doc of docs) {
    if (!doc.dropbox_path) continue;
    // Quick existence check
    try {
      await dbx.filesGetMetadata({ path: doc.dropbox_path });
      continue; // file is where we say it is — nothing to do
    } catch {
      // not found — fall through to recovery
    }

    detected++;

    // Need both a sender and a file size to attempt recovery — without
    // those, the size+sender match isn't safe. Flag and move on.
    if (!doc.sender || !doc.file_size_bytes) {
      flagged++;
      await admin
        .from("documents")
        .update({
          needs_review: true,
          review_notes: `Orphan: stored path ${doc.dropbox_path} not found in Dropbox, and no sender/size available to auto-recover. Needs manual repoint.`,
        })
        .eq("id", doc.id);
      await logMaintenance(admin, {
        user_id: userId,
        document_id: doc.id,
        kind: "orphan_repoint",
        reason: "Flagged: no sender/size for recovery",
        payload: { stale_path: doc.dropbox_path },
      });
      continue;
    }

    // Search Dropbox for the sender, then filter to size match
    const candidates: { path: string; size: number }[] = [];
    try {
      const result = await dbx.filesSearchV2({
        query: doc.sender,
        options: { path: root, max_results: 50 },
      });
      const matches = result.result.matches || [];
      for (const m of matches) {
        // SDK shape: m.metadata is a discriminated union; the actual file
        // metadata sits under .metadata.metadata for ".tag === 'metadata'".
        const inner = (m.metadata as unknown as {
          metadata?: { path_display?: string; size?: number };
        })?.metadata;
        if (inner?.path_display && inner?.size === doc.file_size_bytes) {
          candidates.push({ path: inner.path_display, size: inner.size });
        }
      }
    } catch (e) {
      console.warn("[sanity-check] Dropbox search failed", e);
    }

    // Conservative auto-repoint: ONLY when there's exactly one candidate.
    if (candidates.length === 1) {
      const target = candidates[0].path;
      let shareLink: string | null = null;
      try {
        const link = await dbx.sharingCreateSharedLinkWithSettings({
          path: target,
        });
        shareLink = link.result.url.replace(
          "www.dropbox.com",
          "dl.dropboxusercontent.com"
        );
      } catch {
        try {
          const existing = await dbx.sharingListSharedLinks({
            path: target,
            direct_only: true,
          });
          if (existing.result.links.length) {
            shareLink = existing.result.links[0].url.replace(
              "www.dropbox.com",
              "dl.dropboxusercontent.com"
            );
          }
        } catch {
          /* ignore */
        }
      }

      const update: Record<string, unknown> = { dropbox_path: target };
      if (shareLink) update.dropbox_shared_link = shareLink;
      const { error: upErr } = await admin
        .from("documents")
        .update(update)
        .eq("id", doc.id);

      if (upErr) {
        flagged++;
        await admin
          .from("documents")
          .update({
            needs_review: true,
            review_notes: `Orphan auto-repoint failed: ${upErr.message}`,
          })
          .eq("id", doc.id);
      } else {
        repointed++;
        await logMaintenance(admin, {
          user_id: userId,
          document_id: doc.id,
          kind: "orphan_repoint",
          reason: `Auto-repointed via unique size+sender match`,
          payload: {
            stale_path: doc.dropbox_path,
            new_path: target,
            sender: doc.sender,
            size: doc.file_size_bytes,
          },
        });
      }
    } else {
      // Zero or multiple candidates — flag for manual review.
      flagged++;
      await admin
        .from("documents")
        .update({
          needs_review: true,
          review_notes:
            candidates.length === 0
              ? `Orphan: stored path ${doc.dropbox_path} not in Dropbox; no size+sender match found.`
              : `Orphan: ${candidates.length} candidates match size+sender — refusing to guess. Candidates: ${candidates.map((c) => c.path).join(", ")}`,
        })
        .eq("id", doc.id);
      await logMaintenance(admin, {
        user_id: userId,
        document_id: doc.id,
        kind: "orphan_repoint",
        reason: `Flagged: ${candidates.length} candidates`,
        payload: {
          stale_path: doc.dropbox_path,
          candidates: candidates.map((c) => c.path),
        },
      });
    }
  }

  return { detected, repointed, flagged_for_review: flagged };
}

/**
 * Phase 2: apply sender-history reclassification. Same logic as the
 * manual reclassify script's default mode, with all the safety guards.
 */
async function reclassifyByHistory(
  admin: SupabaseClient,
  userId: string,
  docs: DocRow[],
  profileNameById: Map<number, string>
): Promise<SanityCheckResult["reclassifications"]> {
  // Group by normalized sender
  const byNormSender = new Map<string, DocRow[]>();
  for (const d of docs) {
    if (!d.sender || !d.document_type) continue;
    const key = normalizeSender(d.sender);
    if (!key) continue;
    if (!byNormSender.has(key)) byNormSender.set(key, []);
    byNormSender.get(key)!.push(d);
  }

  let planned = 0,
    applied = 0,
    failed = 0;
  const storage = getStorage("dropbox");

  for (const [, group] of Array.from(byNormSender.entries())) {
    if (group.length < 2) continue;

    // Tally with double weight for user-confirmed (needs_review=false)
    const tally = new Map<string, number>();
    for (const d of group) {
      const w = d.needs_review === false ? 2 : 1;
      tally.set(d.document_type!, (tally.get(d.document_type!) || 0) + w);
    }
    const sorted = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
    const totalVotes = sorted.reduce((s, [, v]) => s + v, 0);
    const [winnerType] = sorted[0];
    const winnerVotes = sorted[0][1];
    const ratio = winnerVotes / totalVotes;
    if (ratio < HISTORY_RATIO_THRESHOLD) continue;
    if (GENERIC_TYPES.has(winnerType)) continue;

    for (const d of group) {
      if (!shouldApplyHistoryOverride(d.document_type, winnerType)) continue;
      planned++;

      const profileName = d.primary_profile_id
        ? profileNameById.get(d.primary_profile_id) || null
        : null;

      const destination = storage.buildDestinationPath({
        profileSlug: profileName,
        documentType: winnerType,
        documentDateISO: d.document_date,
        filename: d.file_name || "file.bin",
        sender: d.sender,
        title: d.title,
      });

      try {
        let newPath = d.dropbox_path!;
        if (destination !== d.dropbox_path) {
          newPath = await storage.moveFile(d.dropbox_path!, destination);
        }
        let shareLink = d.dropbox_shared_link;
        try {
          shareLink = await storage.getOrCreateShareLink(newPath);
        } catch {
          /* keep old link */
        }
        const update: Record<string, unknown> = {
          dropbox_path: newPath,
          document_type: winnerType,
        };
        if (shareLink) update.dropbox_shared_link = shareLink;
        const { error: upErr } = await admin
          .from("documents")
          .update(update)
          .eq("id", d.id);
        if (upErr) {
          failed++;
          continue;
        }
        applied++;
        await logMaintenance(admin, {
          user_id: userId,
          document_id: d.id,
          kind: "reclassify",
          reason: `Auto-reclassified by sender history (${winnerVotes}/${totalVotes} votes)`,
          payload: {
            sender: d.sender,
            from_type: d.document_type,
            to_type: winnerType,
            from_path: d.dropbox_path,
            to_path: newPath,
          },
        });
      } catch (e) {
        failed++;
        console.warn(
          "[sanity-check] reclassify move failed for",
          d.id,
          e instanceof Error ? e.message : e
        );
      }
    }
  }

  return { planned, applied, failed };
}

/**
 * Run a full sanity check for one user. Pulls all processed docs once,
 * runs both phases, returns a structured result.
 */
export async function runSanityCheck(
  admin: SupabaseClient,
  userId: string
): Promise<SanityCheckResult> {
  const start = Date.now();
  console.log("[sanity-check] start for user", userId);

  // Pull all processed docs in one shot — sender history needs the whole set
  const { data: docs, error } = await admin
    .from("documents")
    .select(
      "id, user_id, file_name, file_size_bytes, document_type, document_date, sender, title, primary_profile_id, dropbox_path, dropbox_shared_link, storage_provider, status, needs_review"
    )
    .eq("user_id", userId)
    .eq("status", "processed");
  if (error) throw error;
  const allDocs = (docs || []) as DocRow[];

  // Profile name lookup
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, name, user_id")
    .eq("user_id", userId);
  const profileNameById = new Map(
    ((profiles || []) as ProfileRow[]).map((p) => [p.id, p.name])
  );

  const orphans = await recoverOrphans(admin, userId, allDocs);
  // Re-pull docs after orphan repoints so reclassify sees the corrected
  // dropbox_paths (otherwise it'd try to move from stale paths).
  const { data: docsAfter } = await admin
    .from("documents")
    .select(
      "id, user_id, file_name, file_size_bytes, document_type, document_date, sender, title, primary_profile_id, dropbox_path, dropbox_shared_link, storage_provider, status, needs_review"
    )
    .eq("user_id", userId)
    .eq("status", "processed");
  const reclassifications = await reclassifyByHistory(
    admin,
    userId,
    (docsAfter || []) as DocRow[],
    profileNameById
  );

  const result: SanityCheckResult = {
    user_id: userId,
    scanned: allDocs.length,
    orphans,
    reclassifications,
    duration_ms: Date.now() - start,
  };
  console.log("[sanity-check] done", JSON.stringify(result));
  return result;
}
