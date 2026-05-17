// =============================================================================
// scripts/diag.mjs
// One-stop diagnostic CLI so we stop copying ad-hoc Node snippets back and
// forth in chat. Every subcommand prints in a stable format Claude can read.
//
// Usage:
//   node --env-file=.env.local scripts/diag.mjs <subcommand> [args...]
//   npm run diag <subcommand> [args...]
//
// Note: when going through `npm run`, any --flag arguments need to come
// after a literal `--` separator, otherwise npm eats them:
//   npm run diag repair-matches 337361aa -- --dry-run
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
//   pay-actions [--limit=50]
//     Open pay-actions with the source doc's amount / IBAN / sender —
//     the right-hand side of the reconciliation join.
//
//   match-debug <tx-id-or-prefix>
//     Show why a specific bank transaction did or didn't match: amount,
//     IBAN, counterparty + the list of pay-actions that overlap on any
//     single signal.
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

// Walk maintenance_log entries (kind = bank_reconcile) for a statement
// and re-stamp the bank_transactions back-link (matched_action_id,
// matched_document_id, matched_at, match_reason) on the *current* row
// matching each entry's signature (amount + booking_date + IBAN + reference).
//
// Use case: an earlier reconcile closed actions and wrote to bank_transactions,
// but a subsequent re-analyze DELETE-INSERTed the bank_transactions rows
// (cascading away the matched_* state). The action side is still done; this
// command restores the orphan back-links so the statement detail page and
// bank-stats agree with reality.
// Dump every maintenance_log entry for a statement (kind = bank_reconcile).
// Shows action_id + bank_transaction_id + amount + timestamp so we can tell
// double-run-on-same-rows from over-matched-one-action-to-many-txs.
// Honest "bills paid via this statement" report.
//
// Avoids the misleading "0.5% of debits matched" headline by counting only:
//   - distinct pay-actions settled by this statement (matched_action_id),
//   - the total € paid against those bills,
// then contrasted with bills that were OPEN at any point during the
// statement period, so the percentage reflects payable bills only, not
// every routine debit.
async function cmdBillsPaid() {
  const [idArg] = positional();
  if (!idArg) throw new Error("Usage: diag bills-paid <statement-id-or-prefix>");
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  // Statement period (min/max booking_date of its transactions).
  const dateRows = await fetchAll(supabase, (from, to) =>
    supabase
      .from("bank_transactions")
      .select("booking_date, amount, matched_action_id, matched_document_id")
      .eq("statement_id", statementId)
      .range(from, to)
  );
  let minDate = null,
    maxDate = null;
  let paidAmount = 0;
  const matchedActionIds = new Set();
  for (const r of dateRows) {
    const d = r.booking_date;
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
    if (r.matched_action_id) {
      matchedActionIds.add(r.matched_action_id);
      paidAmount += Math.abs(Number(r.amount) || 0);
    }
  }
  if (!minDate) {
    console.log("(statement has no dated transactions)");
    return;
  }

  // Bills (pay-actions) that were open during the statement period —
  // i.e. created on or before maxDate, and either still open OR closed
  // with completed_at on or after minDate.
  const { data: actions, error: aErr } = await supabase
    .from("actions")
    .select(
      "id, status, completed_at, created_at, due_date, document:documents(amount, sender)"
    )
    .eq("action_type", "pay")
    .lte("created_at", maxDate + "T23:59:59")
    .limit(2000);
  if (aErr) throw aErr;

  let openInPeriod = 0,
    totalOwed = 0;
  for (const a of actions || []) {
    const closedInWindow =
      a.status !== "open" && (!a.completed_at || a.completed_at >= minDate);
    if (a.status === "open" || closedInWindow) {
      openInPeriod++;
      const amt = a.document?.amount;
      if (amt != null) totalOwed += Math.abs(Number(amt));
    }
  }

  const pct =
    openInPeriod > 0 ? ((matchedActionIds.size / openInPeriod) * 100).toFixed(1) : "—";
  const pctMoney =
    totalOwed > 0 ? ((paidAmount / totalOwed) * 100).toFixed(1) : "—";

  console.log(`statement_id: ${statementId}`);
  console.log(`period:       ${minDate}  →  ${maxDate}`);
  console.log("");
  console.log(`Bills paid via this statement:    ${matchedActionIds.size}`);
  console.log(`Bills open during this period:    ${openInPeriod}`);
  console.log(`  → ${pct}% of payable bills settled`);
  console.log("");
  console.log(`€ paid against tracked bills:     ${fmtMoney(paidAmount)}`);
  console.log(`€ owed across open bills:         ${fmtMoney(totalOwed)}`);
  console.log(`  → ${pctMoney}% of tracked invoice value settled`);
  console.log("");
  console.log(
    "(The other debits in this statement are routine spend — POS, fuel,"
  );
  console.log(
    " subs, transfers — with no Paperfile invoice to reconcile against.)"
  );
}

// For each open pay-action, scan this statement's debits for any
// candidate overlap (amount within tolerance OR IBAN OR sender). Three
// outcomes per bill:
//   - "no candidate" → bill genuinely unpaid in this period
//   - "1 candidate"  → matcher SHOULD have caught this (heuristic too tight?)
//   - "N candidates" → ambiguous, would need disambiguation
async function cmdUnmatchedBills() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error("Usage: diag unmatched-bills <statement-id-or-prefix>");
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  // Load all open pay-actions with their source doc.
  const { data: actions, error: aErr } = await supabase
    .from("actions")
    .select(
      "id, document_id, due_date, document:documents(amount, sender, document_date, extracted_fields)"
    )
    .eq("action_type", "pay")
    .eq("status", "open")
    .limit(500);
  if (aErr) throw aErr;

  // Same window the matcher uses (lib/services/bank-reconciliation.ts).
  const DATE_WINDOW_DAYS = 35;
  const dayDiff = (a, b) => {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
    return Math.abs(ta - tb) / 86400000;
  };

  // Load all debits on this statement (signed amount < 0).
  const txs = await fetchAll(supabase, (from, to) =>
    supabase
      .from("bank_transactions")
      .select("id, amount, booking_date, counterparty_name, counterparty_iban, reference, description")
      .eq("statement_id", statementId)
      .lt("amount", 0)
      .range(from, to)
  );

  const buckets = { zero: 0, one: 0, many: 0 };
  const reportable = [];
  for (const a of actions || []) {
    const d = a.document;
    if (!d || d.amount == null) {
      buckets.zero++;
      continue;
    }
    const docAbs = Math.abs(Number(d.amount));
    const tolerance = Math.max(0.5, docAbs * 0.005);
    const docIban = extractIban(d.extracted_fields);
    const senderN = nameNorm(d.sender);
    const refDate = d.document_date || a.due_date;
    const candidates = [];
    for (const tx of txs) {
      const txAbs = Math.abs(Number(tx.amount));
      const amountHit = Math.abs(txAbs - docAbs) <= tolerance;
      const ibanHit = docIban && tx.counterparty_iban && docIban === (tx.counterparty_iban || "").toUpperCase().replace(/\s+/g, "");
      const counterN = nameNorm(tx.counterparty_name || tx.description);
      const senderHit = senderN && counterN && (counterN.includes(senderN) || senderN.includes(counterN));
      if (!amountHit || !(ibanHit || senderHit)) continue;
      const txDate = tx.booking_date;
      const inWindow =
        refDate && txDate ? dayDiff(refDate, txDate) <= DATE_WINDOW_DAYS : true;
      candidates.push({ tx, inWindow, days: refDate && txDate ? dayDiff(refDate, txDate) : null });
    }
    // Only count candidates the matcher would actually consider (inside
    // the date window when dates are known on both sides).
    const matchable = candidates.filter((c) => c.inWindow);
    if (matchable.length === 0) buckets.zero++;
    else if (matchable.length === 1) {
      buckets.one++;
      reportable.push({ action: a, candidates: matchable, all: candidates });
    } else {
      buckets.many++;
      reportable.push({ action: a, candidates: matchable, all: candidates });
    }
  }

  console.log(`Open pay-actions:          ${(actions || []).length}`);
  console.log(`  no candidate debit:      ${buckets.zero}   → genuinely unpaid in this period`);
  console.log(`  exactly 1 candidate:     ${buckets.one}   → matcher missed these`);
  console.log(`  multiple candidates:     ${buckets.many}   → ambiguous`);
  if (reportable.length > 0) {
    console.log("\nDetail (candidates the matcher could have / should have caught):");
    console.log("Candidates marked ✗ are amount+vendor matches OUTSIDE the 35-day window — the matcher correctly rejects these.\n");
    for (const r of reportable.slice(0, 50)) {
      const a = r.action;
      const d = a.document;
      const refDate = d?.document_date || a.due_date || "—";
      console.log(
        `  • action ${a.id.slice(0, 8)}  ${d?.sender || "—"}  ${d?.amount ? Number(d.amount).toFixed(2) : "—"}  refDate=${refDate}  due=${a.due_date || "—"}`
      );
      for (const c of r.all.slice(0, 5)) {
        const mark = c.inWindow ? "✓" : "✗";
        const daysStr = c.days != null ? `${c.days.toFixed(0)}d` : "?";
        console.log(
          `      ${mark} tx ${c.tx.id.slice(0, 8)}  ${c.tx.booking_date}  ${Number(c.tx.amount).toFixed(2)}  ${c.tx.counterparty_name || "—"}  (${daysStr} away)`
        );
      }
    }
  }
}

