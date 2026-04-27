// Reclassify already-filed documents whose document_type disagrees with the
// dominant historical classification for their sender, then re-file them in
// Dropbox under the corrected folder.
//
// This is the backfill twin of the analyze-time sender-history override.
// Run it once after refiling a few key docs (e.g. one CAK to medical_bill)
// so the "history" reflects your intent, then this script propagates that
// intent to every existing CAK doc.
//
// Usage:
//   node --env-file=.env.local scripts/reclassify-by-sender-history.mjs --dry-run
//   node --env-file=.env.local scripts/reclassify-by-sender-history.mjs
//
// Strictly read-only in dry-run mode.

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const userArg = args.find((a) => a.startsWith("--user="));
const userEmail = userArg ? userArg.split("=")[1] : null;

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

// ---------- helpers (mirror app code) ----------
function normalizeSender(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
}
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
  return String(input)
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
function buildDestinationPath({ profileSlug, documentType, documentDateISO, filename, sender, title }) {
  const profile = safeSegment(profileSlug || "_unsorted");
  const year =
    documentDateISO && /^\d{4}/.test(documentDateISO)
      ? documentDateISO.slice(0, 4)
      : new Date().getFullYear().toString();
  const type = safeSegment(documentType || "_unsorted");
  const useLogical = !!(sender || title);
  const logical = useLogical
    ? safeSegment(buildLogicalFilename({ documentDateISO, sender, title, originalFilename: filename }))
    : safeSegment(filename);
  return `${DBX_ROOT}/${profile}/${year}/${type}/${logical}`;
}

const patchedFetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!res.buffer) {
    res.buffer = async () => Buffer.from(await res.arrayBuffer());
  }
  return res;
};

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve user filter
  let restrictUserId = null;
  if (userEmail) {
    const { data: usersList } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const t = (usersList?.users || []).find(
      (u) => u.email?.toLowerCase() === userEmail.toLowerCase()
    );
    if (!t) {
      console.error(`User not found: ${userEmail}`);
      process.exit(1);
    }
    restrictUserId = t.id;
  }

  let q = supabase
    .from("documents")
    .select(
      "id, user_id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, storage_provider, status, needs_review"
    )
    .eq("status", "processed")
    .not("sender", "is", null)
    .not("document_type", "is", null);
  if (restrictUserId) q = q.eq("user_id", restrictUserId);
  const { data: docs, error } = await q;
  if (error) throw error;

  console.log(`\n[reclassify] scanning ${docs.length} processed docs\n`);

  // Group by (user_id, normalized sender)
  const byUserSender = new Map();
  for (const d of docs) {
    const key = `${d.user_id}::${normalizeSender(d.sender)}`;
    if (!byUserSender.has(key)) byUserSender.set(key, []);
    byUserSender.get(key).push(d);
  }

  // Profile name lookup
  const userIds = Array.from(new Set(docs.map((d) => d.user_id)));
  const { data: profiles } = userIds.length
    ? await supabase
        .from("profiles")
        .select("id, name, user_id")
        .in("user_id", userIds)
    : { data: [] };
  const profileNameById = new Map((profiles || []).map((p) => [p.id, p.name]));

  const dbx = new Dropbox({
    clientId: DBX_KEY,
    clientSecret: DBX_SECRET,
    refreshToken: DBX_REFRESH,
    fetch: patchedFetch,
  });

  const plans = [];
  for (const [key, group] of byUserSender) {
    if (group.length < 2) continue;

    // Tally with double weight for user-confirmed docs
    const tally = new Map();
    for (const d of group) {
      const w = d.needs_review === false ? 2 : 1;
      tally.set(d.document_type, (tally.get(d.document_type) || 0) + w);
    }
    const sorted = Array.from(tally.entries()).sort((a, b) => b[1] - a[1]);
    const totalVotes = sorted.reduce((s, [, v]) => s + v, 0);
    const [winnerType, winnerVotes] = sorted[0];
    const ratio = winnerVotes / totalVotes;
    if (ratio < 0.6) continue;

    // Mark every doc in this group whose document_type ≠ winnerType for reclassification.
    for (const d of group) {
      if (d.document_type === winnerType) continue;
      plans.push({
        doc: d,
        from_type: d.document_type,
        to_type: winnerType,
        sender: d.sender,
        votes: winnerVotes,
        total: totalVotes,
      });
    }
    if (plans.some((p) => p.doc.user_id === group[0].user_id && normalizeSender(p.sender) === normalizeSender(group[0].sender))) {
      console.log(
        `  sender "${group[0].sender}" → ${winnerType} (${winnerVotes}/${totalVotes}); will reclassify ${plans.filter((p) => normalizeSender(p.sender) === normalizeSender(group[0].sender)).length} doc(s)`
      );
    }
  }

  console.log(`\n[reclassify] ${plans.length} reclassification plan(s)\n`);
  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let renamed = 0,
    failed = 0;
  for (const plan of plans) {
    const d = plan.doc;
    const profileName = d.primary_profile_id
      ? profileNameById.get(d.primary_profile_id) || null
      : null;

    const destination = buildDestinationPath({
      profileSlug: profileName,
      documentType: plan.to_type,
      documentDateISO: d.document_date,
      filename: d.file_name || "file.bin",
      sender: d.sender,
      title: d.title,
    });

    if (destination === d.dropbox_path) {
      // Path already correct (only DB column wrong); just update.
      if (!dryRun) {
        await supabase
          .from("documents")
          .update({ document_type: plan.to_type })
          .eq("id", d.id);
      }
      console.log(`  ✓ ${d.id} (db only): ${plan.from_type} → ${plan.to_type}`);
      renamed++;
      continue;
    }

    if (dryRun) {
      console.log(`  ▸ ${d.id}: ${plan.from_type} → ${plan.to_type}`);
      console.log(`      ${d.dropbox_path}`);
      console.log(`      → ${destination}`);
      renamed++;
      continue;
    }

    try {
      const moveRes = await dbx.filesMoveV2({
        from_path: d.dropbox_path,
        to_path: destination,
        autorename: true,
        allow_shared_folder: false,
        allow_ownership_transfer: false,
      });
      const newPath = moveRes.result.metadata.path_display || destination;

      let shareLink = null;
      try {
        const link = await dbx.sharingCreateSharedLinkWithSettings({ path: newPath });
        shareLink = link.result.url.replace("www.dropbox.com", "dl.dropboxusercontent.com");
      } catch {
        try {
          const existing = await dbx.sharingListSharedLinks({ path: newPath, direct_only: true });
          if (existing.result.links.length) {
            shareLink = existing.result.links[0].url.replace("www.dropbox.com", "dl.dropboxusercontent.com");
          }
        } catch {}
      }

      const update = { dropbox_path: newPath, document_type: plan.to_type };
      if (shareLink) update.dropbox_shared_link = shareLink;
      const { error: upErr } = await supabase
        .from("documents")
        .update(update)
        .eq("id", d.id);
      if (upErr) {
        failed++;
        console.log(`  ✗ ${d.id}: db update failed — ${upErr.message}`);
        continue;
      }
      renamed++;
      console.log(`  ✓ ${d.id}: ${plan.from_type} → ${plan.to_type}\n      ${d.dropbox_path}\n      → ${newPath}`);
    } catch (e) {
      failed++;
      const msg = e?.error?.error_summary || e?.message || String(e);
      console.log(`  ✗ ${d.id}: ${msg}`);
    }
  }

  console.log(
    `\n[reclassify] done — ${dryRun ? "would-fix" : "fixed"} ${renamed}, failed ${failed}\n`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
