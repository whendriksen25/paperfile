import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { extractDocument } from "@/lib/ai/extract";
import { suggestProfile } from "@/lib/ai/suggest-profile";
import {
  listProfilesForUser,
  matchProfileByHint,
  deterministicProfileMatch,
} from "@/lib/services/profiles";
import {
  getSenderHistory,
  shouldApplyHistoryOverride,
  countPriorDocsFromSender,
} from "@/lib/services/sender-history";
import { looksLikeCamt053, parseCamt053 } from "@/lib/utils/camt-parser";
import {
  looksLikeRabobankCsv,
  parseRabobankCsv,
} from "@/lib/utils/rabobank-csv-parser";
import { reconcileBankStatement } from "@/lib/services/bank-reconciliation";
import { replaceStatementTransactions } from "@/lib/services/bank-transactions";
import type { DocumentExtraction } from "@/types/document";

const PROFILE_AUTO_ASSIGN_THRESHOLD = 0.7;

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ?force_profile=1 — when re-analysing, ignore any pre-set primary_profile_id
  // and let Claude re-evaluate from scratch. Used by the "Re-analyse with AI"
  // button so a wrongly-pinned profile doesn't get respected forever.
  const forceProfile =
    request.nextUrl.searchParams.get("force_profile") === "1";
  console.log("[api/analyze] start", id, forceProfile ? "(force_profile)" : "");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = await createServiceClient();
    const { data: doc, error } = await admin
      .from("documents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await admin
      .from("documents")
      .update({ status: "processing" })
      .eq("id", id);

    // 1. Download original from its storage backend
    const storage = getStorage(doc.storage_provider);
    const buffer = await storage.downloadFile(doc.dropbox_path);

    // 1.5. CAMT.053 fast path — when the file is a CAMT.053 XML bank
    // statement (every NL bank exports this under "Periodieke afschriften"),
    // we parse it deterministically without sending to Claude. Faster,
    // cheaper, and far more accurate than OCR-from-PDF.
    let result: DocumentExtraction | { error: string; raw_text: string; stop_reason: string | null } | null = null;
    // AI usage gets recorded so the user can see what each doc cost.
    // Set to zeros for the deterministic parser branches.
    let aiUsage = { input_tokens: 0, output_tokens: 0 };
    let aiStopReason: string | null = "end_turn";
    let aiMaxCap = 0;
    if (looksLikeCamt053(buffer)) {
      try {
        const xmlText = buffer.toString("utf8");
        const stmt = parseCamt053(xmlText);
        const debits = stmt.transactions.filter((t) => t.amount < 0);
        const credits = stmt.transactions.filter((t) => t.amount > 0);
        const totalDebit = debits.reduce((s, t) => s + Math.abs(t.amount), 0);
        const totalCredit = credits.reduce((s, t) => s + t.amount, 0);
        const synthetic: DocumentExtraction = {
          document_type: "bank_statement",
          document_subtype: null,
          confidence: 1,
          document_date: stmt.period_end,
          sender: null,
          recipient: stmt.account_holder,
          language: "nl",
          profile_hint: stmt.account_holder,
          amount: stmt.closing_balance,
          currency: stmt.currency || "EUR",
          purchase_category: null,
          title: `Bank statement ${stmt.period_start || ""} – ${stmt.period_end || ""}`.trim(),
          summary: `${stmt.transactions.length} transactions (${debits.length} debits totalling €${totalDebit.toFixed(2)}, ${credits.length} credits totalling €${totalCredit.toFixed(2)}). Closing balance: ${(stmt.closing_balance ?? 0).toFixed(2)} ${stmt.currency || "EUR"}.`,
          tags: ["bank_statement", "camt053"],
          extracted_fields: {
            account_iban: stmt.account_iban,
            account_holder: stmt.account_holder,
            period_start: stmt.period_start,
            period_end: stmt.period_end,
            opening_balance: stmt.opening_balance,
            closing_balance: stmt.closing_balance,
            currency: stmt.currency,
            line_items: stmt.transactions.map((t) => ({
              description:
                [t.counterparty_name, t.reference].filter(Boolean).join(" — ") ||
                "(unspecified)",
              category: "other",
              total: t.amount,
              currency: t.currency,
              reference: t.reference,
              counterparty_name: t.counterparty_name,
              counterparty_iban: t.counterparty_iban,
              transaction_id: t.transaction_id,
              booking_date: t.booking_date,
              value_date: t.value_date,
              cdt_dbt: t.cdt_dbt,
            })),
          },
          ocr_text: undefined,
          needs_action: false,
          action_type: null,
          due_date: null,
          action_summary: null,
        };
        result = synthetic;
        console.log(
          `[api/analyze] CAMT fast-path: ${stmt.transactions.length} transactions parsed`
        );
      } catch (e) {
        console.warn(
          "[api/analyze] CAMT parse failed, falling back to Claude:",
          e
        );
        const ex = await extractDocument(buffer, doc.file_name || "file.xml");
        result = ex.data;
        aiUsage = ex.usage;
        aiStopReason = ex.stop_reason;
        aiMaxCap = ex.max_tokens_cap;
      }
    } else if (looksLikeRabobankCsv(buffer)) {
      // 1.6. Rabobank CSV fast path — same idea as CAMT.053 but for the
      // bank's CSV exports. Parses every row deterministically, so we
      // never hit Claude's 16k-token JSON-output cap (which silently
      // truncates large statements). Detected by sniffing column headers
      // (IBAN/BBAN + Bedrag + Datum + at least one of the Rabobank
      // Dutch-only columns).
      try {
        const csvText = buffer.toString("utf8");
        const stmt = parseRabobankCsv(csvText);
        const debits = stmt.transactions.filter((t) => t.amount < 0);
        const credits = stmt.transactions.filter((t) => t.amount > 0);
        const totalDebit = debits.reduce((s, t) => s + Math.abs(t.amount), 0);
        const totalCredit = credits.reduce((s, t) => s + t.amount, 0);
        const synthetic: DocumentExtraction = {
          document_type: "bank_statement",
          document_subtype: null,
          confidence: 1,
          document_date: stmt.period_end,
          sender: "Rabobank",
          recipient: null,
          language: "nl",
          profile_hint: null,
          amount: null,
          currency: stmt.currency || "EUR",
          purchase_category: null,
          title: `Rabobank statement ${stmt.period_start || ""} – ${stmt.period_end || ""}`.trim(),
          summary: `${stmt.transactions.length} transactions (${debits.length} debits totalling €${totalDebit.toFixed(2)}, ${credits.length} credits totalling €${totalCredit.toFixed(2)}).`,
          tags: ["bank_statement", "rabobank", "csv"],
          extracted_fields: {
            account_iban: stmt.account_iban,
            period_start: stmt.period_start,
            period_end: stmt.period_end,
            currency: stmt.currency,
            line_items: stmt.transactions.map((t) => ({
              description: t.description || t.counterparty_name || "(unspecified)",
              category: "other",
              total: t.amount,
              currency: t.currency,
              reference: t.reference,
              counterparty_name: t.counterparty_name,
              counterparty_iban: t.counterparty_iban,
              transaction_id: t.transaction_id,
              booking_date: t.booking_date,
              value_date: t.value_date,
            })),
          },
          ocr_text: undefined,
          needs_action: false,
          action_type: null,
          due_date: null,
          action_summary: null,
        };
        result = synthetic;
        console.log(
          `[api/analyze] Rabobank CSV fast-path: ${stmt.transactions.length} transactions parsed`
        );
      } catch (e) {
        console.warn(
          "[api/analyze] Rabobank CSV parse failed, falling back to Claude:",
          e
        );
        const ex = await extractDocument(buffer, doc.file_name || "file.csv");
        result = ex.data;
        aiUsage = ex.usage;
        aiStopReason = ex.stop_reason;
        aiMaxCap = ex.max_tokens_cap;
      }
    } else {
      // 2. Default path — Claude extraction (PDF, image, etc.)
      // Allow the caller to opt into the extended 128k cap via
      // ?max_cap=extended (used by the "Retry full" button after a
      // truncation).
      const wantExtended =
        request.nextUrl.searchParams.get("max_cap") === "extended";
      const ex = await extractDocument(
        buffer,
        doc.file_name || "file.pdf",
        wantExtended
          ? { maxTokens: 131072, useExtendedOutput: true }
          : undefined
      );
      result = ex.data;
      aiUsage = ex.usage;
      aiStopReason = ex.stop_reason;
      aiMaxCap = ex.max_tokens_cap;
    }

    if (!result) {
      await admin
        .from("documents")
        .update({
          status: "failed",
          needs_review: true,
          review_notes: "Claude returned an empty response — try again.",
        })
        .eq("id", id);
      return NextResponse.json(
        { error: "Extraction produced no response" },
        { status: 500 }
      );
    }

    // Parse-failure path: surface what Claude actually said in review_notes
    // so the user / future-Claude run can see what went wrong instead of
    // staring at an opaque "no parseable JSON" error.
    if ("error" in result && result.error === "parse_failed") {
      const truncated =
        result.stop_reason === "max_tokens" || result.stop_reason === "length";
      const note = [
        truncated
          ? "Claude's response was cut off (max_tokens). Try Re-analyse — the parser now allows 16k tokens."
          : "Claude's response wasn't valid JSON.",
        `stop_reason: ${result.stop_reason || "unknown"}`,
        `Response length: ${result.raw_text.length} chars`,
        "Raw response (first 4000 chars):",
        result.raw_text.slice(0, 4000),
      ].join("\n");
      await admin
        .from("documents")
        .update({
          status: "failed",
          needs_review: true,
          review_notes: note.slice(0, 8000),
        })
        .eq("id", id);
      return NextResponse.json(
        { error: "Extraction returned non-JSON response", stop_reason: result.stop_reason },
        { status: 500 }
      );
    }

    // After the two early returns above, `result` is necessarily a
    // DocumentExtraction. TS can't narrow through the in-check, so cast.
    const extraction = result as Exclude<typeof result, { error: string }>;

    // 2.4. First-seen-sender detection. If the user has never had a
    // processed doc from this sender before, mark this one with a
    // _first_seen_sender flag. The UI uses it to nudge the user to
    // verify profile + classification on the first appearance — the
    // best moment to seed the pattern for all future docs from that
    // sender.
    let firstSeenSender = false;
    try {
      const priorCount = await countPriorDocsFromSender(
        admin,
        user.id,
        extraction.sender,
        id
      );
      firstSeenSender = priorCount === 0 && !!extraction.sender;
      if (firstSeenSender) {
        console.log(
          "[api/analyze] first time we've seen sender:",
          extraction.sender
        );
      }
    } catch (e) {
      console.warn("[api/analyze] first-seen-sender lookup failed", e);
    }

    // 2.5. Sender-history learning: if the user has historically filed
    // multiple docs from this same sender as type X, and Claude just said
    // type Y, prefer X. This is how the system gets smarter over time —
    // every refile teaches it what to do for the next doc from that sender.
    // Skipped on force_profile re-runs only matters for profile, not type;
    // history applies regardless.
    let historyOverride: string | null = null;
    try {
      const history = await getSenderHistory(
        admin,
        user.id,
        extraction.sender,
        id
      );
      if (
        history &&
        shouldApplyHistoryOverride(extraction.document_type, history.document_type)
      ) {
        console.log(
          "[api/analyze] sender-history override:",
          history.reason,
          "Claude said",
          extraction.document_type,
          "→ using",
          history.document_type
        );
        historyOverride = `Reclassified by sender history: was ${extraction.document_type}, now ${history.document_type}. ${history.reason}`;
        extraction.document_type = history.document_type;
      }
    } catch (e) {
      console.warn("[api/analyze] sender history lookup failed", e);
    }

    // 3. Resolve profile.
    //    Order of preference:
    //      a) explicit profile_id supplied at upload time (user choice wins),
    //         UNLESS force_profile=1 (manual re-analyse) — then we re-rank.
    //      b) AI ranker (suggestProfile) if confidence >= threshold
    //      c) name-token fallback against profile_hint
    //      d) default profile
    let profileId: number | null = forceProfile
      ? null
      : doc.primary_profile_id || null;
    let profileName: string | null = null;
    let profileMatchReason: string | null = null;
    let profileMatchConfidence: number | null = null;
    const profiles = await listProfilesForUser(admin, user.id);

    // First: try deterministic matching on hard identifiers (birth year,
    // city, IBAN, postal code, BSN, patient/policy/customer numbers). This
    // crosses extracted_fields against each profile's structured attributes
    // AND its free-text description (so descriptions like "Born 1936, lives
    // in Dieren" still produce hard signals). When ONE profile uniquely
    // matches, skip the AI entirely — it's a binary fact, not a guess.
    const deterministic = deterministicProfileMatch(extraction, profiles);

    // Always run Claude's suggestion so we can surface its ranking on the
    // detail page, even when the user pre-pinned a profile at upload or
    // we already deterministically matched. Useful for explainability.
    let suggestion: Awaited<ReturnType<typeof suggestProfile>> | null = null;
    try {
      suggestion = await suggestProfile(extraction, profiles);
    } catch (e) {
      console.warn("[api/analyze] suggestProfile failed", e);
    }

    if (profileId) {
      profileName = profiles.find((p) => p.id === profileId)?.name || null;
      profileMatchReason = "User selected at upload";
      profileMatchConfidence = 1;
    } else if (deterministic) {
      // Hard identifier match wins outright.
      profileId = deterministic.profile.id;
      profileName = deterministic.profile.name;
      profileMatchReason = deterministic.reason;
      profileMatchConfidence = 1;
    } else {
      // Always take Claude's top suggestion if it picked anything at all,
      // even at low confidence — "best guess + please confirm" is friendlier
      // than "we gave up". The needs_review flag (set below) tells the user
      // that this assignment is provisional.
      if (suggestion && suggestion.profileId != null) {
        profileId = suggestion.profileId;
        profileName = profiles.find((p) => p.id === profileId)?.name || null;
        profileMatchReason = suggestion.reason;
        profileMatchConfidence = suggestion.confidence;
      }

      if (!profileId && extraction.profile_hint) {
        const matched = matchProfileByHint(extraction.profile_hint, profiles);
        if (matched) {
          profileId = matched.id;
          profileName = matched.name;
          profileMatchReason = "Name-token fallback";
          profileMatchConfidence = 0.5;
        }
      }

      // Truly stumped — Claude returned nothing AND no name token matched.
      // Rare. Leave unassigned + flag for review.
      if (!profileId) {
        profileName = null;
        profileMatchReason = "Needs review — no confident profile match";
        profileMatchConfidence = 0;
      }
    }

    // Anything assigned at less than the auto-assign threshold (and not
    // user-pinned or deterministic) is provisional — the user should
    // confirm or correct it. The "Needs review" banner + per-card
    // Confirm/Refile UI cover that.
    const provisional =
      !!profileId &&
      profileMatchReason !== "User selected at upload" &&
      !deterministic &&
      (profileMatchConfidence ?? 0) < PROFILE_AUTO_ASSIGN_THRESHOLD;

    // 4. Move file in storage backend to final destination
    const destination = storage.buildDestinationPath({
      profileSlug: profileName,
      documentType: extraction.document_type,
      documentDateISO: extraction.document_date,
      filename: doc.file_name || "file.pdf",
      sender: extraction.sender,
      title: extraction.title,
    });
    let newPath = doc.dropbox_path;
    let shareLink: string | null = doc.dropbox_shared_link;
    try {
      newPath = await storage.moveFile(doc.dropbox_path, destination);
      // ORPHAN PREVENTION: write the new path to the row IMMEDIATELY after
      // the move succeeds — as a small, fast UPDATE that's very unlikely to
      // time out. The big "everything else" UPDATE below can fail or get
      // truncated by Vercel's function timeout without leaving the row
      // pointing at a stale inbox path. This was the root cause of the
      // four orphans we recovered manually on Apr 27.
      try {
        await admin
          .from("documents")
          .update({ dropbox_path: newPath })
          .eq("id", id);
      } catch (e) {
        console.warn(
          "[api/analyze] fast-write of dropbox_path failed (will retry in main update)",
          e
        );
      }
      shareLink = await storage.getOrCreateShareLink(newPath);
    } catch (e) {
      console.warn("[api/analyze] move/share failed, keeping inbox path", e);
    }

    // 5. Merge tags
    const existingTags: string[] = doc.tags || [];
    const extractedTags = extraction.tags || [];
    const mergedTags = Array.from(
      new Set(
        [...existingTags, ...extractedTags].map((t) => t.toLowerCase())
      )
    );

    // Hard server-side overrides on `needs_action`, symmetric on payment_status:
    //   - paid    → force needs_action=false (handwritten "Voldaan" / "PAID"
    //               stamps were captured but Claude still flagged needs_action
    //               out of habit; we silently close it).
    //   - unpaid  → force needs_action=true (Claude sometimes treats an
    //               enforcement order or aanmaning as informational and
    //               returns needs_action=false even though the doc plainly
    //               says it's not paid).
    //   - partial → also forces needs_action=true (still owe money).
    // Anything else (or "unknown") falls back to whatever Claude returned.
    const ef = extraction.extracted_fields || {};
    const paymentStatus = String(
      (ef as Record<string, unknown>)["payment_status"] || ""
    ).toLowerCase();
    const isPaid = paymentStatus === "paid";
    const isUnpaid = paymentStatus === "unpaid" || paymentStatus === "partial";
    const needsAction = isPaid
      ? false
      : isUnpaid
        ? true
        : !!extraction.needs_action;

    // When we forced needs_action via the unpaid override AND Claude didn't
    // populate action_summary / action_type, synthesize sensible defaults
    // from what we have so the to-do list isn't empty for unpaid bills.
    let effectiveActionType: string | null =
      extraction.action_type || (needsAction ? "pay" : null);
    let effectiveActionSummary = extraction.action_summary || null;
    if (needsAction && !effectiveActionSummary) {
      const parts: string[] = ["Pay"];
      if (extraction.amount != null && !Number.isNaN(Number(extraction.amount))) {
        const amt = Number(extraction.amount).toFixed(2);
        const cur = extraction.currency || "EUR";
        parts.push(`${cur} ${amt}`);
      }
      if (extraction.sender) parts.push(`to ${extraction.sender}`);
      if (extraction.due_date) parts.push(`by ${extraction.due_date}`);
      effectiveActionSummary = parts.join(" ");
      // Default action_type to "pay" since we derived this from unpaid status
      if (!effectiveActionType) effectiveActionType = "pay";
    }
    const isFinancial = [
      "invoice",
      "receipt",
      "bill",
      "utility_bill",
      "payslip",
      "bank_statement",
    ].includes(extraction.document_type || "");

    // Layer 2 dedup: now that we have sender + date + amount + type from
    // Claude, look for another doc owned by this user with the same
    // tuple. If we find one, soft-link to it so the detail page can
    // surface a "looks like a duplicate of …" banner. Doesn't block —
    // the user decides whether to keep both or delete one.
    let possibleDuplicateOf: string | null = null;
    {
      const senderNorm = (extraction.sender || "").trim();
      // Transaction-like IDs differentiate genuine duplicates from coincidental
      // same-day same-amount purchases (two €5 coffees at the same shop).
      // Try the keys most commonly populated by Claude in order; first hit wins.
      const txKeys = [
        "transaction_id",
        "receipt_number",
        "invoice_number",
        "register_id",
        "reference",
      ];
      const getTxId = (
        ef: Record<string, unknown> | null | undefined
      ): string | null => {
        if (!ef) return null;
        for (const k of txKeys) {
          const v = ef[k];
          if (typeof v === "string" && v.trim()) return v.trim();
          if (typeof v === "number") return String(v);
        }
        return null;
      };
      const myTxId = getTxId(extraction.extracted_fields as Record<string, unknown>);

      if (
        senderNorm &&
        extraction.document_date &&
        extraction.document_type &&
        extraction.amount != null
      ) {
        // Pull up to a handful of candidates matching the loose tuple, then
        // apply the transaction-id rule client-side. Limited to 5 because
        // realistic dup sets are 1–2 rows; 5 is plenty of headroom.
        const { data: candidates } = await admin
          .from("documents")
          .select("id, extracted_fields, created_at")
          .eq("user_id", user.id)
          .neq("id", id)
          .eq("sender", senderNorm)
          .eq("document_date", extraction.document_date)
          .eq("document_type", extraction.document_type)
          .eq("amount", extraction.amount)
          .order("created_at", { ascending: true })
          .limit(5);
        for (const c of candidates || []) {
          const theirTxId = getTxId(
            c.extracted_fields as Record<string, unknown>
          );
          // Rule: if BOTH docs expose a transaction-like ID and the IDs
          // DIFFER, this is NOT a duplicate (different purchases that
          // happened to share the loose tuple). Skip.
          if (myTxId && theirTxId && myTxId !== theirTxId) continue;
          // Otherwise (IDs match, or at least one is missing), treat as a
          // candidate duplicate. Take the first qualifying candidate.
          possibleDuplicateOf = c.id as string;
          console.log(
            "[api/analyze] possible duplicate detected — soft-linking to",
            possibleDuplicateOf,
            myTxId && theirTxId
              ? `(transaction id matched: ${myTxId})`
              : "(no transaction id to disambiguate)"
          );
          break;
        }
      }
    }

    // 6. Update the document row with everything
    const { error: updateErr } = await admin
      .from("documents")
      .update({
        dropbox_path: newPath,
        dropbox_shared_link: shareLink,
        primary_profile_id: profileId,
        possible_duplicate_of: possibleDuplicateOf,
        document_type: extraction.document_type || null,
        document_subtype: extraction.document_subtype || null,
        confidence: extraction.confidence ?? null,
        document_date: extraction.document_date || null,
        sender: extraction.sender || null,
        recipient: extraction.recipient || null,
        person: extraction.profile_hint || doc.person || null,
        language: extraction.language || null,
        amount: extraction.amount ?? null,
        currency: extraction.currency || null,
        purchase_category: extraction.purchase_category || null,
        title: extraction.title || null,
        summary: extraction.summary || null,
        tags: mergedTags,
        extracted_fields: {
          ...(extraction.extracted_fields || {}),
          _profile_match: profileMatchReason
            ? {
                reason: profileMatchReason,
                confidence: profileMatchConfidence,
                // Claude's full ranked list (independent of which profile we
                // actually chose) so the user can see WHY a match did or
                // didn't happen.
                ai_ranked: suggestion?.ranked || null,
                ai_best_id: suggestion?.profileId ?? null,
                ai_best_confidence: suggestion?.confidence ?? null,
                ai_best_reason: suggestion?.reason || null,
              }
            : undefined,
          _type_history_override: historyOverride || undefined,
          _first_seen_sender: firstSeenSender || undefined,
        },
        ocr_text: extraction.ocr_text || null,
        needs_action: needsAction,
        action_type: needsAction ? effectiveActionType || "other" : null,
        due_date: extraction.due_date || null,
        action_summary: needsAction ? effectiveActionSummary || null : null,
        handoff_status: isFinancial ? "pending" : "not_applicable",
        // Surface for triage when the assignment is provisional (low-confidence
        // AI guess, name-token match, or completely unassigned). Cleared by
        // the user via the per-card Confirm button or the RefileWidget.
        needs_review: !profileId || provisional,
        // AI usage tracking (migration 013) — lets the UI show per-doc
        // cost and lets the user retry at the 128k cap when truncated.
        ai_input_tokens: aiUsage.input_tokens || null,
        ai_output_tokens: aiUsage.output_tokens || null,
        ai_stop_reason: aiStopReason,
        ai_max_tokens_cap: aiMaxCap || null,
        ai_truncated: aiStopReason === "max_tokens",
        status: "processed",
      })
      .eq("id", id);

    if (updateErr) {
      console.error("[api/analyze] update error", updateErr);
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    // 7. Action handling — a doc may now have MULTIPLE concurrent actions,
    //    e.g. "Pay €76.60" AND "Send to bookkeeping". Each is keyed by
    //    (document_id, action_type) thanks to migration 007.

    // 7a. Pay/respond/sign/etc. action — use the EFFECTIVE values so
    //     unpaid-but-Claude-said-no-action docs still get an action row
    //     with a synthesized summary.
    if (needsAction && effectiveActionSummary) {
      const payActionType = effectiveActionType || "other";
      const { error: actionErr } = await admin.from("actions").upsert(
        {
          user_id: user.id,
          document_id: id,
          profile_id: profileId,
          action_type: payActionType,
          summary: effectiveActionSummary,
          due_date: extraction.due_date || null,
          status: "open",
        },
        { onConflict: "document_id,action_type" }
      );
      if (actionErr) {
        console.warn("[api/analyze] action upsert failed", actionErr);
      }
    } else if (isPaid) {
      // Paid bills: auto-close any open pay-style action so the user's
      // to-do list stays accurate. Records when (and why) we closed it.
      // Doesn't touch send_to_bookkeeping actions — those are independent.
      const { error: closeErr } = await admin
        .from("actions")
        .update({
          status: "done",
          completed_at: new Date().toISOString(),
          notes: "Auto-closed: document marked paid by AI re-analysis.",
        })
        .eq("document_id", id)
        .eq("status", "open")
        .in("action_type", ["pay", "respond", "sign", "file_with_authority", "other"]);
      if (closeErr) {
        console.warn("[api/analyze] action auto-close failed", closeErr);
      }
    }

    // 7b. send_to_bookkeeping action for any invoice/receipt/bill that
    //     hasn't already been pushed. Independent of payment status —
    //     even paid invoices still need to land in the books.
    const isBookkeepingCandidate = [
      "invoice",
      "receipt",
      "bill",
      "utility_bill",
    ].includes(extraction.document_type || "");
    const alreadySent = !!doc.sent_to_bookkeeping_at;

    if (isBookkeepingCandidate && !alreadySent) {
      const { error: bkErr } = await admin.from("actions").upsert(
        {
          user_id: user.id,
          document_id: id,
          profile_id: profileId,
          action_type: "send_to_bookkeeping",
          summary: `Send "${extraction.title || doc.file_name || "this document"}" to bookkeeping`,
          due_date: null,
          status: "open",
        },
        { onConflict: "document_id,action_type" }
      );
      if (bkErr) {
        console.warn("[api/analyze] bookkeeping action upsert failed", bkErr);
      }
    }

    // 7c. Bank-statement reconciliation — when this doc IS a bank statement,
    //     loop its line items and try to auto-close open `pay` actions
    //     whose source bill matches a debit on the statement. The matched
    //     source documents get marked `payment_status: "paid"` with the
    //     statement transaction's date as paid_date. Logged to maintenance_log.
    let reconciliationSummary: {
      matched: number;
      ambiguous: number;
      unmatched: number;
      considered: number;
    } | null = null;
    if (extraction.document_type === "bank_statement") {
      try {
        const items =
          ((extraction.extracted_fields as Record<string, unknown> | null)?.[
            "line_items"
          ] as unknown as Array<Record<string, unknown>>) || [];
        // Normalise into BankTransactionLike shape — handles both the
        // CAMT-fast-path output and Claude's PDF extraction.
        const transactions = items
          .map((it) => {
            const totalRaw = it["total"];
            let total =
              typeof totalRaw === "number" ? totalRaw : Number(totalRaw);
            if (!Number.isFinite(total)) return null;
            // For PDF-extracted statements where Claude may have returned
            // unsigned amounts but a "cdt_dbt" or similar indicator, infer
            // the sign from the description as a fallback.
            const cdtDbt = (it["cdt_dbt"] as string | undefined) || null;
            if (cdtDbt === "DBIT" && total > 0) total = -total;
            if (cdtDbt === "CRDT" && total < 0) total = -total;
            return {
              amount: total,
              currency: (it["currency"] as string | undefined) || null,
              booking_date:
                (it["booking_date"] as string | undefined) ||
                (it["transaction_date"] as string | undefined) ||
                null,
              value_date:
                (it["value_date"] as string | undefined) ||
                (it["transaction_date"] as string | undefined) ||
                null,
              counterparty_name:
                (it["counterparty_name"] as string | undefined) ||
                (it["description"] as string | undefined) ||
                null,
              counterparty_iban:
                (it["counterparty_iban"] as string | undefined) || null,
              reference:
                (it["reference"] as string | undefined) ||
                (it["description"] as string | undefined) ||
                null,
              transaction_id:
                (it["transaction_id"] as string | undefined) || null,
              description:
                (it["description"] as string | undefined) || null,
            };
          })
          .filter(
            (t): t is NonNullable<typeof t> => t !== null
          );

        // Persist into the first-class bank_transactions table. This is
        // the source of truth from this point on; the JSON line_items
        // above stays as a backup audit trail of what extraction returned.
        try {
          const r = await replaceStatementTransactions(
            admin,
            user.id,
            id,
            transactions.map((t) => ({
              amount: t.amount,
              currency: t.currency || "EUR",
              booking_date: t.booking_date,
              value_date: t.value_date,
              counterparty_name: t.counterparty_name,
              counterparty_iban: t.counterparty_iban,
              description: t.description,
              reference: t.reference,
              transaction_id: t.transaction_id,
            }))
          );
          console.log(
            `[api/analyze] wrote ${r.inserted} rows to bank_transactions; restored ${r.restored_matches} matched_* back-links`
          );
        } catch (e) {
          // Defensive: handle real Errors, Supabase PostgrestError plain
          // objects, and unknown shapes. The plain-object case is what
          // produced "[object Object]" in earlier review_notes.
          let msg: string;
          if (e instanceof Error) {
            msg = e.message;
          } else if (e && typeof e === "object") {
            const o = e as Record<string, unknown>;
            const parts = [
              typeof o.message === "string" ? o.message : null,
              typeof o.code === "string" ? `(code ${o.code})` : null,
              typeof o.details === "string" ? `details: ${o.details}` : null,
              typeof o.hint === "string" ? `hint: ${o.hint}` : null,
            ].filter(Boolean) as string[];
            msg = parts.length ? parts.join(" — ") : JSON.stringify(e).slice(0, 500);
          } else {
            msg = String(e);
          }
          console.warn("[api/analyze] bank_transactions write failed", e);
          // Surface the failure in the UI so the user sees WHY their
          // statement looks empty — instead of an empty Reconciliation
          // panel with no explanation. Doesn't fail the whole analyze:
          // the doc is still useful (extracted_fields has line_items as
          // a backup); we just couldn't index them into the table.
          try {
            await admin
              .from("documents")
              .update({
                needs_review: true,
                review_notes: `bank_transactions write failed (${transactions.length} transactions): ${msg.slice(0, 500)}`,
              })
              .eq("id", id);
          } catch (e2) {
            console.warn(
              "[api/analyze] also failed to record review_notes",
              e2
            );
          }
        }

        // Compute a tiny summary so the inbox card can show "5 txns,
        // €294 out, €0 in" at-a-glance without joining bank_transactions.
        // Stored under extracted_fields._bank_summary; surfaced via the
        // slim INBOX_CARD_FIELDS projection.
        const debitTotal = transactions
          .filter((t) => t.amount < 0)
          .reduce((s, t) => s + Math.abs(t.amount), 0);
        const creditTotal = transactions
          .filter((t) => t.amount > 0)
          .reduce((s, t) => s + t.amount, 0);
        const bankSummary = {
          txn_count: transactions.length,
          debit_total: Number(debitTotal.toFixed(2)),
          credit_total: Number(creditTotal.toFixed(2)),
          currency: extraction.currency || "EUR",
        };
        try {
          await admin
            .from("documents")
            .update({
              extracted_fields: {
                ...(extraction.extracted_fields || {}),
                _bank_summary: bankSummary,
              },
            })
            .eq("id", id);
        } catch (e) {
          console.warn("[api/analyze] _bank_summary write failed", e);
        }

        // Reconcile reads transactions back FROM the database, so any
        // partial write above gets surfaced as "missing transactions"
        // rather than silently miscounted. Source of truth = the table.
        const r = await reconcileBankStatement(admin, user.id, id);
        reconciliationSummary = {
          matched: r.matched,
          ambiguous: r.ambiguous,
          unmatched: r.unmatched,
          considered: r.considered,
        };
        // Persist the summary into extracted_fields so the UI can show it.
        await admin
          .from("documents")
          .update({
            extracted_fields: {
              ...(extraction.extracted_fields || {}),
              _reconciliation: {
                ran_at: new Date().toISOString(),
                ...r,
              },
            },
          })
          .eq("id", id);
      } catch (e) {
        console.warn("[api/analyze] reconciliation failed", e);
      }
    }

    console.log(
      "[api/analyze] done",
      id,
      reconciliationSummary
        ? `(reconciled ${reconciliationSummary.matched}/${reconciliationSummary.considered})`
        : ""
    );
    return NextResponse.json({ ok: true, reconciliation: reconciliationSummary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Analyze failed";
    console.error("[api/analyze] error:", msg);
    const admin = await createServiceClient();
    await admin
      .from("documents")
      .update({
        status: "failed",
        needs_review: true,
        review_notes: msg.slice(0, 500),
      })
      .eq("id", id);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
