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
  console.log(`considered:   ${summary.considered}`);
  console.log(`matched:      ${summary.matched}`);
  console.log(`ambiguous:    ${summary.ambiguous}`);
  console.log(`unmatched:    ${summary.unmatched}`);
  if (summary.back_link_write_failures !== undefined) {
    console.log(
      `back_link_write_failures: ${summary.back_link_write_failures}  ${summary.back_link_write_failures > 0 ? "⚠  matches written in memory but NOT persisted to bank_transactions" : ""}`
    );
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
function extractRef(ef) {
  if (!ef || typeof ef !== "object") return null;
  for (const k of [
    "payment_reference",
    "invoice_number",
    "reference",
    "customer_reference",
  ]) {
    const v = ef[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
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
  repair-matches <statement-id-or-prefix> [--dry-run]
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
  "repair-matches": cmdRepairMatches,
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
