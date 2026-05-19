import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AI_MODEL_SMART } from "@/lib/ai/pricing";
import { getStorage } from "@/lib/storage";
import {
  extractDocument,
  isMultiDoc,
  bboxToPolygon,
  type BoundingBox,
  type ReceiptPolygon,
} from "@/lib/ai/extract";
import {
  loadTaxonomySnapshot,
  buildTaxonomyHint,
} from "@/lib/services/taxonomy";
import type { DocumentExtraction } from "@/types/document";

/**
 * Background-job orchestration for "Re-analyse full scan" on a
 * multi-receipt scan.
 *
 * Why this exists: the inline /api/analyze/[id] route does detection +
 * crop + per-crop re-extraction in one Vercel function call. On a 4+
 * receipt scan that exceeds the 60s Hobby ceiling. Splitting the work
 * into one HTTP call per crop keeps each call under ~30s.
 *
 * Two exports:
 *   - prepareAnalyzeJob — synchronous (~10s): download, auto-rotate,
 *     detect multi-doc, crop, upload crops, create the analyze_jobs row.
 *     Returns { jobId, totalCrops } or { jobId: null, singleDoc: true }
 *     when only 1 doc was detected (caller falls back to inline analyze).
 *   - processNextAnalyzeStep — claims the next pending step, re-extracts
 *     that one crop via Sonnet (~20s), creates the child doc row,
 *     increments completed_crops. On the last step, runs the dedup-on-
 *     resplit cleanup that the existing inline route does.
 *
 * Mirrors the reconciliation_jobs pattern (017): poll-driven worker
 * advance, atomic claim of next pending step, finalize on last step.
 */

// =============================================================================
// Multi-doc detection prompt — kept in lockstep with the diag script's
// cmdDetectMultidoc (scripts/diag.mjs). Behaviour should be identical
// so "the diag found 4 receipts" guarantees "the job will too".
//
// Format: returns polygons (4+ vertices, clockwise from receipt's own
// top-left) hugging each receipt's perimeter. Legacy bounding_boxes
// also accepted on the parser side for back-compat with older runs.
// =============================================================================
const DETECT_PROMPT = `Examine this scan and detect whether it contains multiple separate documents (receipts, invoices, etc).

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
- TILTED RECEIPT → TILTED POLYGON. If the receipt is tilted on the page, the 4 vertices must trace the receipt's actual corners — each vertex will have a different x AND a different y. Two vertices sharing the exact same x (or the same y) means the polygon is axis-aligned; that's ONLY correct when the receipt itself is perfectly upright AND perfectly axis-aligned.
- POLYGONS MUST NOT OVERLAP. Each pixel belongs to at most one receipt's polygon. When two receipts touch on the page, the shared edge must cleanly divide them — no part of receipt B inside receipt A's polygon. Bleed-through is a critical failure mode.
- Vertices in normalised [0..1] coords, top-left origin (x=0,y=0 is the image's top-left).
- Listed CLOCKWISE starting from the receipt's OWN top-left corner (where its printed header sits), even if the receipt is tilted on the page.
- rotation_estimate_degrees: the receipt's tilt vs upright. 0 = upright. Positive = clockwise. **Range is -180..+180.** Receipts may be sideways (±90°), upside-down (±180°), or at any random angle. Report the actual orientation — a 90° or 180° receipt MUST be reported, never as 0. For small tilts only: if you're not sure whether the receipt is tilted by 1° or genuinely upright (camera perspective vs real rotation), return 0; that case is better off slightly tilted than wrongly deskewed. But for big rotations (>15°), be honest about the magnitude.
- documents[i] and polygons[i] are index-aligned.

Return ONLY the JSON object. No prose, no markdown.`;

interface DetectedDoc {
  sender: string | null;
  amount: number | null;
  document_date: string | null;
  summary: string | null;
  rotation_estimate_degrees?: number | null;
}

interface DetectResult {
  documents: DetectedDoc[];
  /** Preferred output — content-aware polygons. */
  polygons: ReceiptPolygon[];
  /** Legacy axis-aligned rectangles. Kept on the type so old callers
   * that read the raw response still compile, but the worker converts
   * to polygons immediately after parsing. */
  bounding_boxes: BoundingBox[];
}

interface StepState {
  index: number;
  status: "pending" | "processing" | "done" | "failed";
  started_at?: string | null;
  completed_at?: string | null;
  child_doc_id?: string | null;
  error?: string | null;
  sender_hint?: string | null;
  amount_hint?: number | null;
}

