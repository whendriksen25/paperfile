// Backfill: rename already-uploaded Dropbox files into the new logical
// YYYYMMDD_{sender}.{ext} format, and update the matching Paperfile
// (Supabase) rows so dropbox_path stays in sync.
//
// Usage:
//   node --env-file=.env.local scripts/rename-existing-files.mjs --dry-run
//   node --env-file=.env.local scripts/rename-existing-files.mjs
//
// Flags:
//   --dry-run        — preview only, no Dropbox moves, no DB writes
//   --limit=N        — stop after N candidate rows (default: all)
//   --user=<email>   — restrict to one user (default: ALL users with docs)
//
// Safe to re-run: rows whose path already matches the destination are skipped.

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

// ---------- args ----------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const userArg = args.find((a) => a.startsWith("--user="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : 100000;
// If no --user= flag, process ALL users that have documents.
const userEmail = userArg ? userArg.split("=")[1] : null;

// ---------- env sanity ----------
function need(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
  return v;
}
const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const DBX_KEY = need("DROPBOX_APP_KEY");
const DBX_SECRET = need("DROPBOX_APP_SECRET");
const DBX_REFRESH = need("DROPBOX_REFRESH_TOKEN");
const DBX_ROOT = (process.env.DROPBOX_ROOT_FOLDER || "/Archive").startsWith("/")
  ? process.env.DROPBOX_ROOT_FOLDER || "/Archive"
  : "/" + (process.env.DROPBOX_ROOT_FOLDER || "Archive");

// ---------- helpers (mirror lib/dropbox/upload.ts exactly) ----------
function safeSegment(name) {
  return (name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 200);
}
function fileExtension(name) {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name || "");
  if (!m) return ".bin";
  return "." + m[1].toLowerCase();
}
function slugify(input, maxLen = 40) {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen)
    .replace(/_+$/g, "")
    .toLowerCase();
}
function buildLogicalFilename({ documentDateISO, sender, title, originalFilename }) {
  const ext = fileExtension(originalFilename);
  const date = documentDateISO || new Date().toISOString().slice(0, 10);
  const datePart = date.replace(/-/g, "").slice(0, 8);
  const senderSlug = slugify(sender || "");
  const titleSlug = slugify(title || "");
  const fallback = slugify((originalFilename || "").replace(/\.[^.]+$/, ""));
  const subject = senderSlug || titleSlug || fallback || "document";
  return `${datePart}_${subject}${ext}`;
}
function buildDestinationPath({
  profileSlug,
  documentType,
  documentDateISO,
  filename,
  sender,
  title,
}) {
  const profile = safeSegment(profileSlug || "_unsorted");
  const year =
    documentDateISO && /^\d{4}/.test(documentDateISO)
      ? documentDateISO.slice(0, 4)
      : new Date().getFullYear().toString();
  const type = safeSegment(documentType || "_unsorted");
  const useLogical = !!(sender || title);
  const logical = useLogical
    ? safeSegment(
        buildLogicalFilename({
          documentDateISO,
          sender,
          title,
          originalFilename: filename,
        })
      )
    : safeSegment(filename);
  return `${DBX_ROOT}/${profile}/${year}/${type}/${logical}`;
}

// Dropbox SDK uses node-fetch's res.buffer() — patch it on native fetch.
const patchedFetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.buffer) {
    res.buffer = async () => Buffer.from(await res.arrayBuffer());
  }
  return res;
};

