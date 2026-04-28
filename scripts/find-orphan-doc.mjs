// Diagnostic: find an orphaned document file in Dropbox.
//
// When a documents row points at a dropbox_path that doesn't exist (e.g.
// "/Archive/_inbox/1777295249003_image.jpg"), this script:
//   1. Loads the DB row to see file_size_bytes + content_hash
//   2. Lists the suspected source folder so we can see what's actually there
//   3. Runs a Dropbox-wide search for the timestamp prefix
//   4. If still nothing, checks file_name and lists by size match
//
// Usage:
//   node --env-file=.env.local scripts/find-orphan-doc.mjs <doc-id-or-prefix>
//
//   # Once you've confirmed where the file actually lives, repoint the row:
//   node --env-file=.env.local scripts/find-orphan-doc.mjs <id-prefix> \
//        --fix-with="/Archive/Pa/2024/letter/20240115_benu_direct_hulpmiddelenzorg.jpg"
//
// Example:
//   node --env-file=.env.local scripts/find-orphan-doc.mjs 6a36d71a

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const docArg = args.find((a) => !a.startsWith("--"));
const fixWithArg = args.find((a) => a.startsWith("--fix-with="));
const fixWithPath = fixWithArg
  ? fixWithArg.slice("--fix-with=".length).replace(/^['"]|['"]$/g, "")
  : null;
if (!docArg) {
  console.error("Usage: node scripts/find-orphan-doc.mjs <doc-id-or-prefix> [--fix-with=<dropbox-path>]");
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
  const dbx = new Dropbox({
    clientId: DBX_KEY,
    clientSecret: DBX_SECRET,
    refreshToken: DBX_REFRESH,
    fetch: patchedFetch,
  });

  // 1. Find the row. PostgREST can't LIKE on a uuid column even with a ::text
  // cast, so accept a full UUID via .eq(), otherwise fetch recent rows and
  // filter client-side by id prefix.
  const cols =
    "id, file_name, file_size_bytes, content_hash, dropbox_path, sender, document_type, document_date, status, created_at";
  const isFullUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docArg);
  let rows;
  if (isFullUuid) {
    const { data, error } = await supabase
      .from("documents")
      .select(cols)
      .eq("id", docArg)
      .limit(5);
    if (error) throw error;
    rows = data || [];
  } else {
    const { data, error } = await supabase
      .from("documents")
      .select(cols)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    const lower = docArg.toLowerCase();
    rows = (data || []).filter((r) => r.id.toLowerCase().startsWith(lower)).slice(0, 5);
  }
  if (!rows || rows.length === 0) {
    console.error(`No row found matching id prefix "${docArg}"`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.log(`Multiple rows match — using first:`);
    for (const r of rows) console.log(`  ${r.id}  ${r.file_name}`);
  }
  const doc = rows[0];

  console.log("\n=== DB row ===");
  console.log(`  id:            ${doc.id}`);
  console.log(`  file_name:     ${doc.file_name}`);
  console.log(`  file_size:     ${doc.file_size_bytes}`);
  console.log(`  content_hash:  ${doc.content_hash || "(none)"}`);
  console.log(`  dropbox_path:  ${doc.dropbox_path}`);
  console.log(`  sender:        ${doc.sender}`);
  console.log(`  document_type: ${doc.document_type}`);
  console.log(`  document_date: ${doc.document_date}`);
  console.log(`  status:        ${doc.status}`);
  console.log(`  created_at:    ${doc.created_at}`);

  // Fix mode: repoint the row to a known-good Dropbox path.
  if (fixWithPath) {
    console.log(`\n=== Fix mode: repointing to ${fixWithPath} ===`);
    let meta;
    try {
      const r = await dbx.filesGetMetadata({ path: fixWithPath });
      meta = r.result;
    } catch (e) {
      console.error(`  ✗ Path not found in Dropbox: ${e?.error?.error_summary || e?.message}`);
      process.exit(1);
    }
    if (
      doc.file_size_bytes &&
      meta.size &&
      meta.size !== doc.file_size_bytes
    ) {
      console.error(
        `  ✗ Size mismatch: DB row says ${doc.file_size_bytes} bytes, file is ${meta.size}. Refusing to repoint to a different file. Use a script of your own if you really want this.`
      );
      process.exit(1);
    }
    let newShareLink = null;
    try {
      const link = await dbx.sharingCreateSharedLinkWithSettings({ path: fixWithPath });
      newShareLink = link.result.url.replace("www.dropbox.com", "dl.dropboxusercontent.com");
    } catch {
      try {
        const existing = await dbx.sharingListSharedLinks({ path: fixWithPath, direct_only: true });
        if (existing.result.links.length) {
          newShareLink = existing.result.links[0].url.replace("www.dropbox.com", "dl.dropboxusercontent.com");
        }
      } catch {}
    }
    const update = { dropbox_path: meta.path_display || fixWithPath };
    if (newShareLink) update.dropbox_shared_link = newShareLink;
    const { error: upErr } = await supabase
      .from("documents")
      .update(update)
      .eq("id", doc.id);
    if (upErr) {
      console.error(`  ✗ DB update failed: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`  ✓ Row updated. dropbox_path → ${update.dropbox_path}`);
    if (newShareLink) console.log(`  ✓ Share link refreshed.`);
    return;
  }

  // 2. Try the exact path
  console.log("\n=== Direct lookup ===");
  try {
    const meta = await dbx.filesGetMetadata({ path: doc.dropbox_path });
    console.log(`  ✓ Found at exact path: ${meta.result.path_display}`);
    console.log(`    size: ${meta.result.size}`);
    return;
  } catch (e) {
    console.log(`  ✗ ${e?.error?.error_summary || e?.message}`);
  }

  // 3. List the source folder
  const folder = doc.dropbox_path.slice(0, doc.dropbox_path.lastIndexOf("/"));
  console.log(`\n=== Listing folder: ${folder} ===`);
  try {
    const list = await dbx.filesListFolder({ path: folder, recursive: false });
    for (const e of list.result.entries) {
      console.log(`  ${e[".tag"] === "file" ? "📄" : "📁"} ${e.path_display}  ${e.size || ""}`);
    }
    if (list.result.entries.length === 0) console.log("  (empty)");
  } catch (e) {
    console.log(`  ✗ ${e?.error?.error_summary || e?.message}`);
  }

  // 4. Search by timestamp segment in filename
  const filename = doc.dropbox_path.slice(doc.dropbox_path.lastIndexOf("/") + 1);
  const tsMatch = filename.match(/^(\d{10,})/);
  const searchKey = tsMatch ? tsMatch[1] : filename;
  console.log(`\n=== Dropbox search for "${searchKey}" ===`);
  try {
    const result = await dbx.filesSearchV2({
      query: searchKey,
      options: { path: DBX_ROOT, max_results: 25 },
    });
    const matches = result.result.matches || [];
    if (matches.length === 0) {
      console.log("  (no matches)");
    } else {
      for (const m of matches) {
        const meta = m.metadata?.metadata;
        if (meta?.path_display) {
          console.log(`  📄 ${meta.path_display}  size: ${meta.size || "?"}`);
        }
      }
    }
  } catch (e) {
    console.log(`  ✗ ${e?.error?.error_summary || e?.message}`);
  }

  // 5. Search by file_name (less specific — may produce many hits)
  if (doc.file_name && doc.file_name !== filename) {
    console.log(`\n=== Search for file_name "${doc.file_name}" ===`);
    try {
      const result = await dbx.filesSearchV2({
        query: doc.file_name,
        options: { path: DBX_ROOT, max_results: 25 },
      });
      const matches = result.result.matches || [];
      if (matches.length === 0) {
        console.log("  (no matches)");
      } else {
        for (const m of matches) {
          const meta = m.metadata?.metadata;
          if (meta?.path_display) {
            console.log(`  📄 ${meta.path_display}  size: ${meta.size || "?"}`);
          }
        }
      }
    } catch (e) {
      console.log(`  ✗ ${e?.error?.error_summary || e?.message}`);
    }
  }

  // 6. Search by sender (might surface a renamed copy)
  if (doc.sender) {
    console.log(`\n=== Search for sender "${doc.sender}" ===`);
    try {
      const result = await dbx.filesSearchV2({
        query: doc.sender,
        options: { path: DBX_ROOT, max_results: 25, file_status: "active" },
      });
      const matches = result.result.matches || [];
      if (matches.length === 0) {
        console.log("  (no matches)");
      } else {
        for (const m of matches) {
          const meta = m.metadata?.metadata;
          if (meta?.path_display && meta?.size === doc.file_size_bytes) {
            console.log(`  ★ MATCH BY SIZE: ${meta.path_display}  size: ${meta.size}`);
          } else if (meta?.path_display) {
            console.log(`  📄 ${meta.path_display}  size: ${meta.size || "?"}`);
          }
        }
      }
    } catch (e) {
      console.log(`  ✗ ${e?.error?.error_summary || e?.message}`);
    }
  }

  console.log(
    "\nIf nothing turned up, the file probably never made it to Dropbox (upload trigger fired but the move never happened) — soft-delete the row or re-scan the original."
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