interface JobPayload {
  from_original: boolean;
  force_profile: boolean;
  original_path: string;
  detected_docs: DetectedDoc[];
  /** Polygons used to drive the per-crop split. Index-aligned with
   * detected_docs / crop_paths. Persisted on the parent's
   * extracted_fields._multidoc at finalise time so the per-child UI
   * can describe original position on the scan. */
  polygons: ReceiptPolygon[];
  /** Legacy bounding_boxes — left in the payload for back-compat with
   * job rows written before the polygon rewrite. New rows leave this
   * empty; consumers should prefer `polygons`. */
  boxes: BoundingBox[];
  crop_paths: string[];
}

export interface PrepareAnalyzeJobResult {
  jobId: string | null;
  totalCrops: number;
  singleDoc: boolean;
  /** When singleDoc is true, the caller should fall back to the
   * existing synchronous /api/analyze/[id] route. We don't run that
   * inline here because it would re-introduce the very 60s-budget
   * concern this job pattern exists to solve (single-doc inline
   * analyze comfortably fits, but routing through a separate request
   * keeps the prepare endpoint cheap + cacheable). */
  reason?: string;
}

export interface AnalyzeStepResult {
  status: "pending" | "processing" | "done" | "failed";
  done: boolean;
  completed_crops: number;
  total_crops: number;
  step?: {
    index: number;
    child_doc_id: string | null;
    sender: string | null;
    amount: number | null;
    error?: string | null;
  };
}

interface JobRow {
  id: string;
  user_id: string;
  document_id: string;
  status: "pending" | "processing" | "done" | "failed";
  phase: string | null;
  total_crops: number;
  completed_crops: number;
  payload: JobPayload;
  steps_state: StepState[];
}

/**
 * Call Sonnet with the detection-only prompt. Same model + temp +
 * media-type handling as scripts/diag.mjs cmdDetectMultidoc.
 * Typically returns in ~5-10s on a phone-quality image.
 */
async function detectMultiDoc(
  buffer: Buffer,
  fileName: string
): Promise<DetectResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const isImage = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName);
  const mediaType: "image/png" | "image/jpeg" | "application/pdf" = isImage
    ? /png$/i.test(fileName)
      ? "image/png"
      : "image/jpeg"
    : "application/pdf";

  const contentBlock = isImage
    ? ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mediaType as "image/png" | "image/jpeg",
          data: buffer.toString("base64"),
        },
      })
    : ({
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: buffer.toString("base64"),
        },
      });

  const stream = client.messages.stream({
    model: AI_MODEL_SMART,
    max_tokens: 8000,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: DETECT_PROMPT },
          contentBlock,
        ],
      },
    ],
  });
  const resp = await stream.finalMessage();
  const text =
    resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("") || "";

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  let parsed: {
    documents?: DetectedDoc[];
    polygons?: ReceiptPolygon[];
    bounding_boxes?: BoundingBox[];
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    // Treat unparseable detection as "single doc" — caller falls back
    // to the existing inline analyze path. Better than failing the job.
    return { documents: [], polygons: [], bounding_boxes: [] };
  }
  const docs = Array.isArray(parsed.documents) ? parsed.documents : [];
  const boxes = Array.isArray(parsed.bounding_boxes)
    ? parsed.bounding_boxes
    : [];
  // Prefer polygons (content-aware, tight, tilt-aware). Fall back to
  // converting legacy bounding_boxes if the model returned only those.
  // Either way, polygons[i] ↔ documents[i] post-normalisation.
  let polygons: ReceiptPolygon[] = Array.isArray(parsed.polygons)
    ? parsed.polygons
    : [];
  if (polygons.length !== docs.length && boxes.length === docs.length) {
    polygons = boxes.map(bboxToPolygon);
  }
  return { documents: docs, polygons, bounding_boxes: boxes };
}

/** Build the per-crop Dropbox path: {stem}_part{i+1}{ext} alongside the
 * original. Matches the convention the inline analyze route uses. */
function buildCropPath(originalPath: string, index: number): string {
  const dotIdx = originalPath.lastIndexOf(".");
  const stem = dotIdx > 0 ? originalPath.slice(0, dotIdx) : originalPath;
  const ext = dotIdx > 0 ? originalPath.slice(dotIdx) : ".jpg";
  return `${stem}_part${index + 1}${ext}`;
}

// =============================================================================
// prepareAnalyzeJob — synchronous prepare step
// =============================================================================

/**
 * Run the synchronous portion of a "re-analyse full scan" request:
 * download the original, detect multi-doc, crop, upload crops, insert
 * the analyze_jobs row.
 *
 * If only 1 document is detected, returns { jobId: null, singleDoc: true }
 * — the caller falls back to the existing synchronous /api/analyze/[id]
 * route (which is fine because the multi-step background job ONLY exists
 * to fit multiple per-crop AI calls inside Vercel's 60s ceiling; for one
 * doc the inline route comfortably fits).
 */
