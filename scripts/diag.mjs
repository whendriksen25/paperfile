// =============================================================================
// scripts/diag.mjs
// One-stop diagnostic CLI so we stop copying ad-hoc Node snippets back and
// forth in chat. Every subcommand prints in a stable format Claude can read.
//
// Usage:
//   node --env-file=.env.local scripts/diag.mjs <subcommand> [args...]
//
// Subcommands:
//   bank-stats <statement-id-or-prefix>
//     Total transactions, debit/credit/zero counts and totals, matched count.
//
//   last-reconcile <statement-id-or-prefix>
//     Most recent bank_reconcile maintenance_log entry for that statement
//     (when it ran + summary).
//
//   transactions <statement-id-or-prefix> [--limit=20] [--filter=debits|credits|unmatched]
//     Sample transactions from a statement.
//
//   doc <doc-id-or-prefix>
//     Dump the pertinent columns of a single documents row.
//
//   check-deploy
//     Show local HEAD vs origin/main, any uncommitted changes.
//
//   orphan <doc-id-or-prefix> [--fix-with=<path>]
//     Wrapper around scripts/find-orphan-doc.mjs.
//
//   help
//     Print this list.
// =============================================================================

import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const sub = argv[0];
const rest = argv.slice(1);

function flag(name, def = null) {
  const p = `--${name}=`;
  const hit = rest.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : def;
}
function positional() {
  return rest.filter((a) => !a.startsWith("--"));
}

