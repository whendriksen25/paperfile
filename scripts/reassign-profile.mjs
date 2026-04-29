// Bulk-move every document from one profile to another.
//
// Usage:
//   node --env-file=.env.local scripts/reassign-profile.mjs \
//        --from-profile=Me --to-profile=Pa --dry-run
//
//   # Then drop --dry-run.
//
// Use case: when an entire profile's docs were misassigned (e.g. the user
// has uploaded docs that all belong to one person, but Claude or an old
// matching rule put them under another profile by name resemblance).
// Each doc is moved in Dropbox to the target profile's folder structure
// and the DB row is updated — primary_profile_id, dropbox_path,
// dropbox_shared_link, needs_review=false. Logged to maintenance_log.

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const stripQuotes = (s) => s.replace(/^['"]|['"]$/g, "");
function arg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? stripQuotes(a.split("=").slice(1).join("=")) : null;
}
const fromProfileName = arg("from-profile");
const toProfileName = arg("to-profile");
const userArg = arg("user");
if (!fromProfileName || !toProfileName) {
  console.error("Usage: --from-profile=Me --to-profile=Pa [--user=email] [--dry-run]");
  process.exit(1);
}

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

// ---- mirror of the app's path-building helpers ----
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
    .replace(/[̀-ͯ]/g, "")
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

async function resolveProfile(supabase, name, userId) {
  let q = supabase.from("profiles").select("id,name,user_id").ilike("name", name);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw error;
  if (!data || data.length === 0) {
    console.error(`No profile matching "${name}"`);
    process.exit(1);
  }
  if (data.length > 1) {
    console.error(`Multiple profiles match "${name}". Pass --user=<email> to disambiguate.`);
    for (const t of data)
      console.error(`  user=${t.user_id} id=${t.id} name=${t.name}`);
    process.exit(1);
  }
  return data[0];
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve user (optional)
  let restrictUserId = null;
  if (userArg) {
    const { data: usersList } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const t = (usersList?.users || []).find(
      (u) => u.email?.toLowerCase() === userArg.toLowerCase()
    );
    if (!t) {
      console.error(`User not found: ${userArg}`);
      process.exit(1);
    }
    restrictUserId = t.id;
  }

  const fromP = await resolveProfile(supabase, fromProfileName, restrictUserId);
  const toP = await resolveProfile(supabase, toProfileName, restrictUserId);
  if (fromP.user_id !== toP.user_id) {
    console.error("Refusing to move between two different users' profiles.");
    process.exit(1);
  }
  if (fromP.id === toP.id) {
    console.error("from-profile and to-profile are the same. Nothing to do.");
    process.exit(1);
  }
  console.log(
    `[reassign-profile] ${fromP.name} (id=${fromP.id}) → ${toP.name} (id=${toP.id})`
  );

  const { data: docs, error: dErr } = await supabase
    .from("documents")
    .select(
      "id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, dropbox_shared_link, status"
    )
    .eq("user_id", fromP.user_id)
    .eq("primary_profile_id", fromP.id)
    .eq("status", "processed");
  if (dErr) throw dErr;
  console.log(`[reassign-profile] candidates: ${docs.length}`);
  if (docs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const dbx = new Dropbox({
    clientId: DBX_KEY,
    clientSecret: DBX_SECRET,
    refreshToken: DBX_REFRESH,
    fetch: patchedFetch,
  });

  let updated = 0,
    failed = 0;
  for (const d of docs) {
    const destination = buildDestinationPath({
      profileSlug: toP.name,
      documentType: d.document_type,
      documentDateISO: d.document_date,
      filename: d.file_name || "file.bin",
      sender: d.sender,
      title: d.title,
    });

    if (dryRun) {
      console.log(`  ▸ ${d.id}: profile → ${toP.name}`);
      console.log(`      ${d.dropbox_path}`);
      console.log(`      → ${destination}`);
      updated++;
      continue;
    }

    try {
      let newPath = d.dropbox_path;
      if (d.dropbox_path && destination !== d.dropbox_path) {
        const moveRes = await dbx.filesMoveV2({
          from_path: d.dropbox_path,
          to_path: destination,
          autorename: true,
          allow_shared_folder: false,
          allow_ownership_transfer: false,
        });
        newPath = moveRes.result.metadata.path_display || destination;
      }
      let shareLink = d.dropbox_shared_link;
      try {
        const link = await dbx.sharingCreateSharedLinkWithSettings({ path: newPath });
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
        } catch {}
      }
      const update = {
        dropbox_path: newPath,
        primary_profile_id: toP.id,
        needs_review: false,
      };
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
      updated++;
      console.log(`  ✓ ${d.id}: → ${newPath}`);
      try {
        await supabase.from("maintenance_log").insert({
          user_id: toP.user_id,
          document_id: d.id,
          kind: "reassign_profile",
          reason: `Bulk reassign ${fromP.name} → ${toP.name}`,
          payload: {
            from_profile_id: fromP.id,
            to_profile_id: toP.id,
            from_path: d.dropbox_path,
            to_path: newPath,
          },
        });
      } catch (e) {
        console.warn("  (maintenance_log insert failed:", e.message, ")");
      }
    } catch (e) {
      failed++;
      const msg = e?.error?.error_summary || e?.message || String(e);
      console.log(`  ✗ ${d.id}: ${msg}`);
    }
  }

  console.log(
    `\n[reassign-profile] ${dryRun ? "would-update" : "updated"} ${updated}, failed ${failed}\n`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