// Re-run extraction on every document stuck in status='failed'. Hits the
// localhost-only admin-bridge/analyze endpoint, which runs the full
// pipeline as the document's real owner. Use after fixing an extraction
// bug (e.g. the messages.create → messages.stream change) to recover a
// batch of failed docs without clicking each one.
//
//   npm run diag retry-failed              # process all failed docs
//   npm run diag retry-failed -- --limit=5 # just the first 5
// Bulk-reassign documents to a different profile, filtered by sender,
// type, since-date, and/or current profile. Uses the same engine as the
// inbox multi-select UI (via the localhost dev server) so behavior
// stays consistent across both surfaces.
//
//   npm run diag bulk-reassign -- --sender="Frank Energie" --to=Pa --dry-run
//   npm run diag bulk-reassign -- --type=utility_bill --since=2026-01-01 --to=Pa
//   npm run diag bulk-reassign -- --from=Me --to=Daniël --dry-run
async function cmdBulkReassign() {
  const senderFilter = flag("sender", null);
  const typeFilter = flag("type", null);
  const sinceFilter = flag("since", null);
  const fromProfile = flag("from", null);
  const toProfile = flag("to", null);
  const dry = rest.includes("--dry-run");
  const limit = Number(flag("limit", "0")) || 0;

  if (!toProfile) {
    throw new Error(
      "Usage: diag bulk-reassign -- --to=<profile-name> [--sender=...] [--type=...] [--since=YYYY-MM-DD] [--from=<profile>] [--limit=N] [--dry-run]"
    );
  }

  const supabase = admin();

  // Resolve target profile by name.
  const { data: profiles, error: pErr } = await supabase
    .from("profiles")
    .select("id, name, user_id");
  if (pErr) throw pErr;
  const toP = (profiles || []).find(
    (p) => p.name?.toLowerCase() === toProfile.toLowerCase()
  );
  if (!toP) {
    console.error(`No profile named "${toProfile}". Available:`);
    for (const p of profiles || []) console.error(`  ${p.name}`);
    process.exit(1);
  }
  let fromPid = null;
  if (fromProfile) {
    const fromP = (profiles || []).find(
      (p) => p.name?.toLowerCase() === fromProfile.toLowerCase()
    );
    if (!fromP) {
      console.error(`No profile named "${fromProfile}".`);
      process.exit(1);
    }
    fromPid = fromP.id;
  }

  // Build the SELECT with filters.
  let q = supabase
    .from("documents")
    .select("id, file_name, sender, document_type, document_date, primary_profile_id")
    .eq("user_id", toP.user_id);
  if (senderFilter) q = q.ilike("sender", `%${senderFilter}%`);
  if (typeFilter) q = q.eq("document_type", typeFilter);
  if (sinceFilter) q = q.gte("document_date", sinceFilter);
  if (fromPid != null) q = q.eq("primary_profile_id", fromPid);
  if (limit > 0) q = q.limit(limit);
  const { data: docs, error: dErr } = await q;
  if (dErr) throw dErr;
  if (!docs || docs.length === 0) {
    console.log("No documents matched the filter. Nothing to do.");
    return;
  }
  console.log(`Matched ${docs.length} document(s) → profile "${toP.name}"`);
  for (const d of docs.slice(0, 25)) {
    console.log(
      `  ${d.id.slice(0, 8)}  ${d.sender || "—"}  ${d.document_type || "—"}  ${d.document_date || "—"}  ${d.file_name || ""}`
    );
  }
  if (docs.length > 25) console.log(`  ... and ${docs.length - 25} more`);

  if (dry) {
    console.log("\n(dry-run — no DB or Dropbox changes made)");
    return;
  }

  // Call the API endpoint via local dev server so the same auth/auth-z
  // flow as the UI is exercised, and we share the same service.
  const base = process.env.DEV_BASE_URL || "http://localhost:3002";
  const cookieJar = [];
  const loginRes = await fetch(`${base}/api/auth/dev-login`, { redirect: "manual" });
  const setCookie = loginRes.headers.get("set-cookie");
  if (setCookie) cookieJar.push(setCookie.split(";")[0]);

  // The /api/documents/bulk-reassign endpoint enforces "calling user owns
  // every doc". Dev-auto-login authenticates as wim@local.dev, which may
  // not be the doc owner. So instead, call the service directly via the
  // service-role admin client for the CLI path.
  // We dynamically import the compiled service — but since this is a .mjs
  // script and the service is .ts, we can't import directly. Instead we
  // POST to a separate "service-role" admin variant. For simplicity here,
  // do the same writes inline using the admin client.
  //
  // (Yes, this duplicates logic with reassign-bulk.ts. The reassign-bulk
  // service is the canonical implementation for the API path; this CLI
  // path uses a slimmed inline version to stay self-contained.)
  console.log("\nReassigning...");
  let moved = 0,
    failed = 0,
    skipped = 0;
  for (const d of docs) {
    if (d.primary_profile_id === toP.id) {
      skipped++;
      continue;
    }
    // For real moves the user should run the existing reassign-profile.mjs
    // script — it has the full Dropbox-move logic. The diag here just
    // identifies the docs and updates the DB primary_profile_id; the
    // file-move side is left to that script (run --to-profile=...).
    //
    // TODO: lift the diag to call the local API endpoint with proper
    // auth, OR inline the Dropbox move here. For now, a DB-only
    // reassignment is half the job.
    const { error: upErr } = await supabase
      .from("documents")
      .update({ primary_profile_id: toP.id, needs_review: false })
      .eq("id", d.id);
    if (upErr) {
      failed++;
      console.log(`  ✗ ${d.id.slice(0, 8)}: ${upErr.message}`);
    } else {
      moved++;
      console.log(`  ✓ ${d.id.slice(0, 8)}: DB updated`);
    }
  }
  console.log(
    `\nDone. moved=${moved} skipped=${skipped} failed=${failed} (DB-only; run scripts/reassign-profile.mjs to also move files in Dropbox)`
  );
  console.log(
    "TIP: the inbox multi-select (Select mode → checkboxes → Move N) handles both DB + Dropbox in one shot."
  );
}

