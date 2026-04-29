// Bulk-reassign documents to the right profile based on a city/postal signal
// in their OCR text or extracted_fields. Mirrors what the deterministic
// matcher would do today on a fresh analyze, but applied retroactively to
// docs that were processed before the OCR-text city safety net existed.
//
// Usage:
//   node --env-file=.env.local scripts/reassign-by-city-signal.mjs \
//        --signal-city="Dieren" --signal-postal="6953" \
//        --to-profile="Pa" --dry-run
//
//   # Then drop --dry-run to apply.
//
// Safety:
//   - Dry-run mode prints the plan; nothing moves until you remove the flag.
//   - Skips docs already assigned to the target profile.
//   - Each move is a Dropbox filesMoveV2 call; share link is refreshed
//     and dropbox_path + primary_profile_id update in lockstep.
//   - Logs every change to the maintenance_log table.

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const stripQuotes = (s) => s.replace(/^['"]|['"]$/g, "");
function arg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? stripQuotes(a.split("=").slice(1).join("=")) : null;
}
const signalCity = arg("signal-city");
const signalPostal = arg("signal-postal");
const toProfileName = arg("to-profile");
const userArg = arg("user");
if (!toProfileName) {
  console.error("Usage: --to-profile=Pa --signal-city=Dieren [--signal-postal=6953] [--dry-run]");
  process.exit(1);
}
if (!signalCity && !signalPostal) {
  console.error("Provide at least one of --signal-city or --signal-postal");
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

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve user (default: scan all)
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

  // Resolve target profile by name (case-insensitive)
  let pq = supabase.from("profiles").select("id,name,user_id").ilike("name", toProfileName);
  if (restrictUserId) pq = pq.eq("user_id", restrictUserId);
  const { data: targets, error: pErr } = await pq;
  if (pErr) throw pErr;
  if (!targets || targets.length === 0) {
    console.error(`No profile matching "${toProfileName}"`);
    process.exit(1);
  }
  if (targets.length > 1) {
    console.error(`Multiple profiles match "${toProfileName}":`);
    for (const t of targets)
      console.error(`  user=${t.user_id} id=${t.id} name=${t.name}`);
    console.error("Pass --user=<email> to disambiguate.");
    process.exit(1);
  }
  const target = targets[0];
  console.log(`[reassign] target profile: ${target.name} (id=${target.id}, user=${target.user_id})`);

  // Pull docs for that user
  let dq = supabase
    .from("documents")
    .select(
      "id, user_id, file_name, document_type, document_date, sender, title, primary_profile_id, dropbox_path, dropbox_shared_link, storage_provider, status, ocr_text, extracted_fields"
    )
    .eq("user_id", target.user_id)
    .eq("status", "processed");
  const { data: docs, error: dErr } = await dq;
  if (dErr) throw dErr;
  console.log(`[reassign] scanning ${docs.length} processed docs`);

  // Filter to docs with the requested signal
  const cityNeedle = signalCity ? signalCity.toLowerCase() : null;
  const postalNeedle = signalPostal
    ? signalPostal.replace(/\s+/g, "").toLowerCase()
    : null;
  const candidates = docs.filter((d) => {
    if (d.primary_profile_id === target.id) return false; // already correct
    const corpus = (
      (d.ocr_text || "") +
      " " +
      JSON.stringify(d.extracted_fields || {}) +
      " " +
      (d.sender || "") +
      " " +
      (d.dropbox_path || "")
    ).toLowerCase();
    const corpusCompact = corpus.replace(/\s+/g, "");
    const cityHit = cityNeedle ? corpus.includes(cityNeedle) : false;
    const postalHit = postalNeedle ? corpusCompact.includes(postalNeedle) : false;
    return cityHit || postalHit;
  });
  console.log(
    `[reassign] candidates with ${[
      signalCity ? `city="${signalCity}"` : null,
      signalPostal ? `postal="${signalPostal}"` : null,
    ]
      .filter(Boolean)
      .join(" or ")}: ${candidates.length}`
  );

  if (candidates.length === 0) {
    console.log("Nothing to reassign.");
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
  for (const d of candidates) {
    const destination = buildDestinationPath({
      profileSlug: target.name,
      documentType: d.document_type,
      documentDateISO: d.document_date,
      filename: d.file_name || "file.bin",
      sender: d.sender,
      title: d.title,
    });

    if (dryRun) {
      console.log(`  ▸ ${d.id}: profile → ${target.name}`);
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
        primary_profile_id: target.id,
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
          user_id: target.user_id,
          document_id: d.id,
          kind: "reassign_by_signal",
          reason: `Reassigned to ${target.name} via city/postal signal (${[
            signalCity ? `city="${signalCity}"` : null,
            signalPostal ? `postal="${signalPostal}"` : null,
          ]
            .filter(Boolean)
            .join(" / ")})`,
          payload: {
            from_profile_id: d.primary_profile_id,
            to_profile_id: target.id,
            from_path: d.dropbox_path,
            to_path: newPath,
            signal_city: signalCity,
            signal_postal: signalPostal,
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
    `\n[reassign] ${dryRun ? "would-update" : "updated"} ${updated}, failed ${failed}\n`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
