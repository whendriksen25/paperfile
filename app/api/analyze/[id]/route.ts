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

    // 2. Run Claude extraction
    const result = await extractDocument(
      buffer,
      doc.file_name || "file.pdf"
    );

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
        "First 500 chars of the response:",
        result.raw_text.slice(0, 500),
      ].join("\n");
      await admin
        .from("documents")
        .update({
          status: "failed",
          needs_review: true,
          review_notes: note.slice(0, 4000),
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

    // Hard server-side override: a doc that has already been paid never
    // needs a "pay this" action, regardless of what Claude returned. This
    // covers the case where a handwritten "PAID 27-11-2025" annotation was
    // captured but the model still flagged needs_action=true out of habit.
    const ef = extraction.extracted_fields || {};
    const paymentStatus = String(
      (ef as Record<string, unknown>)["payment_status"] || ""
    ).toLowerCase();
    const isPaid = paymentStatus === "paid";
    const needsAction = isPaid ? false : !!extraction.needs_action;
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
      if (
        senderNorm &&
        extraction.document_date &&
        extraction.document_type &&
        extraction.amount != null
      ) {
        const { data: dupRow } = await admin
          .from("documents")
          .select("id")
          .eq("user_id", user.id)
          .neq("id", id)
          .eq("sender", senderNorm)
          .eq("document_date", extraction.document_date)
          .eq("document_type", extraction.document_type)
          .eq("amount", extraction.amount)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (dupRow) {
          possibleDuplicateOf = dupRow.id as string;
          console.log(
            "[api/analyze] possible duplicate detected — soft-linking to",
            possibleDuplicateOf
          );
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
        },
        ocr_text: extraction.ocr_text || null,
        needs_action: needsAction,
        action_type: needsAction ? extraction.action_type || "other" : null,
        due_date: extraction.due_date || null,
        action_summary: needsAction ? extraction.action_summary || null : null,
        handoff_status: isFinancial ? "pending" : "not_applicable",
        // Surface for triage when the assignment is provisional (low-confidence
        // AI guess, name-token match, or completely unassigned). Cleared by
        // the user via the per-card Confirm button or the RefileWidget.
        needs_review: !profileId || provisional,
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

    // 7a. Pay/respond/sign/etc. action from Claude's needs_action signal.
    if (needsAction && extraction.action_summary) {
      const payActionType = extraction.action_type || "other";
      const { error: actionErr } = await admin.from("actions").upsert(
        {
          user_id: user.id,
          document_id: id,
          profile_id: profileId,
          action_type: payActionType,
          summary: extraction.action_summary,
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

    console.log("[api/analyze] done", id);
    return NextResponse.json({ ok: true });
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
