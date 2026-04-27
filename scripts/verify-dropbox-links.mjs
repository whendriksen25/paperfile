// Sanity check: walks every "processed" document and verifies that
//   1. The file actually exists in Dropbox at the stored dropbox_path.
//   2. dropbox_shared_link is set.
//   3. The share link returns 200 (HEAD request).
//
// Usage:
//   node --env-file=.env.local scripts/verify-dropbox-links.mjs
//   node --env-file=.env.local scripts/verify-dropbox-links.mjs --user=email@x.com
//
// Read-only — never writes to Dropbox or Supabase.

import { Dropbox } from "dropbox";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
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
    .select("id, file_name, dropbox_path, dropbox_shared_link, status, user_id")
    .eq("status", "processed")
    .order("created_at", { ascending: false });
  if (restrictUserId) q = q.eq("user_id", restrictUserId);
  const { data: docs, error } = await q;
  if (error) throw error;

  console.log(`\n[verify] checking ${docs.length} documents\n`);

  let okFile = 0,
    missingFile = 0,
    noLink = 0,
    badLink = 0,
    okLink = 0;
  const problems = [];

  for (const doc of docs) {
    const label = doc.dropbox_path || `(no path) ${doc.id}`;

    // 1. File exists in Dropbox?
    let fileExists = false;
    if (!doc.dropbox_path) {
      missingFile++;
      problems.push({ id: doc.id, issue: "no dropbox_path in DB" });
    } else {
      try {
        await dbx.filesGetMetadata({ path: doc.dropbox_path });
        fileExists = true;
        okFile++;
      } catch (e) {
        missingFile++;
        const msg = e?.error?.error_summary || e?.message || String(e);
        problems.push({ id: doc.id, path: doc.dropbox_path, issue: `file: ${msg}` });
      }
    }

    // 2. Link set?
    if (!doc.dropbox_shared_link) {
      noLink++;
      if (fileExists) {
        problems.push({ id: doc.id, path: doc.dropbox_path, issue: "no share link" });
      }
      continue;
    }

    // 3. Link reachable?
    try {
      const res = await fetch(doc.dropbox_shared_link, { method: "HEAD" });
      if (res.ok) {
        okLink++;
      } else {
        badLink++;
        problems.push({
          id: doc.id,
          path: doc.dropbox_path,
          issue: `link HTTP ${res.status}`,
        });
      }
    } catch (e) {
      badLink++;
      problems.push({
        id: doc.id,
        path: doc.dropbox_path,
        issue: `link fetch: ${e.message}`,
      });
    }
  }

  console.log(
    `[verify] file present: ${okFile}/${docs.length}    missing: ${missingFile}`
  );
  console.log(
    `[verify] link OK:      ${okLink}/${docs.length}    no-link: ${noLink}    bad: ${badLink}`
  );
  if (problems.length) {
    console.log(`\nProblems (${problems.length}):`);
    for (const p of problems) {
      console.log(`  ${p.id}  ${p.path || ""}  →  ${p.issue}`);
    }
    process.exit(1);
  }
  console.log("\n✓ All documents verified — file present and share link returns 200.\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