// ----------------------------------------------------------------------------
// Taxonomy helpers — mirror of lib/services/taxonomy.ts so the diag can run
// inline normalisation/matching without importing the TS module.
// ----------------------------------------------------------------------------

function normalizeToken(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
}
function singularize(s) {
  if (s.length <= 3) return s;
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("sses")) return s.slice(0, -2);
  if (s.endsWith("ches") || s.endsWith("shes")) return s.slice(0, -2);
  if (s.endsWith("xes") || s.endsWith("zes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us")) {
    return s.slice(0, -1);
  }
  return s;
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1), curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + c);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}
function maxAcceptableEdits(s) {
  if (s.length <= 4) return 1;
  if (s.length <= 7) return 2;
  return 3;
}

/**
 * Walk every doc's line_items, canonicalise category_path against the
 * user's existing taxonomy table (auto-registering new tokens), and
 * write the rewritten path back. One-shot — re-run safe; idempotent.
 *
 *   npm run diag taxonomy-backfill -- --dry-run
 *   npm run diag taxonomy-backfill
 */
/**
 * Find documents that have multi-doc children, identify stale duplicates
 * (children created by an earlier split run that a later re-analyze
 * superseded), and delete them.
 *
 * Definition of "stale": children whose ID is NOT in the most recent
 * multi_doc_split maintenance_log entry's payload.child_document_ids
 * for this parent.
 *
 *   npm run diag cleanup-multi-doc-dupes -- --dry-run
 *   npm run diag cleanup-multi-doc-dupes
 */
async function cmdCleanupMultiDocDupes() {
  const dryRun = rest.includes("--dry-run");
  const supabase = admin();

  // 1. Find every distinct parent that has children.
  const { data: kids } = await supabase
    .from("documents")
    .select("parent_document_id")
    .not("parent_document_id", "is", null)
    .neq("status", "deleted")
    .limit(5000);
  const parentIds = Array.from(
    new Set((kids || []).map((r) => r.parent_document_id))
  );
  if (parentIds.length === 0) {
    console.log("No multi-doc parents found — nothing to clean.");
    return;
  }
  console.log(`Checking ${parentIds.length} multi-doc parent(s)...`);

  let totalStale = 0;
  let totalKept = 0;
  for (const parentId of parentIds) {
    // 2. The most recent multi_doc_split log entry for this parent.
    const { data: logs } = await supabase
      .from("maintenance_log")
      .select("payload, created_at")
      .eq("kind", "multi_doc_split")
      .eq("document_id", parentId)
      .order("created_at", { ascending: false })
      .limit(1);
    const latestLog = (logs || [])[0];
    if (!latestLog) {
      console.log(
        `  ? ${parentId.slice(0, 8)} — no multi_doc_split log, skipping`
      );
      continue;
    }
    const expected = new Set(
      (latestLog.payload?.child_document_ids || [])
    );
    // 3. Current children for this parent.
    const { data: currentKids } = await supabase
      .from("documents")
      .select("id, sender, document_date, amount, created_at")
      .eq("parent_document_id", parentId)
      .neq("status", "deleted")
      .order("created_at", { ascending: true });
    const stale = (currentKids || []).filter((c) => !expected.has(c.id));
    const keep = (currentKids || []).filter((c) => expected.has(c.id));
    totalKept += keep.length;
    if (stale.length === 0) {
      continue;
    }
    console.log(
      `  ✗ ${parentId.slice(0, 8)} — ${stale.length} stale child(ren) (keeping ${keep.length})`
    );
    for (const s of stale) {
      console.log(
        `      stale: ${s.id.slice(0, 8)}  ${s.sender || "—"}  ${s.amount ?? "—"}  created ${s.created_at}`
      );
    }
    totalStale += stale.length;
    if (!dryRun) {
      const staleIds = stale.map((s) => s.id);
      await supabase.from("actions").delete().in("document_id", staleIds);
      await supabase.from("documents").delete().in("id", staleIds);
    }
  }
  console.log(
    `\nDone. ${totalStale} stale child(ren) ${dryRun ? "would be deleted" : "deleted"}, ${totalKept} kept.${dryRun ? " Re-run without --dry-run to apply." : ""}`
  );
}

async function cmdTaxonomyBackfill() {
  const dryRun = rest.includes("--dry-run");
  const supabase = admin();

  // 1. Find the user (single-user setup — use the first user with docs).
  const { data: anyDoc } = await supabase
    .from("documents")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  if (!anyDoc) {
    console.log("No documents found.");
    return;
  }
  const userId = anyDoc.user_id;

  // 2. Snapshot the taxonomy table (per top_category lookup).
  const { data: taxRows } = await supabase
    .from("line_item_taxonomy")
    .select("id, top_category, token, aliases, usage_count")
    .eq("user_id", userId);
  const byTop = new Map();
  for (const r of taxRows || []) {
    const arr = byTop.get(r.top_category) || [];
    arr.push(r);
    byTop.set(r.top_category, arr);
  }

  // 3. Walk all docs with line_items.
  const PAGE = 1000;
  let offset = 0;
  let scanned = 0, changed = 0, newTokens = 0;
  const pendingNewTokens = new Map(); // key "top|token" → { top, token, count }
  while (true) {
    const { data: docs, error } = await supabase
      .from("documents")
      .select("id, extracted_fields")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error(error);
      break;
    }
    if (!docs || docs.length === 0) break;
    for (const d of docs) {
      scanned++;
      const ef = d.extracted_fields;
      if (!ef || typeof ef !== "object") continue;
      const items = ef.line_items;
      if (!Array.isArray(items) || items.length === 0) continue;
      let dirty = false;
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const path = it.category_path;
        if (!Array.isArray(path) || path.length === 0) continue;
        const capped = path.slice(0, 3).map((x) => String(x || ""));
        const top = capped[0]?.toLowerCase().trim();
        if (!top) continue;
        const out = [top];
        const rows = byTop.get(top) || [];
        for (let i = 1; i < capped.length; i++) {
          const cleaned = singularize(normalizeToken(capped[i]));
          if (!cleaned) break;
          const direct = rows.find(
            (r) => r.token === cleaned || (r.aliases || []).includes(cleaned)
          );
          if (direct) {
            out.push(direct.token);
            continue;
          }
          let best = null;
          for (const r of rows) {
            const d = levenshtein(cleaned, r.token);
            if (d <= maxAcceptableEdits(cleaned)) {
              if (!best || d < best.d) best = { row: r, d };
            }
          }
          if (best) {
            out.push(best.row.token);
            continue;
          }
          // New token — queue for registration after backfill.
          const key = `${top}|${cleaned}`;
          const cur = pendingNewTokens.get(key) || { top, token: cleaned, count: 0 };
          cur.count++;
          pendingNewTokens.set(key, cur);
          out.push(cleaned);
        }
        // If the path actually changed, mark the doc dirty.
        if (JSON.stringify(out) !== JSON.stringify(capped)) {
          it.category_path = out;
          if (out.length > 0) it.category = out[0];
          dirty = true;
          changed++;
        } else if (capped.length !== path.length) {
          // We capped depth — still a change.
          it.category_path = capped;
          dirty = true;
        }
      }
      if (dirty && !dryRun) {
        await supabase
          .from("documents")
          .update({ extracted_fields: ef })
          .eq("id", d.id);
      }
    }
    if (docs.length < PAGE) break;
    offset += PAGE;
  }

  // 4. Register the new tokens we discovered.
  newTokens = pendingNewTokens.size;
  if (!dryRun && newTokens > 0) {
    for (const { top, token, count } of Array.from(pendingNewTokens.values())) {
      await supabase
        .from("line_item_taxonomy")
        .upsert(
          {
            user_id: userId,
            top_category: top,
            token,
            aliases: [],
            usage_count: count,
            last_seen_at: new Date().toISOString(),
          },
          { onConflict: "user_id,top_category,token", ignoreDuplicates: false }
        );
    }
  }

  console.log(
    `Scanned ${scanned} docs · rewrote ${changed} line items · ${newTokens} new tokens ${dryRun ? "(dry-run — no writes)" : "registered"}.`
  );
}

