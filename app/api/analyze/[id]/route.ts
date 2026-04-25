import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { extractDocument } from "@/lib/ai/extract";
import { suggestProfile } from "@/lib/ai/suggest-profile";
import {
  listProfilesForUser,
  matchProfileByHint,
  ensureDefaultProfile,
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
    const extraction = await extractDocument(
      buffer,
      doc.file_name || "file.pdf"
    );

    if (!extraction) {
      await admin
        .from("documents")
        .update({
          status: "failed",
          needs_review: true,
          review_notes: "Claude returned no parseable JSON",
        })
        .eq("id", id);
      return NextResponse.json(
        { error: "Extraction produced no JSON" },
        { status: 500 }
      );
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

    // Always run Claude's suggestion so we can surface its ranking on the
    // detail page, even when the user pre-pinned a profile at upload.
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
    } else {
      if (
        suggestion &&
        suggestion.profileId != null &&
        suggestion.confidence >= PROFILE_AUTO_ASSIGN_THRESHOLD
      ) {
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

      if (!profileId) {
        const def = await ensureDefaultProfile(admin, user.id);
        profileId = def.id;
        profileName = def.name;
        profileMatchReason = "Default profile (no confident match)";
        profileMatchConfidence = 0.3;
      }
    }

    // 4. Move file in storage backend to final destination
    const destination = storage.buildDestinationPath({
      profileSlug: profileName,
      documentType: extraction.document_type,
      documentDateISO: extraction.document_date,
      filename: doc.file_name || "file.pdf",
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

    // 6. Update the document row with everything
    const { error: updateErr } = await admin
      .from("documents")
      .update({
        dropbox_path: newPath,
        dropbox_shared_link: shareLink,
        primary_profile_id: profileId,
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