export async function prepareAnalyzeJob(
  admin: SupabaseClient,
  opts: {
    documentId: string;
    userId: string;
    fromOriginal: boolean;
    forceProfile: boolean;
  }
): Promise<PrepareAnalyzeJobResult> {
  const { documentId, userId, fromOriginal, forceProfile } = opts;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  // Cancel any previously-pending analyze jobs for this document so the
  // worker doesn't pick up stale steps from a prior run.
  await admin
    .from("analyze_jobs")
    .update({ status: "failed", error: "Superseded by new re-analyse run" })
    .eq("document_id", documentId)
    .in("status", ["pending", "processing"]);

  // 1. Load the parent doc.
  const { data: docRaw, error: docErr } = await admin
    .from("documents")
    .select("*")
    .eq("id", documentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (docErr || !docRaw) {
    throw new Error("Document not found");
  }
  const doc = docRaw as {
    id: string;
    user_id: string;
    dropbox_path: string;
    file_name: string | null;
    storage_provider: "dropbox" | "gdrive" | "onedrive" | "s3" | "local";
    extracted_fields: Record<string, unknown> | null;
  };

  // 2. Resolve which file to download. Same logic the inline analyze
  // route uses for ?from_original=1, including the legacy fallback for
  // pre-crop multi-doc parents whose _original_scan_path wasn't stored.
  const ef0 = doc.extracted_fields || {};
  const originalScanPathStored =
    (ef0["_original_scan_path"] as string | undefined) || null;
  let downloadPath = doc.dropbox_path;
  if (fromOriginal) {
    if (originalScanPathStored) {
      downloadPath = originalScanPathStored;
    } else {
      // Legacy fallback: pre-crop multi-doc parents kept the original
      // scan AT dropbox_path (since crops weren't a thing yet). Detect
      // by checking for children. If children exist + no stored path,
      // dropbox_path IS the original.
      const { data: kidsCheck } = await admin
        .from("documents")
        .select("id")
        .eq("parent_document_id", documentId)
        .limit(1);
      if ((kidsCheck || []).length > 0) {
        downloadPath = doc.dropbox_path;
        console.log(
          "[analyze-job] from_original=1 with no _original_scan_path; using dropbox_path as legacy original full scan"
        );
      } else {
        console.warn(
          "[analyze-job] from_original=1 but no _original_scan_path AND no children — falling back to dropbox_path"
        );
      }
    }
  }

  const storage = getStorage(doc.storage_provider);
  let buffer = await storage.downloadFile(downloadPath);

  // 3. Auto-rotate before sending to Claude. EXIF-stripped phone
  // uploads otherwise reach Sonnet sideways and tank detection.
  const { autoOrientImage } = await import("@/lib/services/image-orient");
  const oriented = await autoOrientImage(buffer, doc.file_name || "scan.jpg");
  if (oriented.rotated) {
    console.log(
      `[analyze-job] auto-rotated ${doc.file_name} by ${oriented.degrees}°`
    );
    buffer = oriented.buffer;
  }

  // 4. Detection. ~5-10s, comfortably inside the prepare-route budget.
  console.log("[analyze-job] running multi-doc detection on", documentId);
  const detect = await detectMultiDoc(buffer, doc.file_name || "scan.jpg");
  const docs = detect.documents;
  const polygons = detect.polygons;
  const boxes = detect.bounding_boxes;

  // 5. Single-doc fall-through. Caller decides what to do next (typically
  // POST to the existing inline /api/analyze/[id] route).
  if (docs.length <= 1) {
    console.log(
      "[analyze-job] only 1 doc detected — no job created, caller should fall back to inline analyze"
    );
    return {
      jobId: null,
      totalCrops: 0,
      singleDoc: true,
      reason:
        docs.length === 0 ? "detection returned 0 docs" : "single doc only",
    };
  }

  // 6. Crop + upload. Only images support cropping (sharp can't open
  // PDFs); if the original is a PDF we still create the job but with
  // crop_paths set to the original path so per-crop extraction sees the
  // shared image. In practice multi-receipt scans are always images.
  const isImage = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(
    doc.file_name || ""
  );
  const cropPaths: string[] = [];
  if (
    isImage &&
    polygons.length === docs.length &&
    polygons.length > 0
  ) {
    try {
      const { cropAndDeskew } = await import("@/lib/services/image-crop");
      const crops = await cropAndDeskew(buffer, polygons, {
        trim: true,
        // Haiku probe on each crop after deskew — catches any 90/180/270°
        // misalignment Sonnet missed on the busy multi-receipt scan.
        // ~$0.001 per crop, negligible.
        orientationProbe: true,
      });
      for (let i = 0; i < crops.length; i++) {
        // Crop paths sit alongside the original scan, named
        // {stem}_part{i+1}{ext} — same convention as the inline route.
        // Base the path off downloadPath (the original) so siblings line
        // up in Dropbox; the inline route does the same.
        const cropPath = buildCropPath(downloadPath, i);
        try {
          await storage.uploadAt({
            buffer: crops[i],
            path: cropPath,
          });
          cropPaths[i] = cropPath;
        } catch (e) {
          console.warn(
            `[analyze-job] crop ${i + 1} upload failed, will fall back to original path:`,
            e instanceof Error ? e.message : String(e)
          );
          cropPaths[i] = downloadPath; // fallback: per-crop step uses shared image
        }
      }
    } catch (e) {
      console.warn(
        "[analyze-job] crop step failed — every step will use the shared image:",
        e
      );
      // Fall through: cropPaths will be filled with the original.
    }
  }
  // Fill any gaps with the original path so every step has SOMETHING.
  for (let i = 0; i < docs.length; i++) {
    if (!cropPaths[i]) cropPaths[i] = downloadPath;
  }

  // 7. Build per-step state with hints so the UI can show "OCR'ing
  // receipt 1 of 4 — EKOPLAZA €31.72" before extraction even finishes.
  const stepsState: StepState[] = docs.map((d, i) => ({
    index: i,
    status: "pending",
    sender_hint: d?.sender ?? null,
    amount_hint:
      typeof d?.amount === "number" && Number.isFinite(d.amount)
        ? d.amount
        : null,
  }));

  // 8. Insert the analyze_jobs row. status='processing' from the start
  // because the prepare step already did meaningful work (download +
  // detect + crop + upload); only per-step extraction remains.
  const payload: JobPayload = {
    from_original: fromOriginal,
    force_profile: forceProfile,
    original_path: downloadPath,
    detected_docs: docs,
    polygons,
    boxes,
    crop_paths: cropPaths,
  };

  const { data: jobRow, error: insErr } = await admin
    .from("analyze_jobs")
    .insert({
      user_id: userId,
      document_id: documentId,
      status: "processing",
      phase: "extracting",
      total_crops: docs.length,
      completed_crops: 0,
      payload,
      steps_state: stepsState,
    })
    .select("id")
    .single();
  if (insErr || !jobRow) {
    throw new Error(`Failed to create analyze_jobs row: ${insErr?.message}`);
  }

  // 9. Mark parent doc as processing so the inbox card shows a spinner
  // (mirrors the inline route's first action).
  await admin
    .from("documents")
    .update({ status: "processing" })
    .eq("id", documentId);

  return {
    jobId: (jobRow as { id: string }).id,
    totalCrops: docs.length,
    singleDoc: false,
  };
}

// =============================================================================
// processNextAnalyzeStep — worker, called per-step from the step route
// =============================================================================

/**
 * Process one pending step of an analyze job. One call = one per-crop
 * extraction + one child doc insert (or, for index 0, an update to the
 * parent doc itself — see below).
 *
 * Conventions:
 *   - Step 0 corresponds to crop[0], which by convention REPLACES the
 *     parent doc's content. The parent already exists as a row; we
 *     update its extracted fields + repoint its dropbox_path to crop[0].
 *     This mirrors the inline route's behaviour.
 *   - Steps 1..N each create a new child document row with
 *     parent_document_id = parent.id and dropbox_path = crop[i].
 *   - When the last step finishes, we run the dedup-on-resplit cleanup
 *     (delete OLD children + their actions that weren't spawned by this
 *     job), persist _original_scan_path on the parent, and flip the job
 *     to 'done'.
 */
export async function processNextAnalyzeStep(
  admin: SupabaseClient,
  jobId: string
): Promise<AnalyzeStepResult> {
  // 1. Load the job + claim the next pending step BEFORE doing work.
  const { data: jobRaw, error: jErr } = await admin
    .from("analyze_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (jErr || !jobRaw) {
    return {
      status: "failed",
      done: false,
      completed_crops: 0,
      total_crops: 0,
    };
  }
  const job = jobRaw as JobRow;

  if (job.status === "done" || job.status === "failed") {
    return {
      status: job.status,
      done: job.status === "done",
      completed_crops: job.completed_crops,
      total_crops: job.total_crops,
    };
  }

  const nextStep = (job.steps_state || []).find(
    (s) => s.status === "pending"
  );
  if (!nextStep) {
    // No pending step — finalize if not already done.
    await finalizeJob(admin, job);
    return {
      status: "done",
      done: true,
      completed_crops: job.completed_crops,
      total_crops: job.total_crops,
    };
  }
  const stepIndex = nextStep.index;
  const nowStart = new Date().toISOString();

  // Atomic-ish claim: rewrite steps_state so this index is 'processing'.
  // (Supabase doesn't give us a per-element atomic operation; we write
  // back the whole array. Two concurrent workers could race here, but
  // the UI only ever has one poller in flight at a time and the GET
  // endpoint's 90s stuck-step guard prevents double-fire under normal
  // conditions.)
  const claimedSteps = job.steps_state.map((s) =>
    s.index === stepIndex
      ? { ...s, status: "processing" as const, started_at: nowStart }
      : s
  );
  await admin
    .from("analyze_jobs")
    .update({
      steps_state: claimedSteps,
      phase: "extracting",
    })
    .eq("id", job.id);

  // 2. Per-step work — wrap so on any throw we mark THIS step failed
  // but keep the job alive (UI can offer a retry button).
  try {
    return await runStep(admin, job, stepIndex);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[analyze-job] step ${stepIndex} failed for job ${jobId}:`,
      msg
    );
    const failedSteps = claimedSteps.map((s) =>
      s.index === stepIndex
        ? {
            ...s,
            status: "failed" as const,
            completed_at: new Date().toISOString(),
            error: msg.slice(0, 500),
          }
        : s
    );
    await admin
      .from("analyze_jobs")
      .update({ steps_state: failedSteps })
      .eq("id", job.id);
    return {
      status: "processing",
      done: false,
      completed_crops: job.completed_crops,
      total_crops: job.total_crops,
      step: {
        index: stepIndex,
        child_doc_id: null,
        sender: nextStep.sender_hint ?? null,
        amount: nextStep.amount_hint ?? null,
        error: msg.slice(0, 500),
      },
    };
  }
}

async function runStep(
  admin: SupabaseClient,
  job: JobRow,
  stepIndex: number
): Promise<AnalyzeStepResult> {
  // Load the parent doc fresh — we need its full set of fields for
  // child inserts (storage_provider, file_name, content_hash, etc.).
  const { data: parentRaw } = await admin
    .from("documents")
    .select("*")
    .eq("id", job.document_id)
    .single();
  if (!parentRaw) {
    throw new Error("Parent document disappeared");
  }
  const parent = parentRaw as {
    id: string;
    user_id: string;
    dropbox_path: string;
    dropbox_shared_link: string | null;
    storage_provider: "dropbox" | "gdrive" | "onedrive" | "s3" | "local";
    file_name: string | null;
    file_size_bytes: number | null;
    content_hash: string | null;
    file_type: string | null;
    primary_profile_id: number | null;
    extracted_fields: Record<string, unknown> | null;
    tags: string[] | null;
  };

  const storage = getStorage(parent.storage_provider);
  const cropPath = job.payload.crop_paths[stepIndex] || job.payload.original_path;

  // Download the crop, then re-extract via Sonnet at full resolution.
  const cropBuffer = await storage.downloadFile(cropPath);
  const taxonomySnapshot = await loadTaxonomySnapshot(admin, job.user_id);
  const taxonomyHint = buildTaxonomyHint(taxonomySnapshot);

  console.log(
    `[analyze-job] step ${stepIndex + 1}/${job.total_crops}: extracting ${cropPath}`
  );
  const ex = await extractDocument(
    cropBuffer,
    `${parent.file_name || "crop"}_part${stepIndex + 1}.jpg`,
    { taxonomyHint }
  );
  const d = ex.data;
  if (!d || "error" in d || isMultiDoc(d)) {
    // Per-crop extraction blew up. Fall back to the detection snapshot
    // (sender/amount only) so we still spawn a row with the user-visible
    // hints — better than failing the whole step. Caller can re-trigger
    // a per-crop re-extract from the UI later.
    const hint = job.payload.detected_docs[stepIndex];
    // DocumentExtraction requires document_type:string + confidence:number,
    // so fill in safe defaults; the child row update logic below tolerates
    // null/empty values gracefully and the user can refile from the UI.
    const fallback: DocumentExtraction = {
      document_type: "other",
      document_subtype: null,
      confidence: 0,
      document_date: hint?.document_date || null,
      sender: hint?.sender || null,
      recipient: null,
      language: null,
      profile_hint: null,
      amount: hint?.amount ?? null,
      currency: null,
      purchase_category: null,
      title: hint?.summary || null,
      summary: hint?.summary || null,
      tags: [],
      extracted_fields: {},
      ocr_text: undefined,
      needs_action: false,
      action_type: null,
      due_date: null,
      action_summary: null,
    };
    return finishStep(admin, job, stepIndex, parent, cropPath, fallback, true);
  }
  return finishStep(
    admin,
    job,
    stepIndex,
    parent,
    cropPath,
    d as DocumentExtraction,
    false
  );
}

/**
 * Persist the per-crop extraction + advance the job. For step index 0,
 * the parent doc itself gets updated. For step index > 0, a new child
 * doc row is inserted (parent_document_id = parent.id). When this is
 * the last step, the dedup-on-resplit cleanup runs and the job flips
 * to 'done'.
 */
async function finishStep(
  admin: SupabaseClient,
  job: JobRow,
  stepIndex: number,
  parent: {
    id: string;
    user_id: string;
    dropbox_path: string;
    dropbox_shared_link: string | null;
    storage_provider: "dropbox" | "gdrive" | "onedrive" | "s3" | "local";
    file_name: string | null;
    file_size_bytes: number | null;
    content_hash: string | null;
    file_type: string | null;
    primary_profile_id: number | null;
    extracted_fields: Record<string, unknown> | null;
    tags: string[] | null;
  },
  cropPath: string,
  extraction: DocumentExtraction,
  isFallback: boolean
): Promise<AnalyzeStepResult> {
  const now = new Date().toISOString();
  let childDocId: string | null = null;

  // payment_status overrides (mirror inline analyze route).
  const ef = extraction.extracted_fields || {};
  const paymentStatus = String(
    (ef as Record<string, unknown>)["payment_status"] || ""
  ).toLowerCase();
  const isPaid = paymentStatus === "paid";
  const isUnpaid =
    paymentStatus === "unpaid" || paymentStatus === "partial";
  const needsAction = isPaid
    ? false
    : isUnpaid
      ? true
      : !!extraction.needs_action;
  const actionType =
    extraction.action_type || (needsAction ? "pay" : null);

  {
    // EVERY step inserts a new CHILD doc row. The parent never gets
    // repurposed as receipt #1 anymore — it stays as the container
    // (its dropbox_path keeps pointing at the original full scan).
    // finalizeJob() updates the parent's container metadata once all
    // steps have completed.
    let shareLink: string | null = parent.dropbox_shared_link;
    try {
      const storage = getStorage(parent.storage_provider);
      shareLink = await storage.getOrCreateShareLink(cropPath);
    } catch (e) {
      console.warn(
        `[analyze-job] share link for child crop ${stepIndex + 1} failed`,
        e
      );
    }
    const childInsert = {
      user_id: parent.user_id,
      dropbox_path: cropPath,
      dropbox_shared_link: shareLink,
      storage_provider: parent.storage_provider,
      file_name: parent.file_name,
      file_size_bytes: parent.file_size_bytes,
      content_hash: parent.content_hash,
      file_type: parent.file_type,
      parent_document_id: parent.id,
      // No per-child profile re-rank here — keep the prepare cheap.
      // The user can refile any child individually if the parent's
      // profile doesn't fit. (The inline route does run suggestProfile
      // per child; we skip it to keep the per-step budget < 30s.)
      primary_profile_id: parent.primary_profile_id,
      document_type: extraction.document_type || null,
      document_subtype: extraction.document_subtype || null,
      confidence: extraction.confidence ?? null,
      document_date: extraction.document_date || null,
      sender: extraction.sender || null,
      recipient: extraction.recipient || null,
      person: extraction.profile_hint || null,
      language: extraction.language || null,
      amount: extraction.amount ?? null,
      currency: extraction.currency || null,
      purchase_category: extraction.purchase_category || null,
      title: extraction.title || null,
      summary: extraction.summary || null,
      tags: extraction.tags || [],
      extracted_fields: extraction.extracted_fields || {},
      ocr_text: extraction.ocr_text || null,
      needs_action: needsAction,
      action_type: needsAction ? actionType : null,
      due_date: extraction.due_date || null,
      action_summary: needsAction ? extraction.action_summary || null : null,
      status: "processed",
      needs_review: false,
      review_notes: isFallback
        ? "Multi-doc child: per-crop extraction failed; populated from detection summary only. Re-analyse this row to retry."
        : null,
    };
    const { data: insRow, error: insErr } = await admin
      .from("documents")
      .insert(childInsert)
      .select("id")
      .single();
    if (insErr) throw insErr;
    childDocId = (insRow as { id: string }).id;

    // Spawn the child's action row if needed.
    if (needsAction && extraction.action_summary && actionType) {
      try {
        await admin.from("actions").insert({
          user_id: parent.user_id,
          document_id: childDocId,
          profile_id: parent.primary_profile_id,
          action_type: actionType,
          summary: extraction.action_summary,
          due_date: extraction.due_date || null,
          status: "open",
        });
      } catch (e) {
        console.warn("[analyze-job] child action insert failed", e);
      }
    }
  }

  // Advance job state — mark this step done, bump completed_crops.
  const updatedSteps = job.steps_state.map((s) =>
    s.index === stepIndex
      ? {
          ...s,
          status: "done" as const,
          completed_at: now,
          child_doc_id: childDocId,
        }
      : s
  );
  const newCompleted = job.completed_crops + 1;
  const allDone = newCompleted >= job.total_crops;

  await admin
    .from("analyze_jobs")
    .update({
      steps_state: updatedSteps,
      completed_crops: newCompleted,
      phase: allDone ? "finalising" : "extracting",
    })
    .eq("id", job.id);

  if (allDone) {
    // Last step done → run the dedup-on-resplit cleanup and flip status.
    await finalizeJob(admin, {
      ...job,
      steps_state: updatedSteps,
      completed_crops: newCompleted,
    });
  }

  return {
    status: allDone ? "done" : "processing",
    done: allDone,
    completed_crops: newCompleted,
    total_crops: job.total_crops,
    step: {
      index: stepIndex,
      child_doc_id: childDocId,
      sender: extraction.sender || null,
      amount: extraction.amount ?? null,
    },
  };
}

/**
 * Final cleanup: when every step is done, remove any OLD children that
 * existed before this re-split and were NOT spawned by this job. Match
 * the inline analyze route's dedup-on-resplit behaviour.
 *
 * Safe to call more than once — it queries against current child_doc_ids
 * in steps_state and only deletes children outside that set.
 */
async function finalizeJob(
  admin: SupabaseClient,
  job: {
    id: string;
    document_id: string;
    user_id: string;
    steps_state: StepState[];
    completed_crops: number;
    total_crops: number;
    payload?: JobPayload;
  }
): Promise<void> {
  // Skip if already done (idempotent re-runs from the GET-route auto-kick).
  const { data: cur } = await admin
    .from("analyze_jobs")
    .select("status, payload")
    .eq("id", job.id)
    .maybeSingle();
  if (cur && (cur as { status: string }).status === "done") return;
  // Use the freshly-read payload if the caller didn't pass one.
  const payload =
    job.payload || (cur as { payload?: JobPayload } | null)?.payload;

  // Spawned child IDs — every step's child_doc_id (the parent is NOT
  // in this set; it's the container, kept and updated below).
  const spawnedIds = new Set<string>();
  for (const s of job.steps_state) {
    if (s.child_doc_id) spawnedIds.add(s.child_doc_id);
  }

  // 1. Dedup-on-resplit: delete any OLD child rows that aren't part of
  //    this job's spawned set (and their actions).
  try {
    const { data: existingKids } = await admin
      .from("documents")
      .select("id")
      .eq("parent_document_id", job.document_id);
    const stale = (existingKids || [])
      .map((r) => (r as { id: string }).id)
      .filter((id) => !spawnedIds.has(id));
    if (stale.length > 0) {
      await admin.from("actions").delete().in("document_id", stale);
      await admin.from("documents").delete().in("id", stale);
      console.log(
        `[analyze-job] deleted ${stale.length} stale child doc(s) after re-split for ${job.document_id}`
      );
    }
  } catch (e) {
    console.warn("[analyze-job] dedup-on-resplit cleanup failed:", e);
  }

  // 2. Reset parent to "container" state. The parent represents the
  //    ORIGINAL full multi-receipt scan, not any one receipt on it.
  //    Aggregate sender/amount/date from the spawned children so the
  //    parent's metadata reflects the whole scan at a glance.
  try {
    const childIds = Array.from(spawnedIds);
    let aggregateSender: string | null = null;
    let aggregateAmount: number | null = null;
    let aggregateDate: string | null = null;
    let aggregateCurrency: string | null = null;
    if (childIds.length > 0) {
      const { data: kidsRaw } = await admin
        .from("documents")
        .select("sender, amount, currency, document_date")
        .in("id", childIds);
      const kids = (kidsRaw || []) as Array<{
        sender: string | null;
        amount: number | null;
        currency: string | null;
        document_date: string | null;
      }>;
      // Sender: if all children agree, use it; else null.
      const senders = new Set(
        kids.map((k) => (k.sender || "").trim()).filter(Boolean)
      );
      if (senders.size === 1) aggregateSender = Array.from(senders)[0];
      // Amount: sum of all child amounts (so the inbox shows total spend
      // on this scan at a glance).
      const amounts = kids
        .map((k) => k.amount)
        .filter((a): a is number => typeof a === "number");
      if (amounts.length > 0) {
        aggregateAmount = amounts.reduce((s, n) => s + n, 0);
      }
      // Currency: if children agree.
      const currencies = new Set(
        kids.map((k) => (k.currency || "").trim()).filter(Boolean)
      );
      if (currencies.size === 1) aggregateCurrency = Array.from(currencies)[0];
      // Date: most recent across children (or null if none have dates).
      const dates = kids
        .map((k) => k.document_date)
        .filter((d): d is string => !!d)
        .sort();
      if (dates.length > 0) aggregateDate = dates[dates.length - 1];
    }

    // Container title — concise and identifiable in the inbox listing.
    const n = job.total_crops;
    const title = aggregateSender
      ? `${aggregateSender} — ${n}-receipt scan`
      : `Multi-receipt scan (${n} receipts)`;
    const summary = aggregateAmount != null
      ? `${n} receipts on one scan totalling ${aggregateCurrency || "EUR"} ${aggregateAmount.toFixed(2)}.`
      : `${n} receipts detected on one scan.`;

    const originalPath = payload?.original_path || null;
    const polygons =
      Array.isArray(payload?.polygons) && payload.polygons.length > 0
        ? payload.polygons
        : null;

    // Look up current parent row so we can preserve user-set fields
    // (primary_profile_id, tags they added, etc.) where reasonable.
    const { data: parentRow } = await admin
      .from("documents")
      .select("extracted_fields, primary_profile_id, dropbox_path, file_name")
      .eq("id", job.document_id)
      .maybeSingle();
    const existingEf = (parentRow?.extracted_fields ||
      {}) as Record<string, unknown>;

    // Drop receipt-specific fields from extracted_fields — the parent
    // is a container, not a receipt. Keep only multidoc / system flags.
    const containerEf: Record<string, unknown> = {
      _is_multidoc_container: true,
      _child_count: n,
      ...(originalPath ? { _original_scan_path: originalPath } : {}),
      ...(polygons ? { _multidoc: { polygons, total: n } } : {}),
    };
    // Preserve any other system-level flags the user/system might have
    // set on this row (anything starting with _ that we don't recognise).
    for (const [k, v] of Object.entries(existingEf)) {
      if (
        k.startsWith("_") &&
        !["_is_multidoc_container", "_child_count", "_original_scan_path", "_multidoc"].includes(k)
      ) {
        containerEf[k] = v;
      }
    }

    const parentUpdates: Record<string, unknown> = {
      // Reset dropbox_path back to the original full scan — overrides
      // the old _part1.jpg pointer from the previous architecture.
      dropbox_path: originalPath || parentRow?.dropbox_path || null,
      document_type: "multi_doc_scan",
      document_subtype: null,
      title,
      summary,
      sender: aggregateSender,
      amount: aggregateAmount,
      currency: aggregateCurrency,
      document_date: aggregateDate,
      purchase_category: null,
      // Container has no line items or OCR text of its own.
      ocr_text: null,
      tags: [],
      needs_action: false,
      action_type: null,
      due_date: null,
      action_summary: null,
      extracted_fields: containerEf,
      status: "processed",
      needs_review: false,
    };
    const { error: parentErr } = await admin
      .from("documents")
      .update(parentUpdates)
      .eq("id", job.document_id);
    if (parentErr) {
      console.warn("[analyze-job] parent container update failed:", parentErr);
    }
  } catch (e) {
    console.warn("[analyze-job] container metadata update failed:", e);
  }

  // 3. Activity log entry — mirrors the inline route's multi_doc_split log.
  try {
    const childIds = job.steps_state
      .filter((s) => s.child_doc_id)
      .map((s) => s.child_doc_id as string);
    await admin.from("maintenance_log").insert({
      user_id: job.user_id,
      document_id: job.document_id,
      kind: "multi_doc_split",
      reason: `Re-analyse full scan: split into ${job.total_crops} documents`,
      payload: {
        parent_document_id: job.document_id,
        child_document_ids: childIds,
        total_count: job.total_crops,
        via: "analyze_job",
      },
    });
  } catch (e) {
    console.warn("[analyze-job] multi_doc_split log insert failed", e);
  }

  await admin
    .from("analyze_jobs")
    .update({
      status: "done",
      phase: "done",
    })
    .eq("id", job.id);
}
