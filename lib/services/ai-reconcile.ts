import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI-driven second pass for bank reconciliation. Runs AFTER the
 * deterministic matcher (lib/services/bank-reconciliation.ts) on whatever
 * pay-actions remained open. Handles the messy cases the deterministic
 * matcher correctly refuses to guess at:
 *   - amount adjustments (late fees, FX surcharges, partial pay)
 *   - combined payments (one debit settles multiple invoices)
 *   - split payments (multiple debits sum to one invoice)
 *   - refund / reversal pairs
 *   - date shifts beyond the 35-day window
 *
 * Plus: notes "suspicions" — low-confidence observations the user should
 * eyeball even if they're below the auto-apply threshold. Example:
 * a €200 cash withdrawal on the day a €200 invoice was due.
 *
 * Cost model: one Claude call per reconcile session. Filter candidates
 * client-side first (amount range + sender or IBAN overlap) to keep the
 * prompt small. Per-session cost: ~$0.05–0.20 depending on candidate
 * count. Skip entirely when there's nothing to match.
 */

const MODEL = "claude-sonnet-4-20250514";

const CONFIDENCE_AUTO_APPLY = 0.8;
const CONFIDENCE_REVIEW = 0.5;

/** Number of bills sent per Claude call. Small enough to fit a 5-10s
 * response budget; large enough to still let the model reason about
 * cross-bill patterns (combined payments, vendor-relationship matches).
 * On a typical 50-bill statement, this produces ~6 chunks × ~8s = ~50s
 * total — within Vercel's 60s function limit. */
const BILL_CHUNK_SIZE = 8;
const PER_CHUNK_TIMEOUT_MS = 25_000;

interface UnmatchedBill {
  id: string; // action_id
  document_id: string;
  sender: string | null;
  amount: number | null;
  document_date: string | null;
  due_date: string | null;
  reference: string | null;
  iban: string | null;
}

interface UnmatchedDebit {
  id: string; // bank_transactions.id
  amount: number;
  booking_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  description: string | null;
}

interface AiMatch {
  bill_id: string;
  debit_ids: string[];
  confidence: number;
  reasoning: string;
}

interface AiSuspicion {
  debit_id: string;
  possible_bill_ids: string[];
  reasoning: string;
  confidence: number;
}

interface AiResult {
  matches: AiMatch[];
  suspicions: AiSuspicion[];
}

export interface AiReconcileResult {
  considered_bills: number;
  considered_debits: number;
  ai_matches_applied: number;
  ai_matches_flagged: number;
  ai_suspicions_recorded: number;
  ai_call_skipped: boolean;
  skip_reason?: string;
  /** One entry per chunk attempted: ok | timeout | parse_error | api_error,
   * plus how many bills/candidates were in the prompt. Helps diagnose
   * partial failures (some chunks succeeded, others timed out). */
  chunks?: Array<{
    bills: number;
    candidates: number;
    status: "ok" | "timeout" | "parse_error" | "api_error";
    matches?: number;
    suspicions?: number;
    error?: string;
  }>;
}

const SYSTEM_PROMPT = `You are an autonomous bank reconciliation assistant for a personal finance app.

You receive two lists:
  - BILLS: invoices/bills the user owes (still open after a deterministic matcher ran)
  - DEBITS: bank transactions (negative amounts) that have NOT been matched yet

Your job is to pair them up the way an experienced bookkeeper would. Account for:
  - amount adjustments (late fees, refunds, currency conversion, partial pay)
  - combined payments (one debit settles multiple invoices)
  - split payments (multiple debits sum to one invoice)
  - refund/reversal pairs (a debit immediately reversed by a credit)
  - date shifts (a Feb bill paid in early March is still a Feb bill)
  - vendor name variations (same vendor, different counterparty string)

Be HONEST about confidence. The system applies your matches automatically:
  - confidence >= 0.80 → silently applied
  - confidence 0.50–0.79 → applied but flagged for the user to verify
  - confidence < 0.50 → record as a suspicion only, no match applied

Suspicions: observations the user should eyeball. Examples:
  - cash withdrawal of the same amount as an invoice, same day
  - bank transfer to a counterparty with no reference but a plausible amount
  - unusual pattern (sudden large amount, vendor we haven't seen before)

Output STRICT JSON, no prose, no markdown fences:
{
  "matches": [
    {
      "bill_id": "<uuid>",
      "debit_ids": ["<uuid>", ...],
      "confidence": 0.0-1.0,
      "reasoning": "short explanation, mention specifics like '€5 late fee added'"
    }
  ],
  "suspicions": [
    {
      "debit_id": "<uuid>",
      "possible_bill_ids": ["<uuid>", ...],
      "reasoning": "what's suspicious + why the user should check",
      "confidence": 0.0-1.0
    }
  ]
}

A single bill can only appear in matches OR suspicions, not both. Same for a debit.
If nothing plausible, return {"matches": [], "suspicions": []}.`;

