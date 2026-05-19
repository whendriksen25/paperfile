import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import {
  extractDocument,
  isMultiDoc,
  type MultiDocumentExtraction,
} from "@/lib/ai/extract";
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
import {
  loadTaxonomySnapshot,
  buildTaxonomyHint,
  canonicalisePath,
} from "@/lib/services/taxonomy";
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

    // 1. Download original from its storage backend.
    // Special case: ?from_original=1 — when the parent of a multi-doc
    // split was previously cropped, its dropbox_path now points at
    // crop[0] (a single receipt). Re-analysing it would just re-process
    // that one crop. The "Re-analyse full scan" button uses this flag
    // to download from the FULL multi-receipt scan instead, triggering
    // a fresh multi-doc detection + new crops (the dedup-on-resplit
    // logic later in this route replaces all current children cleanly).
    const fromOriginal =
      request.nextUrl.searchParams.get("from_original") === "1";
    const ef0 = doc.extracted_fields as Record<string, unknown> | null;
    const originalScanPathStored =
      (ef0?.["_original_scan_path"] as string | undefined) || null;
    // Legacy fallback: pre-crop multi-doc parents don't have
    // _original_scan_path stored, but their dropbox_path IS the original
    // full scan (since crops weren't a thing yet). Detect by checking
    // for children — if this doc has children AND no stored original
    // path, treat dropbox_path as the original.
    let legacyOriginalFallback = false;
    if (fromOriginal && !originalScanPathStored) {
      const { data: kidsCheck } = await admin
        .from("documents")
        .select("id")
        .eq("parent_document_id", id)
        .limit(1);
      if ((kidsCheck || []).length > 0) {
        legacyOriginalFallback = true;
        console.log(
          "[api/analyze] from_original=1 with no _original_scan_path; using dropbox_path as legacy original full scan"
        );
      } else {
        console.warn(
          "[api/analyze] from_original=1 but no _original_scan_path AND no children — falling back to dropbox_path"
        );
      }
    }
    const downloadPath =
      fromOriginal && originalScanPathStored
        ? originalScanPathStored
        : doc.dropbox_path;
    const storage = getStorage(doc.storage_provider);
    let buffer = await storage.downloadFile(downloadPath);

    // 1a-pre. Auto-rotate phone photos that arrive with an EXIF
    // orientation tag. Without this, the bytes Claude sees are in
    // sensor orientation (often 90° or 180° off from how the user
    // shot the photo), which tanks both single-doc extraction and
    // multi-doc bounding-box detection. Cheap: ~50ms.
    {
      const { autoOrientImage } = await import(
        "@/lib/services/image-orient"
      );
      const oriented = await autoOrientImage(buffer, doc.file_name);
      if (oriented.rotated) {
        console.log(
          `[analyze] auto-rotated ${doc.file_name} by ${oriented.degrees}°`
        );
        buffer = oriented.buffer;
      }
    }

    // 1a. Load the user's existing taxonomy so we can hint Claude to
    // REUSE subcategory tokens it already knows ("apple") instead of
    // inventing variants ("apples", "appel", "Apple "). Cheap query —
    // tens to low hundreds of rows for a personal archive.
    const taxonomySnapshot = await loadTaxonomySnapshot(admin, doc.user_id);
    const taxonomyHint = buildTaxonomyHint(taxonomySnapshot);

    // 1.5. CAMT.053 fast path — when the file is a CAMT.053 XML bank
    // statement (every NL bank exports this under "Periodieke afschriften"),
    // we parse it deterministically without sending to Claude. Faster,
    // cheaper, and far more accurate than OCR-from-PDF.
    let result:
      | DocumentExtraction
      | MultiDocumentExtraction
      | { error: "parse_failed"; raw_text: string; stop_reason: string | null }
      | null = null;
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
        const ex = await extractDocument(buffer, doc.file_name || "file.xml", { taxonomyHint });
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
        const ex = await extractDocument(buffer, doc.file_name || "file.csv", { taxonomyHint });
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
          ? { maxTokens: 131072, useExtendedOutput: true, taxonomyHint }
          : { taxonomyHint }
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

    // Multi-document detection. If Claude returned { documents: [...] }
    // — meaning the scan contains multiple distinct documents (e.g. 4
    // receipts on one photo) — we treat documents[0] as the primary
    // for this row, and stash documents[1..] to spawn as child rows
    // after the main flow finishes for the primary. The children share
    // the same dropbox_path (one physical scan, multiple records).
    let multiDocChildren: DocumentExtraction[] = [];
    let extraction: DocumentExtraction;
    // Per-crop image buffers from option-3 cropping. Index 0 = parent's
    // crop, [1..N] = child crops. Empty until the cropping block runs.
    let perCropDropboxBuffers: Buffer[] | null = null;
    // Filled by the file-move section once per-crop Dropbox paths exist.
    // Used by the child-spawn loop to set each child's dropbox_path.
    const perCropDropboxPaths: string[] = [];
    // Polygons that drove the per-crop split. Persisted on the parent's
    // extracted_fields._multidoc so the UI can render an overlay later
    // ("the top-left receipt is doc B") and child-doc pages can describe
    // their original position on the parent scan.
    let savedMultiDocPolygons:
      | import("@/lib/ai/extract").ReceiptPolygon[]
      | null = null;
    if (isMultiDoc(result)) {
      let docs = result.documents;
      if (docs.length === 0) {
        await admin
          .from("documents")
          .update({
            status: "failed",
            needs_review: true,
            review_notes:
              "Multi-doc detection returned an empty documents array.",
          })
          .eq("id", id);
        return NextResponse.json(
          { error: "Empty documents array" },
          { status: 500 }
        );
      }

      // ★ Per-receipt cropped re-extraction (option 3).
      // If Claude gave us polygons (or legacy bounding_boxes — the
      // extract.ts parser auto-converts those) AND the original is an
      // image, crop each receipt out + deskew so it sits upright, then
      // re-run extractDocument on each crop in full resolution.
      //
      // Per-crop dropbox paths are remembered so the parent / children
      // rows can each point at THEIR receipt's crop (not the original
      // full scan). The original full scan is retained in Dropbox for
      // recovery; only the row pointers move to the crops.
      const multi = result as MultiDocumentExtraction;
      // Prefer polygons (content-aware, tight, tilted-receipt-aware).
      // Fall back to converting legacy bounding_boxes if the parser
      // didn't already do it. polygons[i] ↔ documents[i].
      let polygons = Array.isArray(multi.polygons) ? multi.polygons : null;
      if (!polygons && Array.isArray(multi.bounding_boxes)) {
        const { bboxToPolygon } = await import("@/lib/ai/extract");
        polygons = multi.bounding_boxes.map(bboxToPolygon);
      }
      // Cleanup: drop tiny phantom polygons + resolve pairwise overlaps
      // by midpoint-split. Catches Sonnet's two common mis-detections
      // on multi-receipt scans. Updates docs[] in lockstep so per-doc
      // indices stay aligned with the cleaned polygons[].
      if (polygons && polygons.length > 0) {
        const { cleanupPolygonsForCropping } = await import(
          "@/lib/services/image-crop"
        );
        const cleaned = cleanupPolygonsForCropping(polygons, docs);
        polygons = cleaned.polygons;
        docs = cleaned.documents;
      }
      extraction = docs[0];
      multiDocChildren = docs.slice(1);
      console.log(
        `[api/analyze] multi-doc detected: ${docs.length} documents on this scan (post-cleanup)`
      );
      const isImage = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(
        doc.file_name || ""
      );
      if (
        isImage &&
        Array.isArray(polygons) &&
        polygons.length === docs.length &&
        polygons.length > 0
      ) {
        try {
          const { cropAndDeskew } = await import("@/lib/services/image-crop");
          const crops = await cropAndDeskew(buffer, polygons, {
            trim: true,
            // Haiku probe on each crop after deskew — catches any
            // 90/180/270° misalignment Sonnet missed on the busy
            // multi-receipt scan. ~$0.001 per crop.
            orientationProbe: true,
          });
          // Re-extract each crop at full resolution IN PARALLEL.
          // Sequential calls take 4×~20s = ~80s which alone exceeds
          // Vercel's 60s Hobby cap. Parallel collapses wall-clock to
          // max(per-call) ≈ 20-25s. Anthropic's rate limits are fine
          // with 4 parallel for personal-scale traffic.
          const extResults = await Promise.all(
            crops.map((c, i) =>
              extractDocument(c, `${doc.file_name || "crop"}_part${i + 1}.jpg`, {
                taxonomyHint,
              })
            )
          );
          const reExtracted: DocumentExtraction[] = [];
          for (let i = 0; i < extResults.length; i++) {
            const ex = extResults[i];
            aiUsage = {
              input_tokens: aiUsage.input_tokens + (ex.usage?.input_tokens || 0),
              output_tokens:
                aiUsage.output_tokens + (ex.usage?.output_tokens || 0),
            };
            const d = ex.data;
            // If the per-crop extraction failed or also detected multi-doc,
            // fall back to the original low-res extraction for that index.
            if (!d || "error" in d || isMultiDoc(d)) {
              reExtracted.push(docs[i]);
              console.warn(
                `[api/analyze] per-crop re-extract failed for crop ${i + 1}, falling back to low-res`
              );
            } else {
              reExtracted.push(d as DocumentExtraction);
            }
          }
          // NEW MODEL: parent stays as the original scan container; ALL
          // N receipts become children (not N-1 with receipt #1 folded
          // into the parent). Build a synthetic container extraction for
          // the parent row — aggregated sender/amount/date so the inbox
          // shows useful metadata at a glance.
          const totalAmount = reExtracted
            .map((r) => r.amount)
            .filter((a): a is number => typeof a === "number")
            .reduce((s, n) => s + n, 0);
          const sendersSet = new Set(
            reExtracted
              .map((r) => (r.sender || "").trim())
              .filter(Boolean)
          );
          const commonSender =
            sendersSet.size === 1 ? Array.from(sendersSet)[0] : null;
          const currenciesSet = new Set(
            reExtracted
              .map((r) => (r.currency || "").trim())
              .filter(Boolean)
          );
          const commonCurrency =
            currenciesSet.size === 1 ? Array.from(currenciesSet)[0] : null;
          const allDates = reExtracted
            .map((r) => r.document_date)
            .filter((d): d is string => !!d)
            .sort();
          const latestDate = allDates.length > 0 ? allDates[allDates.length - 1] : null;
          const n = reExtracted.length;
          const containerExtraction: DocumentExtraction = {
            document_type: "multi_doc_scan",
            document_subtype: null,
            confidence: 1,
            document_date: latestDate,
            sender: commonSender,
            recipient: null,
            language: null,
            profile_hint: null,
            amount: totalAmount || null,
            currency: commonCurrency,
            purchase_category: null,
            title: commonSender
              ? `${commonSender} — ${n}-receipt scan`
              : `Multi-receipt scan (${n} receipts)`,
            summary:
              totalAmount > 0
                ? `${n} receipts on one scan totalling ${commonCurrency || "EUR"} ${totalAmount.toFixed(2)}.`
                : `${n} receipts detected on one scan.`,
            tags: [],
            extracted_fields: { _is_multidoc_container: true, _child_count: n },
            ocr_text: undefined,
            needs_action: false,
            action_type: null,
            due_date: null,
            action_summary: null,
          };
          extraction = containerExtraction;
          // EVERY receipt is a child under the new model.
          multiDocChildren = reExtracted;
          // Upload each crop to Dropbox and stash the resulting paths so
          // the file-move + child-spawn code below uses them.
          perCropDropboxBuffers = crops;
          // Remember the polygons that drove the split so we can
          // persist them on the parent (for overlays + per-child
          // "originally top-left of the scan" hints).
          savedMultiDocPolygons = polygons;
          console.log(
            `[api/analyze] cropped + re-extracted ${crops.length} sub-receipts at full res`
          );
        } catch (e) {
          console.warn(
            "[api/analyze] crop+re-extract failed, falling back to low-res shared-image extractions:",
            e
          );
        }
      }
    } else {
      // After the two early returns above, `result` is necessarily a
      // DocumentExtraction. TS can't narrow through the in-check, so cast.
      extraction = result as Exclude<typeof result, { error: string }>;
    }

    // Canonicalise category_path on every line item of every detected
    // doc. Rewrites Claude's free-text subcategory tokens to whatever
    // canonical form the user's taxonomy table has — so "apples" /
    // "Apple" / "appel" all become "apple", registering close variants
    // as aliases for the next pass.
    await canonicaliseLineItemPaths(admin, doc.user_id, extraction);
    for (const child of multiDocChildren) {
      await canonicaliseLineItemPaths(admin, doc.user_id, child);
    }

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

    // 4a. Multi-doc cropping (option 3): when we have per-crop buffers,
    // upload each crop alongside the moved original and remember each
    // crop's path. Parent's dropbox_path then gets repointed to crop[0]
    // (the most useful preview for the parent's extraction); children
    // each get crop[i]. Original full scan stays where the move put it
    // for recoverability AND so the parent can later trigger a fresh
    // multi-doc split via ?from_original=1.
    let originalScanPath: string | null = null;
    if (perCropDropboxBuffers && perCropDropboxBuffers.length > 0) {
      try {
        const originalPath = newPath;
        originalScanPath = originalPath; // remember for parent's extracted_fields
        const dotIdx = originalPath.lastIndexOf(".");
        const stem =
          dotIdx > 0 ? originalPath.slice(0, dotIdx) : originalPath;
        const ext = dotIdx > 0 ? originalPath.slice(dotIdx) : ".jpg";
        for (let i = 0; i < perCropDropboxBuffers.length; i++) {
          const cropPath = `${stem}_part${i + 1}${ext}`;
          try {
            await storage.uploadAt({
              buffer: perCropDropboxBuffers[i],
              path: cropPath,
            });
            perCropDropboxPaths[i] = cropPath;
          } catch (e) {
            console.warn(
              `[api/analyze] crop ${i + 1} upload failed (keeping original path):`,
              e instanceof Error ? e.message : String(e)
            );
          }
        }
        // NEW MODEL: parent stays at the original full scan; do NOT
        // repoint to crop[0]. Children get their own crop paths via
        // perCropDropboxPaths[childIdx].
        console.log(
          `[api/analyze] uploaded ${perCropDropboxPaths.filter(Boolean).length}/${perCropDropboxBuffers.length} crops; parent stays at ${newPath}`
        );
      } catch (e) {
        console.warn(
          "[api/analyze] per-crop upload block failed (continuing):",
          e
        );
      }
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
          // Path to the original full multi-receipt scan, if this row is
          // the parent of a crop-split. Lets the "Re-analyse full scan"
          // button re-trigger the multi-doc detection from the original
          // image instead of just re-extracting crop[0].
          ...(originalScanPath
            ? { _original_scan_path: originalScanPath }
            : {}),
          // Polygons + per-doc detection metadata from the multi-doc
          // split, stored on the PARENT row. The child-doc detail page
          // reads polygons[childIdx + 1] to describe where each child
          // originally sat on the scan ("top-left of the original scan").
          // childIdx 0 in polygons corresponds to the parent itself.
          ...(savedMultiDocPolygons
            ? {
                _multidoc: {
                  polygons: savedMultiDocPolygons,
                  total: 1 + multiDocChildren.length,
                },
              }
            : {}),
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

    // 8. Multi-document children. The primary doc has been fully processed
    // above; now spawn rows for any siblings the AI detected on the same
    // scan. Each child shares the parent's dropbox_path (one physical
    // file, multiple records) but is otherwise independent: own sender,
    // amount, line items, profile, actions.
    const childIds: string[] = [];
    if (multiDocChildren.length > 0) {
      // Dedup-on-resplit: a previous run may have spawned children for
      // this same parent. Re-analyse should REPLACE that set, not stack
      // on top of it. Find existing children + delete their actions
      // first, then delete the child rows themselves.
      try {
        const { data: existingKids } = await admin
          .from("documents")
          .select("id")
          .eq("parent_document_id", id);
        const existingIds = (existingKids || []).map(
          (r) => (r as { id: string }).id
        );
        if (existingIds.length > 0) {
          await admin
            .from("actions")
            .delete()
            .in("document_id", existingIds);
          await admin.from("documents").delete().in("id", existingIds);
          console.log(
            `[api/analyze] deleted ${existingIds.length} stale child doc(s) before respawning`
          );
        }
      } catch (e) {
        console.warn(
          "[api/analyze] failed to clean up existing children (continuing):",
          e
        );
      }
      console.log(
        `[api/analyze] spawning ${multiDocChildren.length} multi-doc children for parent ${id}`
      );
      for (let childIdx = 0; childIdx < multiDocChildren.length; childIdx++) {
        const child = multiDocChildren[childIdx];
        try {
          // Per-child profile match. Each receipt on a scan can legitimately
          // belong to a different profile (e.g. one for the family, one
          // for the business), so we re-run the matcher.
          let childProfileId: number | null = null;
          let childProfileMatchConfidence = 0;
          let childProfileMatchReason = "";
          try {
            const childSuggestion = await suggestProfile(child, profiles);
            if (childSuggestion && childSuggestion.profileId != null) {
              childProfileId = childSuggestion.profileId;
              childProfileMatchConfidence = childSuggestion.confidence;
              childProfileMatchReason = childSuggestion.reason;
            }
          } catch (e) {
            console.warn("[api/analyze] child suggestProfile failed", e);
          }
          if (!childProfileId && child.profile_hint) {
            const m = matchProfileByHint(child.profile_hint, profiles);
            if (m) {
              childProfileId = m.id;
              childProfileMatchReason = "Name-token fallback";
              childProfileMatchConfidence = 0.5;
            }
          }
          // Fallback to parent's profile if the child didn't resolve.
          if (!childProfileId) childProfileId = profileId;

          // payment_status handling — same logic as parent.
          const childEf = child.extracted_fields || {};
          const childPaid = String(
            (childEf as Record<string, unknown>)["payment_status"] || ""
          ).toLowerCase() === "paid";
          const childUnpaid =
            String(
              (childEf as Record<string, unknown>)["payment_status"] || ""
            ).toLowerCase() === "unpaid";
          const childNeedsAction = childPaid
            ? false
            : childUnpaid
              ? true
              : !!child.needs_action;
          const childActionType =
            child.action_type || (childNeedsAction ? "pay" : null);

          const childInsert = {
            user_id: doc.user_id,
            // Point THIS child at its own crop file. NEW MODEL:
            // every receipt is a child (no parent-takes-crop-0), so the
            // child at index `childIdx` uses perCropDropboxPaths[childIdx]
            // directly. Falls back to the parent's path if for some
            // reason the crop upload failed (rare, defensive).
            dropbox_path:
              perCropDropboxPaths[childIdx] ||
              newPath ||
              doc.dropbox_path,
            dropbox_shared_link: shareLink || doc.dropbox_shared_link,
            storage_provider: doc.storage_provider,
            file_name: doc.file_name,
            file_size_bytes: doc.file_size_bytes,
            content_hash: doc.content_hash,
            file_type: doc.file_type,
            // Link back to parent — this is the marker that says "I'm a
            // child split from another scan".
            parent_document_id: id,
            // Per-child extraction.
            primary_profile_id: childProfileId,
            document_type: child.document_type || null,
            document_subtype: child.document_subtype || null,
            confidence: child.confidence ?? null,
            document_date: child.document_date || null,
            sender: child.sender || null,
            recipient: child.recipient || null,
            person: child.profile_hint || null,
            language: child.language || null,
            amount: child.amount ?? null,
            currency: child.currency || null,
            purchase_category: child.purchase_category || null,
            title: child.title || null,
            summary: child.summary || null,
            tags: child.tags || [],
            extracted_fields: childEf,
            ocr_text: child.ocr_text || null,
            needs_action: childNeedsAction,
            action_type: childNeedsAction ? childActionType : null,
            due_date: child.due_date || null,
            action_summary: childNeedsAction
              ? child.action_summary || null
              : null,
            status: "processed",
            needs_review: (childProfileMatchConfidence ?? 0) < PROFILE_AUTO_ASSIGN_THRESHOLD,
            review_notes: childProfileMatchReason
              ? `Multi-doc child: ${childProfileMatchReason}`
              : null,
          };
          const { data: insRow, error: insErr } = await admin
            .from("documents")
            .insert(childInsert)
            .select("id")
            .single();
          if (insErr) {
            console.warn(
              "[api/analyze] child insert failed",
              insErr.message,
              child.title
            );
            continue;
          }
          const childId = (insRow as { id: string }).id;
          childIds.push(childId);

          // Create a pay-action for the child if it has one.
          if (childNeedsAction && child.action_summary && childActionType) {
            try {
              await admin.from("actions").insert({
                user_id: doc.user_id,
                document_id: childId,
                profile_id: childProfileId,
                action_type: childActionType,
                summary: child.action_summary,
                due_date: child.due_date || null,
                status: "open",
              });
            } catch (e) {
              console.warn(
                "[api/analyze] child action insert failed",
                e
              );
            }
          }
        } catch (e) {
          console.warn("[api/analyze] child spawn failed", e);
        }
      }
      // Log the split for the activity history.
      try {
        await admin.from("maintenance_log").insert({
          user_id: doc.user_id,
          document_id: id,
          kind: "multi_doc_split",
          reason: `Detected ${1 + multiDocChildren.length} documents on one scan`,
          payload: {
            parent_document_id: id,
            child_document_ids: childIds,
            total_count: 1 + multiDocChildren.length,
          },
        });
      } catch (e) {
        console.warn("[api/analyze] multi_doc_split log insert failed", e);
      }
    }

    console.log(
      "[api/analyze] done",
      id,
      reconciliationSummary
        ? `(reconciled ${reconciliationSummary.matched}/${reconciliationSummary.considered})`
        : "",
      childIds.length > 0 ? `+${childIds.length} child docs` : ""
    );
    return NextResponse.json({
      ok: true,
      reconciliation: reconciliationSummary,
      child_document_ids: childIds,
    });
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

/**
 * Mutates extraction.extracted_fields.line_items[*].category_path in
 * place: rewrites Claude's free-text subcategory tokens to canonical
 * forms registered in the user's line_item_taxonomy table. New tokens
 * are inserted; close variants ("apples" vs "apple") are folded as
 * aliases so the next extraction matches them exactly.
 */
async function canonicaliseLineItemPaths(
  admin: Awaited<ReturnType<typeof createServiceClient>>,
  userId: string,
  extraction: DocumentExtraction
): Promise<void> {
  const ef = extraction.extracted_fields as Record<string, unknown> | undefined;
  if (!ef) return;
  const items = ef["line_items"];
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const path = item["category_path"];
    if (!Array.isArray(path) || path.length === 0) continue;
    try {
      // Cap at depth 3 client-side too in case Claude ignored the prompt.
      const capped = (path as unknown[])
        .slice(0, 3)
        .map((x) => String(x || ""));
      const canon = await canonicalisePath(admin, userId, capped);
      item["category_path"] = canon;
      // Keep the flat `category` field in sync with path[0].
      if (canon.length > 0) item["category"] = canon[0];
    } catch (e) {
      console.warn(
        "[api/analyze] canonicalisePath failed for one line item:",
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}
