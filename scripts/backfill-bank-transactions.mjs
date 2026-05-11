// Backfill the bank_transactions table from existing bank_statement docs
// whose line_items still live only in extracted_fields JSON.
//
// Usage:
//   node --env-file=.env.local scripts/backfill-bank-transactions.mjs --dry-run
//   node --env-file=.env.local scripts/backfill-bank-transactions.mjs
//
// Idempotent: for each statement, deletes existing bank_transactions rows
// for that statement_id first, then re-inserts from the JSON. So running
// twice produces the same result.

import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

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

async function main() {
  const s = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: statements, error } = await s
    .from("documents")
    .select("id, user_id, extracted_fields, currency")
    .eq("document_type", "bank_statement");
  if (error) throw error;

  console.log(`[backfill] found ${statements.length} bank_statement docs`);

  let totalInserted = 0;
  for (const stmt of statements) {
    const ef = (stmt.extracted_fields || {});
    const items = Array.isArray(ef.line_items) ? ef.line_items : [];
    if (items.length === 0) {
      console.log(`  - ${stmt.id} (skipped: no line_items)`);
      continue;
    }

    const rows = items
      .map((it, i) => {
        let amt = typeof it.total === "number" ? it.total : Number(it.total);
        if (!Number.isFinite(amt)) return null;
        if (it.cdt_dbt === "DBIT" && amt > 0) amt = -amt;
        if (it.cdt_dbt === "CRDT" && amt < 0) amt = -amt;
        return {
          user_id: stmt.user_id,
          statement_id: stmt.id,
          position: i,
          amount: amt,
          currency: it.currency || stmt.currency || "EUR",
          booking_date: it.booking_date || it.transaction_date || null,
          value_date: it.value_date || it.transaction_date || null,
          counterparty_name:
            it.counterparty_name || it.description || null,
          counterparty_iban: it.counterparty_iban || null,
          description: it.description || null,
          reference: it.reference || null,
          transaction_id: it.transaction_id || null,
        };
      })
      .filter(Boolean);

    if (dryRun) {
      console.log(`  ▸ ${stmt.id}: would insert ${rows.length} transactions`);
      totalInserted += rows.length;
      continue;
    }

    const { error: delErr } = await s
      .from("bank_transactions")
      .delete()
      .eq("statement_id", stmt.id);
    if (delErr) {
      console.log(`  ✗ ${stmt.id}: delete failed — ${delErr.message}`);
      continue;
    }

    const { error: insErr } = await s.from("bank_transactions").insert(rows);
    if (insErr) {
      console.log(`  ✗ ${stmt.id}: insert failed — ${insErr.message}`);
      continue;
    }

    console.log(`  ✓ ${stmt.id}: inserted ${rows.length} transactions`);
    totalInserted += rows.length;
  }

  console.log(
    `\n[backfill] ${dryRun ? "would-insert" : "inserted"} ${totalInserted} transactions total`
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