function need(k) {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing env var: ${k} — run with --env-file=.env.local`);
    process.exit(1);
  }
  return v;
}

function admin() {
  return createClient(
    need("NEXT_PUBLIC_SUPABASE_URL"),
    need("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Accept either a full UUID or a short id-prefix and resolve to the full id
// by scanning recent rows of the given table. We only need this because
// PostgREST refuses LIKE on uuid columns. Returns null if no match.
async function resolveId(supabase, table, idArg, recentLimit = 2000) {
  const isFull =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idArg
    );
  if (isFull) return idArg;
  const { data, error } = await supabase
    .from(table)
    .select("id, created_at")
    .order("created_at", { ascending: false })
    .limit(recentLimit);
  if (error) throw error;
  const lower = idArg.toLowerCase();
  const matches = (data || []).filter((r) =>
    r.id.toLowerCase().startsWith(lower)
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(
      `  ⚠ prefix matches ${matches.length} rows in ${table}; using newest`
    );
  }
  return matches[0].id;
}

// Paginate around Supabase's server-side db-max-rows: 1000 cap.
async function fetchAll(supabase, builderFn, page = 1000, safetyCap = 50) {
  const all = [];
  let offset = 0;
  for (let i = 0; i < safetyCap; i++) {
    const { data, error } = await builderFn(offset, offset + page - 1);
    if (error) throw error;
    const rows = data || [];
    all.push(...rows);
    if (rows.length < page) break;
    offset += page;
  }
  return all;
}

function fmtMoney(n) {
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(n);
}

// ----------------------------------------------------------------------------
// Subcommands
// ----------------------------------------------------------------------------

async function cmdBankStats() {
  const [idArg] = positional();
  if (!idArg) throw new Error("Usage: diag bank-stats <statement-id-or-prefix>");
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }
  console.log(`statement_id: ${statementId}\n`);

  const rows = await fetchAll(supabase, (from, to) =>
    supabase
      .from("bank_transactions")
      .select(
        "id, amount, booking_date, value_date, matched_action_id, matched_document_id, matched_at, match_reason, counterparty_iban, counterparty_name, reference",
        { count: "exact" }
      )
      .eq("statement_id", statementId)
      .order("position", { ascending: true })
      .range(from, to)
  );

  let debitCount = 0,
    creditCount = 0,
    zeroCount = 0;
  let debitTotal = 0,
    creditTotal = 0;
  let matched = 0,
    matchedDebit = 0,
    withIban = 0,
    withReference = 0;
  let minDate = null,
    maxDate = null;

  for (const r of rows) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt) || amt === 0) zeroCount++;
    else if (amt < 0) {
      debitCount++;
      debitTotal += Math.abs(amt);
    } else {
      creditCount++;
      creditTotal += amt;
    }
    if (r.matched_action_id) {
      matched++;
      if (amt < 0) matchedDebit++;
    }
    if (r.counterparty_iban) withIban++;
    if (r.reference) withReference++;
    const d = r.booking_date || r.value_date;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  console.log(`Total transactions: ${rows.length}`);
  console.log(
    `  debits:  ${debitCount}  (${fmtMoney(debitTotal)})  matched: ${matchedDebit}`
  );
  console.log(`  credits: ${creditCount}  (${fmtMoney(creditTotal)})`);
  console.log(`  zero:    ${zeroCount}`);
  console.log(`  with counterparty_iban: ${withIban}`);
  console.log(`  with reference:         ${withReference}`);
  if (minDate)
    console.log(`  date range: ${minDate} → ${maxDate}`);
  console.log(`\nMatched debits: ${matched} / ${debitCount} debits`);
  if (debitCount > 0) {
    const pct = ((matched / debitCount) * 100).toFixed(1);
    console.log(`  → ${pct}% of debits auto-matched`);
  }
}

async function cmdLastReconcile() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error("Usage: diag last-reconcile <statement-id-or-prefix>");
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  // Pull recent bank_reconcile entries and filter by statement_doc_id in
  // the JSONB payload client-side — avoids an ad-hoc index.
  const { data, error } = await supabase
    .from("maintenance_log")
    .select("id, kind, reason, payload, created_at")
    .eq("kind", "bank_reconcile")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  const forStatement = (data || []).filter(
    (r) => r.payload?.statement_doc_id === statementId
  );
  console.log(`statement_id: ${statementId}`);
  console.log(`bank_reconcile entries: ${forStatement.length}\n`);
  if (forStatement.length === 0) {
    console.log("(no reconciliation runs found in maintenance_log)");
    return;
  }
  // Group by created_at minute → that's roughly one run.
  const runs = new Map();
  for (const r of forStatement) {
    const minute = r.created_at.slice(0, 16);
    if (!runs.has(minute)) runs.set(minute, []);
    runs.get(minute).push(r);
  }
  const sortedRuns = [...runs.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [minute, entries] of sortedRuns.slice(0, 5)) {
    console.log(`  ${minute}  →  ${entries.length} match(es)`);
    for (const e of entries.slice(0, 3)) {
      console.log(`    • ${e.reason}`);
    }
    if (entries.length > 3) console.log(`    ... and ${entries.length - 3} more`);
  }
}

async function cmdTransactions() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error(
      "Usage: diag transactions <statement-id-or-prefix> [--limit=20] [--filter=debits|credits|unmatched]"
    );
  const limit = Number(flag("limit", "20"));
  const filter = flag("filter", null);
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  let q = supabase
    .from("bank_transactions")
    .select(
      "id, amount, booking_date, counterparty_name, counterparty_iban, reference, matched_action_id"
    )
    .eq("statement_id", statementId);
  if (filter === "debits") q = q.lt("amount", 0);
  else if (filter === "credits") q = q.gt("amount", 0);
  else if (filter === "unmatched") q = q.is("matched_action_id", null);
  q = q.order("position", { ascending: true }).limit(limit);

  const { data, error } = await q;
  if (error) throw error;
  if (!data || data.length === 0) {
    console.log("(no transactions matched)");
    return;
  }
  for (const r of data) {
    const flagStr = r.matched_action_id ? "✓" : " ";
    const amt = Number(r.amount);
    const amtStr = amt.toFixed(2).padStart(10);
    const date = r.booking_date || "—";
    const name = (r.counterparty_name || "—").slice(0, 32).padEnd(32);
    const ref = (r.reference || "").slice(0, 28);
    console.log(`  ${flagStr} ${date}  ${amtStr}  ${name}  ${ref}`);
  }
}

async function cmdDoc() {
  const [idArg] = positional();
  if (!idArg) throw new Error("Usage: diag doc <doc-id-or-prefix>");
  const supabase = admin();
  const fullId = await resolveId(supabase, "documents", idArg);
  if (!fullId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }
  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, file_name, file_size_bytes, content_hash, dropbox_path, sender, document_type, document_date, purchase_category, profile_id, status, needs_action, action_type, action_summary, due_date, ai_input_tokens, ai_output_tokens, ai_stop_reason, ai_truncated, created_at"
    )
    .eq("id", fullId)
    .single();
  if (error) throw error;
  if (!data) {
    console.error("(not found)");
    return;
  }
  console.log(`id:              ${data.id}`);
  console.log(`file_name:       ${data.file_name}`);
  console.log(`file_size:       ${data.file_size_bytes}`);
  console.log(`content_hash:    ${data.content_hash || "(none)"}`);
  console.log(`dropbox_path:    ${data.dropbox_path}`);
  console.log(`sender:          ${data.sender}`);
  console.log(`document_type:   ${data.document_type}`);
  console.log(`document_date:   ${data.document_date}`);
  console.log(`purchase_cat:    ${data.purchase_category || "—"}`);
  console.log(`profile_id:      ${data.profile_id ?? "—"}`);
  console.log(`status:          ${data.status}`);
  console.log(`needs_action:    ${data.needs_action}`);
  console.log(`action_type:     ${data.action_type || "—"}`);
  console.log(`action_summary:  ${data.action_summary || "—"}`);
  console.log(`due_date:        ${data.due_date || "—"}`);
  console.log(
    `ai_tokens:       in=${data.ai_input_tokens ?? "—"} out=${data.ai_output_tokens ?? "—"} stop=${data.ai_stop_reason || "—"} truncated=${data.ai_truncated ?? "—"}`
  );
  console.log(`created_at:      ${data.created_at}`);
}

function cmdCheckDeploy() {
  const cwd =
    "/Users/jean/Documents/Personal/Werk/Software/document-archive";
  try {
    const localHead = execSync("git rev-parse HEAD", { cwd })
      .toString()
      .trim();
    const localShort = execSync("git rev-parse --short HEAD", { cwd })
      .toString()
      .trim();
    const localMsg = execSync('git log -1 --pretty=format:"%s"', { cwd })
      .toString()
      .trim();
    let remoteHead = "";
    try {
      execSync("git fetch origin --quiet", { cwd });
      remoteHead = execSync("git rev-parse origin/main", { cwd })
        .toString()
        .trim();
    } catch (e) {
      remoteHead = `(fetch failed: ${e.message})`;
    }
    const status = execSync("git status --porcelain", { cwd })
      .toString()
      .trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd })
      .toString()
      .trim();
    console.log(`branch:        ${branch}`);
    console.log(`local HEAD:    ${localShort}  ${localMsg}`);
    console.log(`local HEAD:    ${localHead}`);
    console.log(`origin/main:   ${remoteHead}`);
    console.log(
      `in sync:       ${localHead === remoteHead ? "yes" : "NO — needs push"}`
    );
    console.log(`uncommitted:   ${status ? "YES\n" + status : "clean"}`);
  } catch (e) {
    console.error(`git error: ${e.message}`);
    process.exit(1);
  }
}

function cmdOrphan() {
  if (positional().length === 0) {
    console.error(
      "Usage: diag orphan <doc-id-or-prefix> [--fix-with=<dropbox-path>]"
    );
    process.exit(1);
  }
  // Re-exec the existing script with the same args; --env-file is inherited
  // from the parent invocation. We use spawn(inherit) so output is live.
  const child = spawn(
    process.execPath,
    [
      "--env-file=.env.local",
      "scripts/find-orphan-doc.mjs",
      ...rest,
    ],
    { stdio: "inherit" }
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

function cmdHelp() {
  const help = `
diag — diagnostic CLI for document-archive

Usage:
  node --env-file=.env.local scripts/diag.mjs <subcommand> [args...]

Subcommands:
  bank-stats     <statement-id-or-prefix>
  last-reconcile <statement-id-or-prefix>
  transactions   <statement-id-or-prefix> [--limit=N] [--filter=debits|credits|unmatched]
  doc            <doc-id-or-prefix>
  check-deploy
  orphan         <doc-id-or-prefix> [--fix-with=<path>]
  help

Short IDs (first 8 chars) are accepted everywhere a full UUID is.
`;
  console.log(help.trim());
}

// ----------------------------------------------------------------------------

const dispatch = {
  "bank-stats": cmdBankStats,
  "last-reconcile": cmdLastReconcile,
  transactions: cmdTransactions,
  doc: cmdDoc,
  "check-deploy": cmdCheckDeploy,
  orphan: cmdOrphan,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};

(async function main() {
  if (!sub || !dispatch[sub]) {
    cmdHelp();
    process.exit(sub ? 1 : 0);
  }
  try {
    await dispatch[sub]();
  } catch (e) {
    console.error("FATAL:", e.message || e);
    process.exit(1);
  }
})();
