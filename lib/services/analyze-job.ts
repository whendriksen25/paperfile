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
 * Retry a Dropbox (or any storage) call on transient errors. The 409
 * conflicts and occasional 5xx we see during a busy multi-crop job are
 * usually momentary — a short backoff clears them. Non-transient errors
 * (404 missing file, auth) are re-thrown immediately so we don't waste
 * the per-step budget retrying something that won't succeed.
 */
async function withDropboxRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Transient if it mentions 409 (conflict), 429 (rate), or 5xx.
      const transient = /\b(409|429|5\d\d)\b/.test(msg) ||
        /conflict|too many requests|temporarily/i.test(msg);
      if (!transient || attempt === maxAttempts) {
        throw e;
      }
      const backoffMs = 400 * attempt;
      console.warn(
        `[analyze-job] ${label} attempt ${attempt} failed (${msg.slice(0, 80)}); retrying in ${backoffMs}ms`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

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
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
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
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
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
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
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
  // 4a. Polygon cleanup: drop phantom small detections (<3% area), then
  // resolve pairwise overlaps via midpoint-split. Catches Sonnet's two
  // common mis-detections: a tiny 5th "receipt" that isn't really there,
  // and polygon edges that overlap neighbours (causing bleed-through
  // into adjacent crops).
  const { cleanupPolygonsForCropping } = await import(
    "@/lib/services/image-crop"
  );
  const cleaned = cleanupPolygonsForCropping(
    detect.polygons,
    detect.documents
  );
  const docs = cleaned.documents;
  const polygons = cleaned.polygons;
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

  // 5b. CLEAN SLATE: delete any existing children of this parent (and their
  //     actions) BEFORE re-splitting. Re-analyse REPLACES the receipt set, so
  //     wiping first prevents children from prior runs — or interrupted /
  //     cancelled jobs whose finalize never ran — from accumulating as
  //     duplicates. The fresh children are spawned per-step below.
  try {
    const { data: oldKids } = await admin
      .from("documents")
      .select("id")
      .eq("parent_document_id", documentId);
    const oldIds = (oldKids || []).map((r) => (r as { id: string }).id);
    if (oldIds.length > 0) {
      await admin.from("actions").delete().in("document_id", oldIds);
      await admin.from("documents").delete().in("id", oldIds);
      console.log(
        `[analyze-job] cleared ${oldIds.length} existing child doc(s) before re-split for ${documentId}`
      );
    }
  } catch (e) {
    console.warn("[analyze-job] pre-split child cleanup failed:", e);
  }

  // 6. Crop + upload — CV method, OVERLAPS ALLOWED. Detection gave a rough
  // centre per receipt; classical CV (connected components → oriented edge
  // box with trimmed extents) turns each into a tight box. We crop the
  // axis-aligned box with generous padding and NO seam-clipping, so a crop
  // never clips a receipt (neighbour bleed is fine). Each crop is stored as
  // {stem}_part{i+1}{ext} alongside the original and becomes that receipt's
  // own image; the per-receipt step then re-extracts it at full resolution
  // (the only way to read small line-item print reliably). Only images can
  // be cropped (sharp can't open PDFs) — PDFs fall through to the shared
  // image per step.
  const isImage = /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(
    doc.file_name || ""
  );
  const cropPaths: string[] = [];
  if (isImage && polygons.length === docs.length && polygons.length > 0) {
    try {
      const sharpMod = await import("sharp");
      const sharp = sharpMod.default || sharpMod;
      const meta = await sharp(buffer).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      const padFrac = 0.06;

      // Crop boxes. Preferred = the pure-JS connected-components segmentation
      // (threshold the bright paper → label the white blobs → box each
      // receipt). It snaps each crop to the actual receipt blob the LLM seed
      // sits in, which is far tighter + more accurate than the raw LLM box,
      // and it's pure JavaScript (no WASM) so it can't hang. If it fails or a
      // given seed doesn't resolve to a blob, we fall back to that seed's
      // rough polygon bounding box.
      let boxes: Array<{ x: number; y: number; width: number; height: number } | null> =
        docs.map(() => null);
      try {
        const seeds = polygons.map((p) => {
          const vs = Array.isArray(p.vertices) ? p.vertices : [];
          let sx = 0,
            sy = 0;
          for (const v of vs) {
            sx += Number(v.x) || 0;
            sy += Number(v.y) || 0;
          }
          const k = vs.length || 1;
          return { x: sx / k, y: sy / k };
        });
        const { segmentReceiptBoxes } = await import(
          "@/lib/services/receipt-segmentation"
        );
        boxes = await segmentReceiptBoxes(buffer, seeds, { padFrac });
      } catch (e) {
        console.warn(
          "[analyze-job] CC segmentation failed — using polygon-bbox crops:",
          e instanceof Error ? e.message : String(e)
        );
      }

      // Fallback box for receipt i: the polygon's axis-aligned bounding box
      // (normalised → px) + generous padding, clamped to the image.
      const polyBox = (i: number) => {
        const vs = Array.isArray(polygons[i]?.vertices)
          ? polygons[i].vertices
          : [];
        if (!vs.length || !W || !H) return null;
        let minx = 1,
          miny = 1,
          maxx = 0,
          maxy = 0;
        for (const v of vs) {
          const x = Math.min(1, Math.max(0, Number(v.x) || 0));
          const y = Math.min(1, Math.max(0, Number(v.y) || 0));
          minx = Math.min(minx, x);
          miny = Math.min(miny, y);
          maxx = Math.max(maxx, x);
          maxy = Math.max(maxy, y);
        }
        let x0 = minx * W,
          y0 = miny * H,
          x1 = maxx * W,
          y1 = maxy * H;
        const pad = padFrac * Math.max(x1 - x0, y1 - y0);
        x0 = Math.max(0, Math.floor(x0 - pad));
        y0 = Math.max(0, Math.floor(y0 - pad));
        x1 = Math.min(W, Math.ceil(x1 + pad));
        y1 = Math.min(H, Math.ceil(y1 + pad));
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      };

      for (let i = 0; i < docs.length; i++) {
        const cv = boxes[i];
        const b = cv && cv.width >= 40 && cv.height >= 40 ? cv : polyBox(i);
        if (!b || b.width < 40 || b.height < 40) continue; // gap-filled below
        try {
          const cropBuf = await sharp(buffer)
            .extract({ left: b.x, top: b.y, width: b.width, height: b.height })
            .jpeg({ quality: 92 })
            .toBuffer();
          const cropPath = buildCropPath(downloadPath, i);
          await storage.uploadAt({ buffer: cropBuf, path: cropPath });
          cropPaths[i] = cropPath;
        } catch (e) {
          console.warn(
            `[analyze-job] crop ${i + 1} failed, will use shared image:`,
            e instanceof Error ? e.message : String(e)
          );
        }
      }
    } catch (e) {
      console.warn(
        "[analyze-job] crop step failed — every step will use the shared image:",
        e
      );
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

  if (
    job.status === "done" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    // Terminal states — including user cancellation — do no further
    // work. Any children already spawned are left in place.
    return {
      status: job.status,
      done: job.status === "done",
      completed_crops: job.completed_crops,
      total_crops: job.total_crops,
    };
  }

  // Hang recovery: before picking a new step, look for steps that
  // claim to be "processing" but have been stuck for >120s. Vercel kills
  // the worker function at 60s, so any step that hasn't completed in
  // 120s is dead — we mark it failed so the job can finish (the user
  // can retry that one step from the UI). Without this, a hung step
  // leaves the job in 'processing' forever and the live progress UI
  // just spins.
  const STUCK_TIMEOUT_MS = 120_000;
  const nowMs = Date.now();
  const recoveredSteps = (job.steps_state || []).map((s) => {
    if (s.status === "processing" && s.started_at) {
      const age = nowMs - new Date(s.started_at).getTime();
      if (age > STUCK_TIMEOUT_MS) {
        console.warn(
          `[analyze-job] step ${s.index} stuck for ${Math.round(age / 1000)}s — marking failed`
        );
        return {
          ...s,
          status: "failed" as const,
          completed_at: new Date(nowMs).toISOString(),
          error: `Worker timeout (>${STUCK_TIMEOUT_MS / 1000}s)`,
        };
      }
    }
    return s;
  });
  const recoveredCount = recoveredSteps.filter(
    (s, i) => job.steps_state[i].status !== s.status
  ).length;
  if (recoveredCount > 0) {
    // Increment completed_crops so the job's progress accounting reflects
    // the failed-as-completed steps (otherwise we never reach total_crops
    // and the job never finalizes).
    const newCompleted = recoveredSteps.filter(
      (s) => s.status === "done" || s.status === "failed"
    ).length;
    await admin
      .from("analyze_jobs")
      .update({
        steps_state: recoveredSteps,
        completed_crops: newCompleted,
      })
      .eq("id", job.id);
    job.steps_state = recoveredSteps;
    job.completed_crops = newCompleted;
  }

  const nextStep = (job.steps_state || []).find(
    (s) => s.status === "pending"
  );
  if (!nextStep) {
    // No pending step. Two sub-cases:
    //   - Some step is still 'processing' (recovery didn't fire because
    //     it wasn't yet at 120s). Don't finalize — wait for the next
    //     poll, by which point the recovery will mark it failed.
    //   - All steps are 'done' or 'failed' → ready to finalize.
    const stillInFlight = (job.steps_state || []).some(
      (s) => s.status === "processing"
    );
    if (stillInFlight) {
      return {
        status: "processing",
        done: false,
        completed_crops: job.completed_crops,
        total_crops: job.total_crops,
      };
    }
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

  // Download the crop (with retry on transient Dropbox errors), then
  // downsize before extraction so Sonnet responds quickly enough to fit
  // the per-step 60s Hobby budget.
  let cropBuffer = await withDropboxRetry(
    () => storage.downloadFile(cropPath),
    `download crop ${stepIndex + 1}`
  );

  // Downsize to ~1600px on the long edge. Receipt text stays legible at
  // that size, but the smaller image meaningfully cuts Sonnet's response
  // time — the difference between fitting and blowing the 60s budget on
  // a slow day. Defensive: any sharp failure keeps the original buffer.
  try {
    const sharpMod = await import("sharp");
    const sharp = sharpMod.default || sharpMod;
    cropBuffer = await sharp(cropBuffer)
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (e) {
    console.warn(
      "[analyze-job] crop downsize failed, using full-res:",
      e instanceof Error ? e.message : String(e)
    );
  }

  const taxonomySnapshot = await loadTaxonomySnapshot(admin, job.user_id);
  const taxonomyHint = buildTaxonomyHint(taxonomySnapshot);

  console.log(
    `[analyze-job] step ${stepIndex + 1}/${job.total_crops}: extracting ${cropPath}`
  );
  const ex = await extractDocument(
    cropBuffer,
    `${parent.file_name || "crop"}_part${stepIndex + 1}.jpg`,
    {
      taxonomyHint,
      // Re-enable the focused line-items fallback per step. The old
      // concern was that this SECOND call doubled wall-clock — but that
      // was when ONE call extracted the WHOLE multi-receipt scan. Now each
      // step is a SINGLE downsized (~1600px) receipt crop, so the first
      // extract is ~10-20s and the focused fallback ~7-10s — comfortably
      // inside the 60s per-step budget. Without this, receipts whose first
      // pass returns `line_items: []` (e.g. the small Ekoplaza receipt,
      // whose summary lists the items but the array came back empty) never
      // get their line items, even though they're clearly printed.
      disableLineItemRetry: false,
    }
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

  // IDEMPOTENCY GUARD (prevents duplicate children under worker races).
  // The job is driven by BOTH the per-step self-chain AND the GET-poll
  // auto-kick, and the per-step claim isn't truly atomic — so two workers
  // can extract the SAME step concurrently, or one worker can still be
  // mid-extraction when finalizeJob() flips the job to 'done'. Either way
  // a naive insert here spawns a duplicate child. Re-read the job FRESH
  // right before inserting and bail if:
  //   (a) the job already finalized/cancelled  → don't add a late dup, or
  //   (b) this step's slot already holds a live child (another worker beat
  //       us to it) → return that child instead of inserting a second.
  try {
    const { data: freshJob } = await admin
      .from("analyze_jobs")
      .select("status, steps_state")
      .eq("id", job.id)
      .maybeSingle();
    if (freshJob) {
      const fj = freshJob as { status: string; steps_state: StepState[] };
      if (
        fj.status === "done" ||
        fj.status === "failed" ||
        fj.status === "cancelled"
      ) {
        return {
          status: fj.status as AnalyzeStepResult["status"],
          done: fj.status === "done",
          completed_crops: job.completed_crops,
          total_crops: job.total_crops,
        };
      }
      const slot = (fj.steps_state || []).find((s) => s.index === stepIndex);
      if (slot && slot.status === "done" && slot.child_doc_id) {
        const { data: existingChild } = await admin
          .from("documents")
          .select("id")
          .eq("id", slot.child_doc_id)
          .maybeSingle();
        if (existingChild) {
          console.log(
            `[analyze-job] step ${stepIndex + 1} already completed by another worker — skipping duplicate insert`
          );
          return {
            status: "processing",
            done: false,
            completed_crops: job.completed_crops,
            total_crops: job.total_crops,
            step: {
              index: stepIndex,
              child_doc_id: slot.child_doc_id,
              sender: extraction.sender || null,
              amount: extraction.amount ?? null,
            },
          };
        }
      }
    }
  } catch (e) {
    // Best-effort guard — if the re-read fails, fall through to insert
    // (the finalize-time content-dedup remains a backstop).
    console.warn("[analyze-job] idempotency re-read failed:", e);
  }

  {
    // EVERY step inserts a new CHILD doc row. The parent never gets
    // repurposed as receipt #1 anymore — it stays as the container
    // (its dropbox_path keeps pointing at the original full scan).
    // finalizeJob() updates the parent's container metadata once all
    // steps have completed.
    let shareLink: string | null = parent.dropbox_shared_link;
    try {
      const storage = getStorage(parent.storage_provider);
      // Retry on transient 409/5xx — this share-link call is where the
      // step-2 Dropbox 409 conflict surfaced in the last run.
      shareLink = await withDropboxRetry(
        () => storage.getOrCreateShareLink(cropPath),
        `share link child crop ${stepIndex + 1}`
      );
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

  // Advance job state — mark THIS step done. Re-read the job FRESH first:
  // the per-step claim isn't atomic, so a sibling worker may have completed
  // a different step while we were extracting. Building the update from our
  // stale start-of-step snapshot would clobber that sibling's progress
  // (resetting its step to pending → re-claimed → duplicate child). Merge
  // onto the authoritative current array and recompute the counters from it.
  const { data: curJob } = await admin
    .from("analyze_jobs")
    .select("steps_state")
    .eq("id", job.id)
    .maybeSingle();
  const baseSteps: StepState[] =
    (curJob as { steps_state?: StepState[] } | null)?.steps_state ||
    job.steps_state;
  const updatedSteps = baseSteps.map((s) =>
    s.index === stepIndex
      ? {
          ...s,
          status: "done" as const,
          completed_at: now,
          child_doc_id: childDocId,
        }
      : s
  );
  const newCompleted = updatedSteps.filter(
    (s) => s.status === "done" || s.status === "failed"
  ).length;
  // Finalize only when EVERY step has reached a terminal state — never off a
  // stale +1 counter (which could trip finalize early and orphan a step).
  const allDone = updatedSteps.every(
    (s) => s.status === "done" || s.status === "failed"
  );

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

  // 1b. Content-dedup: two crops can land on the SAME physical receipt
  //     (overlapping seed boxes, or a non-atomic step re-claim). Those
  //     survive block 1 because both ids ARE in spawnedIds, yet they're
  //     the same receipt. Collapse children that share a strong content
  //     key, keeping the richest extraction. Only dedup when a key is
  //     actually present so genuinely-distinct receipts are never merged.
  try {
    const ids = Array.from(spawnedIds);
    if (ids.length > 1) {
      const { data: kidRowsRaw } = await admin
        .from("documents")
        .select(
          "id, sender, amount, currency, document_date, ocr_text, extracted_fields, review_notes, created_at"
        )
        .in("id", ids);
      type KidRow = {
        id: string;
        sender: string | null;
        amount: number | null;
        currency: string | null;
        document_date: string | null;
        ocr_text: string | null;
        extracted_fields: Record<string, unknown> | null;
        review_notes: string | null;
        created_at: string | null;
      };
      const kidRows = (kidRowsRaw || []) as KidRow[];

      // Strong explicit identifier if the AI captured one, else a
      // composite of sender+amount+currency+date. Returns "" when there
      // isn't enough to safely call two rows the same receipt.
      const dedupKey = (k: KidRow): string => {
        const ef = (k.extracted_fields || {}) as Record<string, unknown>;
        const refFields = [
          "transaction_reference",
          "transaction_id",
          "receipt_number",
          "receipt_id",
          "invoice_number",
        ];
        for (const f of refFields) {
          const v = ef[f];
          if (v != null && String(v).trim()) {
            return "ref:" + String(v).trim().toLowerCase();
          }
        }
        // Composite fallback — require an amount so two empty/fallback
        // rows don't collapse into one.
        if (typeof k.amount === "number") {
          return [
            "cmp",
            (k.sender || "").trim().toLowerCase(),
            k.amount.toFixed(2),
            (k.currency || "").trim().toLowerCase(),
            (k.document_date || "").trim(),
          ].join("|");
        }
        return "";
      };

      // Richness score — keep the most complete extraction in a group.
      const score = (k: KidRow): number => {
        let s = 0;
        if (!k.review_notes) s += 100; // not a fallback row
        s += (k.ocr_text || "").length / 100; // more OCR text = richer
        const ef = (k.extracted_fields || {}) as Record<string, unknown>;
        const li = ef["line_items"];
        if (Array.isArray(li)) s += li.length;
        return s;
      };

      const groups = new Map<string, KidRow[]>();
      for (const k of kidRows) {
        const key = dedupKey(k);
        if (!key) continue;
        const arr = groups.get(key);
        if (arr) arr.push(k);
        else groups.set(key, [k]);
      }

      const dupIds: string[] = [];
      for (const arr of Array.from(groups.values())) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => score(b) - score(a));
        // arr[0] is the keeper; the rest are duplicates.
        for (let i = 1; i < arr.length; i++) dupIds.push(arr[i].id);
      }

      if (dupIds.length > 0) {
        await admin.from("actions").delete().in("document_id", dupIds);
        await admin.from("documents").delete().in("id", dupIds);
        for (const id of dupIds) spawnedIds.delete(id);
        console.log(
          `[analyze-job] content-dedup removed ${dupIds.length} duplicate child doc(s) for ${job.document_id}`
        );
      }
    }
  } catch (e) {
    console.warn("[analyze-job] content-dedup failed:", e);
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
    // Use the SURVIVING child count (after dedup), not the raw crop count.
    const n = childIds.length || job.total_crops;
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