function tryParseJson(s: string): AiResult | null {
  if (!s) return null;
  // Strip code fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : s).trim();
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== "object" || !parsed) return null;
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const suspicions = Array.isArray(parsed.suspicions) ? parsed.suspicions : [];
    return { matches, suspicions };
  } catch {
    return null;
  }
}

function extractIban(
  ef: Record<string, unknown> | null | undefined
): string | null {
  if (!ef) return null;
  const direct =
    (ef["payment_iban"] as string | undefined) ||
    (ef["iban"] as string | undefined) ||
    (ef["account_iban"] as string | undefined);
  if (typeof direct === "string") {
    const c = direct.replace(/\s+/g, "");
    if (/^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i.test(c)) return c.toUpperCase();
  }
  return null;
}

function extractRef(
  ef: Record<string, unknown> | null | undefined
): string | null {
  if (!ef) return null;
  for (const k of [
    "payment_reference",
    "invoice_number",
    "factuurnummer",
    "reference",
  ]) {
    const v = ef[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Pre-filter unmatched debits to plausible candidates for a small set
 * of bills (one chunk). With chunking we keep the per-call prompt small,
 * so we can afford a generous per-bill candidate cap.
 */
const PER_BILL_CAP = 20;

function filterCandidateDebits(
  bills: UnmatchedBill[],
  allDebits: UnmatchedDebit[],
  excludeDebitIds?: Set<string>
): UnmatchedDebit[] {
  const keep = new Set<string>();
  for (const bill of bills) {
    if (bill.amount == null) continue;
    const billAbs = Math.abs(bill.amount);
    // Amount window: ±20% or ±€5 — tight enough to keep prompts cheap,
    // wide enough to catch late fees and minor adjustments.
    const lo = billAbs * 0.8 - 5;
    const hi = billAbs * 1.2 + 5;
    // Date window: ±60 days from the bill's reference date.
    const ref = bill.document_date || bill.due_date;
    type Scored = { id: string; score: number };
    const scored: Scored[] = [];
    for (const tx of allDebits) {
      if (excludeDebitIds && excludeDebitIds.has(tx.id)) continue;
      const txAbs = Math.abs(tx.amount);
      if (txAbs < lo || txAbs > hi) continue;
      let score = 1;
      if (ref && tx.booking_date) {
        const dDays =
          Math.abs(
            new Date(ref).getTime() - new Date(tx.booking_date).getTime()
          ) / 86400000;
        if (dDays > 60) continue;
        score = 1 - dDays / 60; // closer date = higher score
      }
      // Same-IBAN bumps score
      if (
        bill.iban &&
        (tx.counterparty_iban || "").toUpperCase().replace(/\s+/g, "") ===
          bill.iban
      ) {
        score += 1;
      }
      scored.push({ id: tx.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, PER_BILL_CAP)) keep.add(s.id);
  }
  return allDebits.filter((t) => keep.has(t.id));
}

/** Call Claude on one bill chunk. Returns parsed AiResult or null. */
async function callChunkAi(
  client: Anthropic,
  chunkBills: UnmatchedBill[],
  candidateDebits: UnmatchedDebit[]
): Promise<{ result: AiResult | null; error?: string; timedOut?: boolean }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_CHUNK_TIMEOUT_MS);
  try {
    const userMsg = JSON.stringify(
      { BILLS: chunkBills, DEBITS: candidateDebits },
      null,
      2
    );
    const resp = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      },
      { signal: controller.signal }
    );
    const text =
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n") || "";
    const parsed = tryParseJson(text);
    if (!parsed) return { result: null, error: "parse_error" };
    return { result: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort/i.test(msg);
    return { result: null, error: msg, timedOut };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function aiReconcileLeftovers(
  admin: SupabaseClient,
  userId: string,
  statementDocId: string
): Promise<AiReconcileResult> {
  const out: AiReconcileResult = {
    considered_bills: 0,
    considered_debits: 0,
    ai_matches_applied: 0,
    ai_matches_flagged: 0,
    ai_suspicions_recorded: 0,
    ai_call_skipped: false,
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    out.ai_call_skipped = true;
    out.skip_reason = "ANTHROPIC_API_KEY missing";
    return out;
  }

  // 1. Load remaining open pay-actions.
  const { data: actionsRaw, error: aErr } = await admin
    .from("actions")
    .select(
      "id, document_id, due_date, document:documents(id, sender, amount, document_date, extracted_fields)"
    )
    .eq("user_id", userId)
    .eq("status", "open")
    .eq("action_type", "pay")
    .neq("document_id", statementDocId);
  if (aErr) throw aErr;
  const bills: UnmatchedBill[] = (actionsRaw || [])
    .map((a) => {
      const d = (a as { document?: { id?: string; sender?: string; amount?: number; document_date?: string; extracted_fields?: Record<string, unknown> } }).document;
      return {
        id: (a as { id: string }).id,
        document_id: (a as { document_id: string }).document_id,
        sender: d?.sender || null,
        amount: d?.amount ?? null,
        document_date: d?.document_date || null,
        due_date: (a as { due_date: string | null }).due_date,
        reference: extractRef(d?.extracted_fields),
        iban: extractIban(d?.extracted_fields),
      };
    })
    .filter((b) => b.amount != null);

  // 2. Load unmatched debits from this statement.
  const PAGE = 1000;
  const allDebits: UnmatchedDebit[] = [];
  let offset = 0;
  for (let i = 0; i < 50; i++) {
    const { data: pageData, error: dErr } = await admin
      .from("bank_transactions")
      .select(
        "id, amount, booking_date, counterparty_name, counterparty_iban, reference, description"
      )
      .eq("statement_id", statementDocId)
      .lt("amount", 0)
      .is("matched_action_id", null)
      .order("position", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (dErr) throw dErr;
    const rows = (pageData || []) as UnmatchedDebit[];
    allDebits.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  out.considered_bills = bills.length;
  out.considered_debits = allDebits.length;

  if (bills.length === 0) {
    out.ai_call_skipped = true;
    out.skip_reason = "no open bills";
    return out;
  }
  if (allDebits.length === 0) {
    out.ai_call_skipped = true;
    out.skip_reason = "no unmatched debits";
    return out;
  }

  // 3. Chunk the bills into small batches and call Claude per batch.
  // Sequential, so later chunks can see which debits earlier chunks
  // already claimed (we exclude them from candidate filtering).
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const usedDebitIds = new Set<string>();
  const usedBillIds = new Set<string>();
  const aggregatedMatches: AiMatch[] = [];
  const aggregatedSuspicions: AiSuspicion[] = [];
  out.chunks = [];

  for (let i = 0; i < bills.length; i += BILL_CHUNK_SIZE) {
    const chunkBills = bills.slice(i, i + BILL_CHUNK_SIZE).filter((b) => !usedBillIds.has(b.id));
    if (chunkBills.length === 0) continue;
    const chunkCandidates = filterCandidateDebits(
      chunkBills,
      allDebits,
      usedDebitIds
    );
    if (chunkCandidates.length === 0) {
      out.chunks.push({
        bills: chunkBills.length,
        candidates: 0,
        status: "ok",
        matches: 0,
        suspicions: 0,
      });
      continue;
    }

    const { result, error, timedOut } = await callChunkAi(
      client,
      chunkBills,
      chunkCandidates
    );
    if (!result) {
      out.chunks.push({
        bills: chunkBills.length,
        candidates: chunkCandidates.length,
        status: timedOut ? "timeout" : error === "parse_error" ? "parse_error" : "api_error",
        error: error || undefined,
      });
      continue;
    }

    // Aggregate results from this chunk.
    let m = 0,
      s = 0;
    for (const match of result.matches) {
      if (usedBillIds.has(match.bill_id)) continue;
      aggregatedMatches.push(match);
      usedBillIds.add(match.bill_id);
      for (const did of match.debit_ids) usedDebitIds.add(did);
      m++;
    }
    for (const susp of result.suspicions) {
      if (usedDebitIds.has(susp.debit_id)) continue; // skip if already matched
      aggregatedSuspicions.push(susp);
      s++;
    }
    out.chunks.push({
      bills: chunkBills.length,
      candidates: chunkCandidates.length,
      status: "ok",
      matches: m,
      suspicions: s,
    });
  }

  // If every chunk failed and no useful output, mark skipped overall.
  if (
    aggregatedMatches.length === 0 &&
    aggregatedSuspicions.length === 0 &&
    out.chunks.every((c) => c.status !== "ok")
  ) {
    out.ai_call_skipped = true;
    out.skip_reason = "all chunks failed (timeout/api/parse)";
    return out;
  }

  // 4. Apply matches & record suspicions.
  const parsed: AiResult = {
    matches: aggregatedMatches,
    suspicions: aggregatedSuspicions,
  };
  const billsById = new Map(bills.map((b) => [b.id, b]));
  const debitsById = new Map(allDebits.map((t) => [t.id, t]));
  const now = new Date().toISOString();

  // Track per-debit suspicions so the same debit doesn't get multiple
  // suspicion writes — we merge them.
  const suspicionByDebit = new Map<string, AiSuspicion[]>();

  for (const m of parsed.matches) {
    const bill = billsById.get(m.bill_id);
    if (!bill) continue;
    const debits = (m.debit_ids || [])
      .map((id) => debitsById.get(id))
      .filter((x): x is UnmatchedDebit => !!x);
    if (debits.length === 0) continue;
    const conf = Math.max(0, Math.min(1, Number(m.confidence) || 0));
    if (conf < CONFIDENCE_REVIEW) {
      // Treat as suspicion, not a match.
      for (const d of debits) {
        const arr = suspicionByDebit.get(d.id) || [];
        arr.push({
          debit_id: d.id,
          possible_bill_ids: [m.bill_id],
          reasoning: m.reasoning || "",
          confidence: conf,
        });
        suspicionByDebit.set(d.id, arr);
      }
      continue;
    }

    const method = conf >= CONFIDENCE_AUTO_APPLY ? "ai_high" : "ai_review";
    // Close the action.
    await admin
      .from("actions")
      .update({
        status: "done",
        completed_at: now,
        notes: `AI-matched (${conf.toFixed(2)}): ${m.reasoning}`,
      })
      .eq("id", bill.id);
    // Mark source doc paid.
    const { data: srcDoc } = await admin
      .from("documents")
      .select("extracted_fields")
      .eq("id", bill.document_id)
      .single();
    const sourceEf = (srcDoc?.extracted_fields || {}) as Record<
      string,
      unknown
    >;
    const paidDate = debits[0].booking_date || null;
    await admin
      .from("documents")
      .update({
        extracted_fields: {
          ...sourceEf,
          payment_status: "paid",
          paid_date: paidDate,
          paid_note: `AI-matched: ${m.reasoning}`,
        },
      })
      .eq("id", bill.document_id);
    // Stamp each debit involved.
    for (const d of debits) {
      const reason = `AI (${conf.toFixed(2)}): ${m.reasoning}`;
      await admin
        .from("bank_transactions")
        .update({
          matched_action_id: bill.id,
          matched_document_id: bill.document_id,
          matched_at: now,
          match_reason: reason,
          match_status: "matched",
          match_method: method,
          match_confidence: conf,
        })
        .eq("id", d.id);
      await admin.from("maintenance_log").insert({
        user_id: userId,
        document_id: bill.document_id,
        kind: "bank_reconcile",
        reason: `AI auto-matched (${method}, conf=${conf.toFixed(2)}): ${m.reasoning}`,
        payload: {
          statement_doc_id: statementDocId,
          bank_transaction_id: d.id,
          action_id: bill.id,
          method,
          confidence: conf,
          amount: d.amount,
          counterparty: d.counterparty_name,
          booking_date: d.booking_date,
        },
      });
    }
    if (conf >= CONFIDENCE_AUTO_APPLY) out.ai_matches_applied++;
    else out.ai_matches_flagged++;
  }

  // Suspicions: merge any AI-emitted suspicions with the
  // below-threshold-match suspicions we just collected.
  for (const s of parsed.suspicions) {
    if (!debitsById.has(s.debit_id)) continue;
    const arr = suspicionByDebit.get(s.debit_id) || [];
    arr.push({
      debit_id: s.debit_id,
      possible_bill_ids: s.possible_bill_ids || [],
      reasoning: s.reasoning || "",
      confidence: Math.max(0, Math.min(1, Number(s.confidence) || 0)),
    });
    suspicionByDebit.set(s.debit_id, arr);
  }

  // Look up possible_doc_id (documents.id) for each possible_bill_id (action.id)
  // — UI shows doc, not action.
  const actionIdsNeeded = new Set<string>();
  for (const arr of Array.from(suspicionByDebit.values())) {
    for (const s of arr) {
      for (const bid of s.possible_bill_ids) actionIdsNeeded.add(bid);
    }
  }
  const docByAction = new Map<string, string>();
  if (actionIdsNeeded.size > 0) {
    const { data: actDocs } = await admin
      .from("actions")
      .select("id, document_id")
      .in("id", Array.from(actionIdsNeeded));
    for (const r of actDocs || []) {
      docByAction.set(
        (r as { id: string }).id,
        (r as { document_id: string }).document_id
      );
    }
  }

  for (const [debitId, susps] of Array.from(suspicionByDebit.entries())) {
    const enriched = susps.map((s) => ({
      possible_action_ids: s.possible_bill_ids,
      possible_doc_ids: s.possible_bill_ids
        .map((bid) => docByAction.get(bid))
        .filter((x): x is string => !!x),
      reasoning: s.reasoning,
      confidence: s.confidence,
    }));
    await admin
      .from("bank_transactions")
      .update({ suspicions: enriched })
      .eq("id", debitId);
    out.ai_suspicions_recorded++;
  }

  console.log("[ai-reconcile] done", JSON.stringify(out));
  return out;
}