// ---------- run ----------
async function main() {
  console.log(
    `\n[rename] start  dryRun=${dryRun}  limit=${limit}  user=${userEmail || "ALL"}\n`
  );

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Build email-by-id map (for the per-user breakdown print)
  const { data: usersList, error: userErr } =
    await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (userErr) throw userErr;
  const emailById = new Map(
    (usersList?.users || []).map((u) => [u.id, u.email || "(no email)"])
  );

  // Optional restrict
  let restrictUserId = null;
  if (userEmail) {
    const target = (usersList?.users || []).find(
      (u) => u.email?.toLowerCase() === userEmail.toLowerCase()
    );
    if (!target) {
      console.error(`User not found for email ${userEmail}`);
      process.exit(1);
    }
    restrictUserId = target.id;
    console.log(`[rename] restricting to user ${target.email} (${target.id})`);
  }

  // 2. Pull processed docs
  let q = supabase
    .from("documents")
    .select(
      "id, user_id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, status"
    )
    .eq("status", "processed")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (restrictUserId) q = q.eq("user_id", restrictUserId);
  const { data: docs, error } = await q;
  if (error) throw error;

  // Per-user breakdown so it's obvious where the docs live
  const countsByUser = new Map();
  for (const d of docs) {
    countsByUser.set(d.user_id, (countsByUser.get(d.user_id) || 0) + 1);
  }
  console.log(`[rename] candidates: ${docs.length}`);
  for (const [uid, n] of countsByUser) {
    console.log(`         ${n.toString().padStart(4)}  ${emailById.get(uid) || uid}`);
  }

  // 3. Profile name lookup (across all users, indexed by id only — ids are unique)
  const userIds = Array.from(countsByUser.keys());
  const { data: profiles } = userIds.length
    ? await supabase
        .from("profiles")
        .select("id, name, user_id")
        .in("user_id", userIds)
    : { data: [] };
  const profileNameById = new Map((profiles || []).map((p) => [p.id, p.name]));

  // 4. Dropbox client
  const dbx = new Dropbox({
    clientId: DBX_KEY,
    clientSecret: DBX_SECRET,
    refreshToken: DBX_REFRESH,
    fetch: patchedFetch,
  });

  // 5. Walk
  let renamed = 0,
    skipped = 0,
    failed = 0;
  const results = [];
  for (const doc of docs) {
    if (!doc.sender && !doc.title) {
      skipped++;
      results.push({ id: doc.id, skipped: "no sender or title", from: doc.dropbox_path });
      continue;
    }
    if (!doc.dropbox_path) {
      skipped++;
      results.push({ id: doc.id, skipped: "no path" });
      continue;
    }
    const profileName = doc.primary_profile_id
      ? profileNameById.get(doc.primary_profile_id) || null
      : null;
    const destination = buildDestinationPath({
      profileSlug: profileName,
      documentType: doc.document_type,
      documentDateISO: doc.document_date,
      filename: doc.file_name || "file.bin",
      sender: doc.sender,
      title: doc.title,
    });
    if (destination === doc.dropbox_path) {
      skipped++;
      results.push({ id: doc.id, skipped: "already correct", from: doc.dropbox_path });
      continue;
    }
    if (dryRun) {
      renamed++;
      results.push({ id: doc.id, from: doc.dropbox_path, to: destination });
      continue;
    }
    try {
      const moveRes = await dbx.filesMoveV2({
        from_path: doc.dropbox_path,
        to_path: destination,
        autorename: true,
        allow_shared_folder: false,
        allow_ownership_transfer: false,
      });
      const newPath = moveRes.result.metadata.path_display || destination;
      let shareLink = null;
      try {
        const link = await dbx.sharingCreateSharedLinkWithSettings({
          path: newPath,
        });
        shareLink = link.result.url.replace(
          "www.dropbox.com",
          "dl.dropboxusercontent.com"
        );
      } catch {
        try {
          const existing = await dbx.sharingListSharedLinks({
            path: newPath,
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
      const update = { dropbox_path: newPath };
      if (shareLink) update.dropbox_shared_link = shareLink;
      const { error: upErr } = await supabase
        .from("documents")
        .update(update)
        .eq("id", doc.id);
      if (upErr) {
        failed++;
        results.push({
          id: doc.id,
          from: doc.dropbox_path,
          to: destination,
          error: `db: ${upErr.message}`,
        });
        continue;
      }
      renamed++;
      results.push({ id: doc.id, from: doc.dropbox_path, to: newPath });
      console.log(`  ✓ ${doc.dropbox_path}\n    → ${newPath}`);
    } catch (e) {
      failed++;
      const msg = e?.error?.error_summary || e?.message || String(e);
      results.push({
        id: doc.id,
        from: doc.dropbox_path,
        to: destination,
        error: msg,
      });
      console.log(`  ✗ ${doc.dropbox_path}  (${msg})`);
    }
  }

  console.log(
    `\n[rename] done  scanned=${docs.length}  ${
      dryRun ? "would-rename" : "renamed"
    }=${renamed}  skipped=${skipped}  failed=${failed}\n`
  );

  if (dryRun) {
    console.log("Sample of planned renames (first 15):");
    for (const r of results.filter((r) => r.to).slice(0, 15)) {
      console.log(`  ${r.from}\n    → ${r.to}`);
    }
  }
  if (failed) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => r.error)) {
      console.log(`  ${r.from}  →  ${r.error}`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