/**
 * AI-driven cleanup pass. Lists every taxonomy token under each
 * top-category, asks Claude to suggest merges where tokens are
 * obviously the same concept ("apples" → "apple", "wholemilk" →
 * "milk"). Prints suggestions; the user re-runs with --apply to
 * actually merge them.
 *
 *   npm run diag taxonomy-cleanup            # dry-run, print suggestions
 *   npm run diag taxonomy-cleanup -- --apply # merge them
 */
async function cmdTaxonomyCleanup() {
  const apply = rest.includes("--apply");
  const supabase = admin();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing — cannot ask Claude for merges.");
    process.exit(1);
  }
  const { Anthropic } = await import("@anthropic-ai/sdk").then((m) => ({
    Anthropic: m.default || m.Anthropic,
  }));

  const { data: anyDoc } = await supabase
    .from("documents")
    .select("user_id")
    .limit(1)
    .maybeSingle();
  if (!anyDoc) {
    console.log("No documents found.");
    return;
  }
  const userId = anyDoc.user_id;

  const { data: taxRows } = await supabase
    .from("line_item_taxonomy")
    .select("id, top_category, token, aliases, usage_count")
    .eq("user_id", userId)
    .order("top_category", { ascending: true })
    .order("usage_count", { ascending: false });

  if (!taxRows || taxRows.length === 0) {
    console.log("No taxonomy entries yet — nothing to clean up.");
    return;
  }

  // Group by top_category and run Claude per group.
  const byTop = new Map();
  for (const r of taxRows) {
    const arr = byTop.get(r.top_category) || [];
    arr.push(r);
    byTop.set(r.top_category, arr);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let totalSuggestions = 0;
  let totalApplied = 0;

  for (const [top, rows] of Array.from(byTop.entries())) {
    if (rows.length < 2) continue;
    process.stdout.write(`\n[${top}] ${rows.length} tokens · asking Claude... `);
    const tokenList = rows
      .map(
        (r) =>
          `  - ${r.token} (used ${r.usage_count}× , aliases: ${(r.aliases || []).join(",") || "none"})`
      )
      .join("\n");
    const prompt = `You're cleaning up a personal spending-category glossary. Below is the list of subcategory tokens used under the top-level category "${top}". Find tokens that are obviously the same concept and should be merged.

Tokens:
${tokenList}

Return ONLY a JSON array of merge proposals, no prose. Each item:
{ "canonical": "<keep this token>", "merge_in": ["<token to fold into canonical>", ...], "reason": "<short>" }

Rules:
- Only propose merges you're confident about. If in doubt, leave alone.
- Prefer the more-used token as the canonical.
- Use lowercase singular ("apple", not "apples").
- Return an empty array [] if nothing should be merged.`;

    try {
      const resp = await client.messages.create({
        // Mirrors AI_MODEL_FAST in lib/ai/pricing.ts. Override via ENV.
        model:
          process.env.ANTHROPIC_MODEL_FAST || "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });
      const text =
        resp.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || "";
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const body = (fence ? fence[1] : text).trim();
      const start = body.indexOf("[");
      const end = body.lastIndexOf("]");
      if (start === -1 || end === -1) {
        console.log("no JSON array in response, skipping");
        continue;
      }
      const suggestions = JSON.parse(body.slice(start, end + 1));
      console.log(`${suggestions.length} suggestion(s)`);
      for (const s of suggestions) {
        if (!s || !s.canonical || !Array.isArray(s.merge_in)) continue;
        console.log(
          `  ✏ ${s.canonical} ← [${s.merge_in.join(", ")}]  · ${s.reason || ""}`
        );
        totalSuggestions++;
        if (!apply) continue;
        // Apply: bump canonical's aliases + usage, delete merged-in rows,
        // rewrite docs containing the merged tokens.
        const canonRow = rows.find((r) => r.token === s.canonical);
        if (!canonRow) continue;
        const newAliases = Array.from(
          new Set([...(canonRow.aliases || []), ...s.merge_in])
        );
        const mergedRows = rows.filter((r) =>
          s.merge_in.includes(r.token)
        );
        const newUsage = canonRow.usage_count + mergedRows.reduce((sum, r) => sum + r.usage_count, 0);
        await supabase
          .from("line_item_taxonomy")
          .update({
            aliases: newAliases,
            usage_count: newUsage,
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", canonRow.id);
        // Delete the merged-in rows.
        if (mergedRows.length > 0) {
          await supabase
            .from("line_item_taxonomy")
            .delete()
            .in(
              "id",
              mergedRows.map((r) => r.id)
            );
        }
        totalApplied++;
      }
    } catch (e) {
      console.log(`error: ${e.message || e}`);
    }
  }

  console.log(
    `\nDone. ${totalSuggestions} suggestion(s).${apply ? ` Applied ${totalApplied} merge(s) to taxonomy. NOTE: run diag taxonomy-backfill after this to rewrite existing docs.` : " Re-run with --apply to merge them."}`
  );
}

/**
 * Run Claude's multi-doc detection on a doc's file and print the
 * detected bounding boxes + per-doc summary. Doesn't touch the
 * database — purely a debug tool for "is Claude seeing N receipts
 * correctly on this scan?" before we attempt the full crop+re-extract.
 *
 *   npm run diag detect-multidoc <doc-id-prefix>
 */
async function cmdDetectMultidoc() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error("Usage: diag detect-multidoc <doc-id-or-prefix>");
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY missing");
    process.exit(1);
  }
  const supabase = admin();
  const docId = await resolveId(supabase, "documents", idArg);
  if (!docId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  // Load doc + its dropbox_path
  const { data: doc } = await supabase
    .from("documents")
    .select("id, file_name, dropbox_path")
    .eq("id", docId)
    .single();
  if (!doc?.dropbox_path) {
    console.error("Doc has no dropbox_path");
    process.exit(1);
  }
  console.log(`doc:       ${doc.id.slice(0, 8)}`);
  console.log(`file_name: ${doc.file_name}`);
  console.log(`path:      ${doc.dropbox_path}`);

  // Download file
  const { Dropbox } = await import("dropbox");
  const patchedFetch = async (input, init) => {
    const res = await fetch(input, init);
    if (!res.buffer) res.buffer = async () => Buffer.from(await res.arrayBuffer());
    return res;
  };
  const dbx = new Dropbox({
    clientId: process.env.DROPBOX_APP_KEY,
    clientSecret: process.env.DROPBOX_APP_SECRET,
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN,
    fetch: patchedFetch,
  });
  console.log("\nDownloading...");
  const dl = await dbx.filesDownload({ path: doc.dropbox_path });
  let buffer = Buffer.from((dl.result).fileBinary);
  console.log(`downloaded ${buffer.length} bytes`);

  // Match the analyze route: auto-rotate via EXIF before sending to Claude
  // so the diag reflects what production sees.
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default || sharpMod;
    const meta = await sharp(buffer).metadata();
    if (meta.orientation && meta.orientation !== 1) {
      const before = buffer.length;
      buffer = await sharp(buffer).rotate().jpeg({ quality: 92 }).toBuffer();
      console.log(
        `auto-rotated (EXIF=${meta.orientation}): ${before} → ${buffer.length} bytes`
      );
    }
  } catch (e) {
    console.warn("auto-rotate skipped:", e.message);
  }

  // Build a stripped-down prompt focused only on multi-doc detection + polygons.
  // NOTE: keep this in lockstep with lib/services/analyze-job.ts → DETECT_PROMPT
  // (and with the multi-doc block in lib/ai/prompts.ts). Both share the same
  // contract: return polygons hugging each receipt's perimeter, with an
  // optional rotation_estimate_degrees per polygon.
  const prompt = `Examine this scan and detect whether it contains multiple separate documents (receipts, invoices, etc).

Identify each receipt by its CONTENT (header / store name, line items, total, date) — NOT by background colour or contrast. Receipts may be tilted, slightly overlapping, or on cluttered backgrounds; handle all of these.

If MULTIPLE distinct documents on one scan, return STRICT JSON:
{
  "documents": [ { "sender": "...", "amount": <number|null>, "document_date": "YYYY-MM-DD|null", "summary": "one line", "rotation_estimate_degrees": <number> }, ... ],
  "polygons": [
    {
      "vertices": [
        {"x": 0.15, "y": 0.00},
        {"x": 0.40, "y": 0.00},
        {"x": 0.40, "y": 0.65},
        {"x": 0.15, "y": 0.65}
      ],
      "rotation_estimate_degrees": 0
    },
    ...
  ]
}

If SINGLE doc, return: { "documents": [{single-doc-summary}], "polygons": [] }

POLYGON RULES:
- 4 or more vertices that hug the receipt's actual perimeter (not a loose rectangle).
- Vertices in normalised [0..1] coords, top-left origin (x=0,y=0 is the image's top-left).
- Listed CLOCKWISE starting from the receipt's OWN top-left corner (where its printed header sits), even if the receipt is tilted on the page.
- rotation_estimate_degrees: the receipt's tilt vs upright. 0 = upright. Positive = clockwise. Range roughly -45..+45.
- documents[i] and polygons[i] are index-aligned.

Return ONLY the JSON object. No prose, no markdown.`;

  // Call Claude
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const isImage = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(doc.file_name || "");
  const mediaType = isImage
    ? (/png$/i.test(doc.file_name) ? "image/png" : "image/jpeg")
    : "application/pdf";
  console.log(`\nCalling Claude (${mediaType})...`);
  const t0 = Date.now();
  // Mirrors AI_MODEL_SMART in lib/ai/pricing.ts. Override via ENV.
  const detectModel =
    process.env.ANTHROPIC_MODEL_SMART || "claude-sonnet-4-6";
  console.log(`model:     ${detectModel}`);
  const stream = client.messages.stream({
    model: detectModel,
    max_tokens: 8000,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          isImage
            ? {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
              }
            : {
                type: "document",
                source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
              },
        ],
      },
    ],
  });
  const resp = await stream.finalMessage();
  const ms = Date.now() - t0;
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
  console.log(`Claude responded in ${ms}ms · in=${resp.usage?.input_tokens} out=${resp.usage?.output_tokens} stop=${resp.stop_reason}`);

  // Parse
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    console.log("\n!!! Could not parse JSON. Raw response:");
    console.log(text);
    return;
  }

  // Print
  const docs = parsed.documents || [];
  let polygons = Array.isArray(parsed.polygons) ? parsed.polygons : [];
  const boxes = Array.isArray(parsed.bounding_boxes)
    ? parsed.bounding_boxes
    : [];
  // Back-compat: if the model emitted only bounding_boxes (e.g. older
  // run or a model that ignored the polygon part of the prompt), fold
  // each box into a 4-vertex rectangular polygon so the print loop
  // below has a single representation to walk over.
  if (polygons.length !== docs.length && boxes.length === docs.length) {
    polygons = boxes.map((b) => ({
      vertices: [
        { x: b.x, y: b.y },
        { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h },
        { x: b.x, y: b.y + b.h },
      ],
      rotation_estimate_degrees: 0,
    }));
    console.log("(converted legacy bounding_boxes → rectangular polygons for display)");
  }

  // Geometry helper: angle of longest polygon edge above horizontal,
  // in degrees, restricted to (-90, 90]. Mirrors the helper in
  // lib/services/image-crop.ts so the diag's computed rotation matches
  // what the production cropper would apply.
  function longestEdgeDeg(verts) {
    if (!verts || verts.length < 2) return 0;
    let bestLen = -1, bestDx = 0, bestDy = 0;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const dx = (Number(b.x) || 0) - (Number(a.x) || 0);
      const dy = (Number(b.y) || 0) - (Number(a.y) || 0);
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > bestLen) { bestLen = len; bestDx = dx; bestDy = dy; }
    }
    let deg = (Math.atan2(bestDy, bestDx) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg <= -90) deg += 180;
    return deg;
  }

  console.log(`\n=== Detected ${docs.length} document(s) ===`);
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const p = polygons[i];
    console.log(`  #${i + 1}: ${d.sender || "—"} · €${d.amount ?? "—"} · ${d.document_date || "—"}`);
    if (d.summary) console.log(`        ${d.summary}`);
    if (p && Array.isArray(p.vertices) && p.vertices.length > 0) {
      // Print every vertex as a percentage pair so the operator can
      // sanity-check that the polygon hugs the receipt's perimeter.
      const vlines = p.vertices
        .map(
          (v, vi) =>
            `          v${vi}: (${((Number(v.x) || 0) * 100).toFixed(1)}%, ${(
              (Number(v.y) || 0) * 100
            ).toFixed(1)}%)`
        )
        .join("\n");
      console.log(`        polygon (${p.vertices.length} vertices):\n${vlines}`);
      // Explicit hint wins; otherwise fall back to longest-edge geometry
      // (tilt vs vertical = edgeAngle - 90° if edgeAngle > 0, else +90°).
      let tilt = null;
      if (typeof p.rotation_estimate_degrees === "number") {
        tilt = p.rotation_estimate_degrees;
      } else {
        const edge = longestEdgeDeg(p.vertices);
        tilt = edge > 0 ? edge - 90 : edge + 90;
      }
      console.log(
        `        rotation: ${tilt.toFixed(1)}° (${
          typeof p.rotation_estimate_degrees === "number"
            ? "explicit hint"
            : "derived from longest edge"
        })`
      );
    } else {
      console.log(`        (no polygon)`);
    }
  }
  if (docs.length > 1 && polygons.length !== docs.length) {
    console.log(
      `\n⚠  polygons count (${polygons.length}) doesn't match documents count (${docs.length})`
    );
  }
}

