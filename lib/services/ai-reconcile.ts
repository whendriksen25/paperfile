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
  /** Returned for logging / debug. */
  raw?: AiResult;
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
 * Pre-filter unmatched debits to plausible candidates for each bill,
 * then build the union so the AI sees a manageable set. This is what
 * keeps the prompt cheap regardless of statement size.
 */
function filterCandidateDebits(
  bills: UnmatchedBill[],
  allDebits: UnmatchedDebit[]
): UnmatchedDebit[] {
  const keep = new Set<string>();
  for (const bill of bills) {
    if (bill.amount == null) continue;
    const billAbs = Math.abs(bill.amount);
    // Amount window: ±30% or ±€10 — catches late fees, partial pay,
    // and amount ranges that suggest "combined payment that includes
    // this bill". Tighter than that risks missing real adjustments.
    const lo = billAbs * 0.7 - 10;
    const hi = billAbs * 1.3 + 10;
    // Date window: ±90 days from the bill's reference date.
    const ref = bill.document_date || bill.due_date;
    for (const tx of allDebits) {
      const txAbs = Math.abs(tx.amount);
      if (txAbs < lo || txAbs > hi) continue;
      if (ref && tx.booking_date) {
        const dDays =
          Math.abs(
            new Date(ref).getTime() - new Date(tx.booking_date).getTime()
          ) / 86400000;
        if (dDays > 90) continue;
      }
      keep.add(tx.id);
    }
    // Also keep debits to the same IBAN regardless of amount — covers
    // refund pairs and vendor-relationship matches.
    if (bill.iban) {
      for (const tx of allDebits) {
        if (
          (tx.counterparty_iban || "").toUpperCase().replace(/\s+/g, "") ===
          bill.iban
        ) {
          keep.add(tx.id);
        }
      }
    }
  }
  return allDebits.filter((t) => keep.has(t.id));
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

  // 3. Pre-filter candidates so the prompt stays cheap.
  const candidateDebits = filterCandidateDebits(bills, allDebits);
  if (candidateDebits.length === 0) {
    out.ai_call_skipped = true;
    out.skip_reason = "no plausible candidate debits after pre-filter";
    return out;
  }

  // 4. Call Claude.
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const userMsg = JSON.stringify(
    { BILLS: bills, DEBITS: candidateDebits },
    null,
    2
  );

  let resp;
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 16384,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
  } catch (e) {
    out.ai_call_skipped = true;
    out.skip_reason = `AI call failed: ${e instanceof Error ? e.message : String(e)}`;
    return out;
  }

  const text =
    resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n") || "";
  const parsed = tryParseJson(text);
  if (!parsed) {
    out.ai_call_skipped = true;
    out.skip_reason = "AI response was not parseable JSON";
    return out;
  }
  out.raw = parsed;

  // 5. Apply matches & record suspicions.
  const billsById = new Map(bills.map((b) => [b.id, b]));
  const debitsById = new Map(candidateDebits.map((t) => [t.id, t]));
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