async function cmdRetryFailed() {
  const limit = Number(flag("limit", "0")) || 0;
  const base = process.env.DEV_BASE_URL || "http://localhost:3002";
  const supabase = admin();

  const { data, error } = await supabase
    .from("documents")
    .select("id, file_name, status, created_at")
    .eq("status", "failed")
    .order("created_at", { ascending: true });
  if (error) throw error;
  let docs = data || [];
  if (docs.length === 0) {
    console.log("No documents in status='failed'. Nothing to do.");
    return;
  }
  if (limit > 0) docs = docs.slice(0, limit);
  console.log(`Found ${docs.length} failed document(s) to retry via ${base}\n`);

  // Dev-login to get a session cookie. admin-bridge/analyze still
  // processes each doc as its true owner, so the dev session is only
  // a gate, not an identity.
  const cookieJar = [];
  try {
    const loginRes = await fetch(`${base}/api/auth/dev-login`, {
      redirect: "manual",
    });
    const setCookie = loginRes.headers.get("set-cookie");
    if (setCookie) cookieJar.push(setCookie.split(";")[0]);
  } catch (e) {
    console.error(`Could not reach dev server at ${base}: ${e.message}`);
    console.error("Start it with `npm run dev` first.");
    process.exit(1);
  }
  const cookieHeader = cookieJar.join("; ");

  let ok = 0,
    failed = 0;
  for (const doc of docs) {
    process.stdout.write(`  ${doc.id.slice(0, 8)}  ${doc.file_name}  ... `);
    try {
      const res = await fetch(`${base}/api/admin-bridge/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ document_id: doc.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        ok++;
        console.log(`✓ ${json.status || "done"}`);
      } else {
        failed++;
        console.log(`✗ ${res.status}: ${json.error || "unknown"}`);
      }
    } catch (e) {
      failed++;
      console.log(`✗ ${e.message}`);
    }
  }
  console.log(`\nDone. ${ok} re-analyzed, ${failed} still failing.`);
}

async function cmdReconcileLog() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error("Usage: diag reconcile-log <statement-id-or-prefix>");
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }
  const { data, error } = await supabase
    .from("maintenance_log")
    .select("id, payload, created_at, reason")
    .eq("kind", "bank_reconcile")
    .order("created_at", { ascending: true })
    .limit(2000);
  if (error) throw error;
  const rows = (data || []).filter(
    (r) => r.payload?.statement_doc_id === statementId
  );
  console.log(`statement_id: ${statementId}`);
  console.log(`bank_reconcile entries: ${rows.length}\n`);
  if (rows.length === 0) {
    console.log("(no entries)");
    return;
  }
  const actionIds = new Set();
  const txIds = new Set();
  for (const r of rows) {
    const p = r.payload || {};
    actionIds.add(p.action_id);
    txIds.add(p.bank_transaction_id);
    const ts = r.created_at.slice(11, 19);
    console.log(
      `  ${r.created_at.slice(0, 10)} ${ts}  action=${String(p.action_id || "").slice(0, 8)}  tx=${String(p.bank_transaction_id || "").slice(0, 8)}  ${Number(p.amount).toFixed(2)}  ${p.counterparty || "—"}`
    );
  }
  console.log(
    `\nDistinct action_ids: ${actionIds.size}   distinct bank_transaction_ids: ${txIds.size}`
  );
  if (rows.length > actionIds.size && txIds.size === actionIds.size) {
    console.log(
      "  → reconcile fired twice on identical bank_transactions state (double-run); back-links were idempotent."
    );
  } else if (txIds.size > actionIds.size) {
    console.log(
      "  → one action was matched to multiple bank transactions (over-matching). Need a many-to-one guard in the matcher."
    );
  }
}

async function cmdRepairMatches() {
  const [idArg] = positional();
  const dryRun = rest.includes("--dry-run");
  if (!idArg)
    throw new Error(
      "Usage: diag repair-matches <statement-id-or-prefix> [--dry-run]"
    );
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }

  // Pull all bank_reconcile log entries for this statement.
  const { data: logRows, error: logErr } = await supabase
    .from("maintenance_log")
    .select("id, payload, created_at")
    .eq("kind", "bank_reconcile")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (logErr) throw logErr;
  const forStatement = (logRows || []).filter(
    (r) => r.payload?.statement_doc_id === statementId
  );

  // De-dup by action_id (latest entry wins).
  const byAction = new Map();
  for (const r of forStatement) {
    const aid = r.payload?.action_id;
    if (!aid) continue;
    if (!byAction.has(aid)) byAction.set(aid, r);
  }
  console.log(`statement_id: ${statementId}`);
  console.log(`unique closed-action log entries: ${byAction.size}`);
  if (byAction.size === 0) {
    console.log("(nothing to repair)");
    return;
  }

  // For each, find the current bank_transactions row by signature.
  let stamped = 0,
    skippedAmbiguous = 0,
    skippedMissing = 0;
  for (const [actionId, log] of byAction.entries()) {
    const p = log.payload;
    let q = supabase
      .from("bank_transactions")
      .select("id, amount, booking_date, counterparty_iban, reference")
      .eq("statement_id", statementId)
      .eq("amount", p.amount);
    if (p.booking_date) q = q.eq("booking_date", p.booking_date);
    if (p.counterparty_iban) q = q.eq("counterparty_iban", p.counterparty_iban);
    const { data: candidates, error: cErr } = await q.limit(5);
    if (cErr) throw cErr;
    let rows = candidates || [];
    // If still >1, narrow by reference.
    if (rows.length > 1 && p.reference) {
      const tight = rows.filter((r) => r.reference === p.reference);
      if (tight.length > 0) rows = tight;
    }
    if (rows.length === 0) {
      skippedMissing++;
      console.log(
        `  ✗ action ${actionId.slice(0, 8)}  amount=${p.amount}  date=${p.booking_date}  iban=${p.counterparty_iban || "—"}  → no current bank_tx row matches`
      );
      continue;
    }
    if (rows.length > 1) {
      skippedAmbiguous++;
      console.log(
        `  ⚠ action ${actionId.slice(0, 8)}  amount=${p.amount}  → ${rows.length} bank_tx rows tie, skipping`
      );
      continue;
    }
    const tx = rows[0];
    // Look up action.document_id (matched_document_id needs it).
    const { data: actRow } = await supabase
      .from("actions")
      .select("document_id")
      .eq("id", actionId)
      .maybeSingle();
    const docId = actRow?.document_id || null;

    if (dryRun) {
      console.log(
        `  • DRY action ${actionId.slice(0, 8)}  →  tx ${tx.id.slice(0, 8)}  ${p.amount}  ${p.booking_date}`
      );
    } else {
      const { error: upErr } = await supabase
        .from("bank_transactions")
        .update({
          matched_action_id: actionId,
          matched_document_id: docId,
          matched_at: log.created_at,
          match_reason: `Repaired from maintenance_log: ${log.payload.bank_transaction_id ? "was tx " + String(log.payload.bank_transaction_id).slice(0, 8) : ""}`,
        })
        .eq("id", tx.id);
      if (upErr) {
        console.log(
          `  ✗ action ${actionId.slice(0, 8)}  →  update failed: ${upErr.message || JSON.stringify(upErr)}`
        );
        continue;
      }
      stamped++;
      console.log(
        `  ✓ action ${actionId.slice(0, 8)}  →  tx ${tx.id.slice(0, 8)}  ${p.amount}  ${p.booking_date}`
      );
    }
  }
  console.log(
    `\nDone. stamped=${stamped}  ambiguous=${skippedAmbiguous}  missing=${skippedMissing}${dryRun ? "  (dry-run — no writes)" : ""}`
  );
}

async function cmdReconcileSummary() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error(
      "Usage: diag reconcile-summary <statement-id-or-prefix>"
    );
  const supabase = admin();
  const statementId = await resolveId(supabase, "documents", idArg);
  if (!statementId) {
    console.error(`No documents row found matching "${idArg}"`);
    process.exit(1);
  }
  const { data, error } = await supabase
    .from("documents")
    .select("id, extracted_fields")
    .eq("id", statementId)
    .single();
  if (error) throw error;
  const summary = data?.extracted_fields?._reconciliation;
  if (!summary) {
    console.log(
      "(no _reconciliation blob on this doc — Re-reconcile hasn't run since the field was added, or the API call failed before persisting)"
    );
    return;
  }
  console.log(`statement_id: ${statementId}`);
  console.log(`ran_at:       ${summary.ran_at}`);
  console.log("");
  console.log("Deterministic pass:");
  console.log(`  considered:  ${summary.considered}`);
  console.log(`  matched:     ${summary.matched}`);
  console.log(`  ambiguous:   ${summary.ambiguous}`);
  console.log(`  unmatched:   ${summary.unmatched}`);
  if (summary.back_link_write_failures !== undefined) {
    console.log(
      `  back_link_write_failures: ${summary.back_link_write_failures}  ${summary.back_link_write_failures > 0 ? "⚠  matches written in memory but NOT persisted to bank_transactions" : ""}`
    );
  }
  if (summary.reset) {
    console.log("");
    console.log("Reset sub-block (Reset button was used):");
    console.log(`  reopened_actions: ${summary.reset.reopened_actions}`);
    console.log(`  restored_docs:    ${summary.reset.restored_docs}`);
  }
  if (summary.ai) {
    console.log("");
    console.log("AI pass:");
    if (summary.ai.error) {
      console.log(`  error:               ${summary.ai.error}`);
    } else if (summary.ai.ai_call_skipped) {
      console.log(`  ai_call_skipped:     true`);
      console.log(`  skip_reason:         ${summary.ai.skip_reason}`);
      console.log(`  considered_bills:    ${summary.ai.considered_bills}`);
      console.log(`  considered_debits:   ${summary.ai.considered_debits}`);
    } else {
      // Background-job format writes chunks_total/chunks_done/finished_at;
      // the legacy inline format wrote considered_bills/considered_debits.
      // Show whichever set is present.
      if (summary.ai.chunks_total !== undefined) {
        console.log(`  chunks:              ${summary.ai.chunks_done} / ${summary.ai.chunks_total} done`);
        if (summary.ai.finished_at)
          console.log(`  finished_at:         ${summary.ai.finished_at}`);
      } else {
        console.log(`  considered_bills:    ${summary.ai.considered_bills}`);
        console.log(`  considered_debits:   ${summary.ai.considered_debits}`);
      }
      console.log(`  matches_applied:     ${summary.ai.ai_matches_applied}  (confidence ≥ 80%, silent)`);
      console.log(`  matches_flagged:     ${summary.ai.ai_matches_flagged}  (confidence 50–79%, "verify" tag)`);
      console.log(`  suspicions_recorded: ${summary.ai.ai_suspicions_recorded}  (< 50%, awaiting confirm/dismiss)`);
      if (Array.isArray(summary.ai.chunks) && summary.ai.chunks.length > 0) {
        console.log(`  chunks: ${summary.ai.chunks.length}`);
        const counts = { ok: 0, timeout: 0, parse_error: 0, api_error: 0 };
        for (const c of summary.ai.chunks) counts[c.status] = (counts[c.status] || 0) + 1;
        console.log(
          `    ok=${counts.ok}  timeout=${counts.timeout}  parse_error=${counts.parse_error}  api_error=${counts.api_error}`
        );
        for (const c of summary.ai.chunks) {
          const tag = c.status === "ok" ? "✓" : "✗";
          console.log(
            `    ${tag} ${c.status.padEnd(11)}  bills=${c.bills} candidates=${c.candidates}  matches=${c.matches ?? "-"} suspicions=${c.suspicions ?? "-"}  ${c.error ? "err: " + c.error.slice(0, 60) : ""}`
          );
        }
      }
    }
  } else if (summary.ai_job) {
    console.log("");
    console.log("AI background job:");
    if (summary.ai_job.error) {
      console.log(`  error: ${summary.ai_job.error}`);
    } else if (summary.ai_job.status === "skipped") {
      console.log(`  status: skipped  (${summary.ai_job.skipped})`);
    } else {
      console.log(`  job_id:        ${summary.ai_job.job_id}`);
      console.log(`  total_chunks:  ${summary.ai_job.total_chunks}`);
      console.log(`  status:        ${summary.ai_job.status}`);
      // Pull live job state.
      const { data: job } = await supabase
        .from("reconciliation_jobs")
        .select(
          "status, completed_chunks, total_chunks, ai_matches_applied, ai_matches_flagged, ai_suspicions_recorded, error"
        )
        .eq("id", summary.ai_job.job_id)
        .maybeSingle();
      if (job) {
        console.log(`  live state:`);
        console.log(`    status:              ${job.status}`);
        console.log(`    completed_chunks:    ${job.completed_chunks} / ${job.total_chunks}`);
        console.log(`    ai_matches_applied:  ${job.ai_matches_applied}  (>=80%)`);
        console.log(`    ai_matches_flagged:  ${job.ai_matches_flagged}  (50-79%)`);
        console.log(`    ai_suspicions_recorded: ${job.ai_suspicions_recorded}  (<50%)`);
        if (job.error) console.log(`    error: ${job.error}`);
      }
    }
  } else {
    console.log("");
    console.log("AI pass: (no record — either pre-AI-pass code, or skipped without writing)");
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
      "id, file_name, file_size_bytes, content_hash, dropbox_path, sender, document_type, document_date, purchase_category, primary_profile_id, status, needs_action, action_type, action_summary, due_date, ai_input_tokens, ai_output_tokens, ai_stop_reason, ai_truncated, created_at"
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
  console.log(`profile_id:      ${data.primary_profile_id ?? "—"}`);
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

// Pull a pseudo-IBAN out of an extracted_fields blob (same heuristic the
// matcher uses, kept inline so this script has no app-internal imports).
function extractIban(ef) {
  if (!ef || typeof ef !== "object") return null;
  const direct = ef.payment_iban || ef.iban || ef.account_iban;
  if (typeof direct === "string") {
    const c = direct.replace(/\s+/g, "");
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i.test(c)) return c.toUpperCase();
  }
  const re = /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/i;
  for (const v of Object.values(ef)) {
    if (typeof v === "string") {
      const m = v.replace(/\s+/g, "").match(re);
      if (m) return m[0].toUpperCase();
    }
  }
  return null;
}
// Kept matching the app's lib/services/bank-reconciliation.ts. If you
// add a key there, add it here too.
const REF_KEYS = [
  "payment_reference",
  "invoice_number",
  "factuurnummer",
  "factuur_number",
  "reference",
  "customer_reference",
  "customer_number",
  "klantnummer",
  "mandate_reference",
  "betalingskenmerk",
  "mededeling",
  "payment_id",
  "kenmerk",
  "dossier_number",
  "ovi_number",
  "transaction_reference",
];
function extractRefs(ef) {
  if (!ef || typeof ef !== "object") return [];
  const found = [];
  for (const k of REF_KEYS) {
    const v = ef[k];
    if (v == null) continue;
    const s = typeof v === "number" ? String(v) : String(v).trim();
    if (s.length >= 4) found.push(s);
  }
  // Catch-all: any 6+ digit run in any string field.
  for (const v of Object.values(ef)) {
    if (typeof v !== "string") continue;
    const matches = v.match(/\b\d{6,}\b/g);
    if (matches) found.push(...matches);
  }
  const seen = new Set();
  return found.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}
function extractRef(ef) {
  return extractRefs(ef)[0] || null;
}
function nameNorm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function cmdPayActions() {
  const limit = Number(flag("limit", "50"));
  const supabase = admin();
  const { data, error } = await supabase
    .from("actions")
    .select(
      "id, document_id, status, action_type, summary, due_date, document:documents(id, sender, amount, currency, extracted_fields)"
    )
    .eq("status", "open")
    .eq("action_type", "pay")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  const rows = data || [];
  console.log(`Open pay-actions: ${rows.length}\n`);
  if (rows.length === 0) {
    console.log(
      "(0 open pay-actions — that's why nothing matched. Either everything's already done or no pay actions exist.)"
    );
    return;
  }
  let withAmount = 0,
    withIban = 0,
    withRef = 0;
  for (const a of rows) {
    const d = a.document;
    const amt = d?.amount;
    const iban = extractIban(d?.extracted_fields);
    const ref = extractRef(d?.extracted_fields);
    if (amt != null) withAmount++;
    if (iban) withIban++;
    if (ref) withRef++;
    const amtStr = amt != null ? Number(amt).toFixed(2).padStart(10) : "       —";
    const sender = (d?.sender || "—").slice(0, 28).padEnd(28);
    const due = (a.due_date || "—").padEnd(10);
    console.log(
      `  ${due}  ${amtStr}  ${sender}  ${iban || "(no IBAN)"}  ${ref ? `ref:${ref.slice(0, 16)}` : ""}`
    );
  }
  console.log(
    `\nSignal coverage:  amount=${withAmount}/${rows.length}  IBAN=${withIban}/${rows.length}  reference=${withRef}/${rows.length}`
  );
}

async function cmdMatchDebug() {
  const [idArg] = positional();
  if (!idArg)
    throw new Error("Usage: diag match-debug <tx-id-or-prefix>");
  const supabase = admin();
  const txId = await resolveId(supabase, "bank_transactions", idArg);
  if (!txId) {
    console.error(`No bank_transactions row matching "${idArg}"`);
    process.exit(1);
  }
  const { data: tx, error: txErr } = await supabase
    .from("bank_transactions")
    .select(
      "id, statement_id, amount, booking_date, counterparty_name, counterparty_iban, description, reference, matched_action_id, match_reason"
    )
    .eq("id", txId)
    .single();
  if (txErr) throw txErr;
  console.log(`tx ${txId}`);
  console.log(`  amount:      ${tx.amount}`);
  console.log(`  date:        ${tx.booking_date}`);
  console.log(`  counterparty:${tx.counterparty_name || "—"}`);
  console.log(`  IBAN:        ${tx.counterparty_iban || "—"}`);
  console.log(`  reference:   ${tx.reference || "—"}`);
  console.log(
    `  matched:     ${tx.matched_action_id || "no"}  ${tx.match_reason ? `(${tx.match_reason})` : ""}`
  );

  const { data: pending, error: aErr } = await supabase
    .from("actions")
    .select(
      "id, document_id, status, action_type, document:documents(id, sender, amount, extracted_fields)"
    )
    .eq("status", "open")
    .eq("action_type", "pay");
  if (aErr) throw aErr;

  const txAbs = Math.abs(Number(tx.amount));
  const tolerance = Math.max(0.5, txAbs * 0.005);
  const txIbanN = (tx.counterparty_iban || "").toUpperCase().replace(/\s+/g, "");
  const counterN = nameNorm(tx.counterparty_name || tx.description);
  const txRefN = (tx.reference || "").replace(/\s+/g, "").toLowerCase();

  console.log(`\nCandidates (any single signal overlap):`);
  let any = false;
  for (const a of pending || []) {
    const d = a.document;
    const docAbs = d?.amount != null ? Math.abs(Number(d.amount)) : null;
    const amountHit =
      docAbs != null && Number.isFinite(docAbs) && Math.abs(txAbs - docAbs) <= tolerance;
    const ibanDoc = extractIban(d?.extracted_fields);
    const ibanHit = ibanDoc && txIbanN && ibanDoc === txIbanN;
    const senderN = nameNorm(d?.sender);
    const senderHit =
      senderN && counterN && (counterN.includes(senderN) || senderN.includes(counterN));
    const refDoc = extractRef(d?.extracted_fields);
    const refDocN = refDoc ? String(refDoc).replace(/\s+/g, "").toLowerCase() : "";
    const refHit =
      refDocN && refDocN.length >= 4 && txRefN.includes(refDocN);

    if (!amountHit && !ibanHit && !senderHit && !refHit) continue;
    any = true;
    const sig = [
      amountHit ? `amount(${docAbs})` : null,
      ibanHit ? `IBAN` : null,
      senderHit ? `sender(${d?.sender})` : null,
      refHit ? `ref(${refDoc})` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    console.log(
      `  • action ${a.id.slice(0, 8)}  doc=${a.document_id.slice(0, 8)}  ${sig}`
    );
  }
  if (!any)
    console.log(
      "  (none — no open pay-action overlaps on amount, IBAN, sender, or reference)"
    );
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
  npm run diag <subcommand> [args...]
  npm run diag <subcommand> <args> -- --flag    (npm eats --flags without --)

Subcommands:
  bank-stats     <statement-id-or-prefix>
  last-reconcile <statement-id-or-prefix>
  transactions   <statement-id-or-prefix> [--limit=N] [--filter=debits|credits|unmatched]
  doc            <doc-id-or-prefix>
  reconcile-summary <statement-id-or-prefix>
  reconcile-log  <statement-id-or-prefix>
  bills-paid     <statement-id-or-prefix>
  unmatched-bills <statement-id-or-prefix>
  repair-matches <statement-id-or-prefix> [--dry-run]
  retry-failed   [--limit=N]
  bulk-reassign  --to=<profile> [--sender=...] [--type=...] [--since=YYYY-MM-DD] [--from=<profile>] [--limit=N] [--dry-run]
  taxonomy-backfill [--dry-run]
  taxonomy-cleanup  [--apply]
  cleanup-multi-doc-dupes [--dry-run]
  detect-multidoc <doc-id-or-prefix>
  pay-actions    [--limit=50]
  match-debug    <tx-id-or-prefix>
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
  "reconcile-summary": cmdReconcileSummary,
  "reconcile-log": cmdReconcileLog,
  "bills-paid": cmdBillsPaid,
  "unmatched-bills": cmdUnmatchedBills,
  "repair-matches": cmdRepairMatches,
  "retry-failed": cmdRetryFailed,
  "bulk-reassign": cmdBulkReassign,
  "taxonomy-backfill": cmdTaxonomyBackfill,
  "taxonomy-cleanup": cmdTaxonomyCleanup,
  "cleanup-multi-doc-dupes": cmdCleanupMultiDocDupes,
  "detect-multidoc": cmdDetectMultidoc,
  "pay-actions": cmdPayActions,
  "match-debug": cmdMatchDebug,
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
