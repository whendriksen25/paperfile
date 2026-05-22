import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import { DOCUMENT_EXTRACTION_PROMPT, buildExtractionPrompt } from "./prompts";
import {
  AI_MAX_TOKENS_DEFAULT,
  AI_MAX_TOKENS_EXTENDED,
  AI_EXTENDED_BETA_HEADER,
  AI_MODEL_SMART,
} from "./pricing";
import type { DocumentExtraction } from "@/types/document";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripCodeFence(s: string): string {
  if (!s) return s;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return s.trim();
}

/**
 * Slice out the first balanced {…} object in the string. Handles strings
 * with escaped quotes so braces inside string literals don't fool the
 * counter. Returns null if no balanced object is found.
 */
function extractFirstObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unterminated — likely truncated by max_tokens
}

/** Drop trailing commas before closing braces/brackets — common Claude tic. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Walk char-by-char and escape anything inside a string value that JSON.parse
 * would reject. Specifically: literal newlines, carriage returns, tabs, and
 * control characters under 0x20 — Claude sometimes preserves these literally
 * inside long ocr_text values, which JSON forbids.
 *
 * Operates only inside string contexts (between unescaped double quotes)
 * so structural JSON outside strings is untouched.
 */
function escapeControlCharsInStrings(s: string): string {
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "\t") {
        out += "\\t";
        continue;
      }
      if (code < 0x20) {
        // strip other control chars — JSON forbids them in strings
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * Repair Claude's "inline editorial commentary inside an array element"
 * tic, which produces JSON like:
 *   "handwritten_notes": ["Voldaan" - handwritten across the document]
 * The pattern is: a quoted string immediately followed by content that's
 * NOT valid JSON syntax (comma, close-bracket/brace, colon, whitespace),
 * eventually followed by a comma or close-bracket. We strip that trailing
 * commentary, keeping just the quoted string.
 *
 * Safe outside arrays too — the "must be followed by , or ] or }" lookahead
 * means we only match when the text is in an array element position.
 */
function repairArrayCommentary(s: string): string {
  return s.replace(
    // Group 1: a JSON string literal (handles \" escapes).
    // Then optional whitespace + a hyphen, em-dash, en-dash or open paren.
    // Then non-bracket/brace/comma chars (the commentary).
    // Lookahead: must be followed by a JSON terminator.
    /("(?:[^"\\]|\\.)*")\s*[-–—(][^,\]}]+(?=[,\]}])/g,
    "$1"
  );
}

/**
 * Replace smart double-quotes with regular ones GLOBALLY. Risk: corrupts
 * a string that legitimately contained a curly quote. In practice OCR
 * text rarely needs them, and the alternative (failed parse) is worse.
 */
function normalizeSmartQuotes(s: string): string {
  return s
    .replace(/[“”„‟″‶]/g, '"')
    .replace(/[‘’‚‛′‵]/g, "'")
    .replace(/^﻿/, ""); // strip BOM if present
}

/**
 * Try increasingly aggressive parses until one works. We prefer the
 * cleanest input but degrade gracefully:
 *  1. raw text
 *  2. text with code fence removed
 *  3. first balanced {…} sliced out
 *  4. that slice with trailing commas removed
 *  5. with smart quotes normalised
 *  6. with control chars escaped inside strings
 *  7. combo: smart-quote + control-char fix + trailing-comma strip
 * Returns null if everything fails (truncation, gibberish, etc.).
 */
function safeParseJSON(s: string): Record<string, unknown> | null {
  if (!s) return null;
  const fenced = stripCodeFence(s);
  const obj = extractFirstObject(s) || extractFirstObject(fenced);
  const candidates: Array<{ label: string; text: string }> = [
    { label: "raw", text: s },
    { label: "fenced", text: fenced },
  ];
  if (obj) {
    candidates.push({ label: "obj", text: obj });
    candidates.push({ label: "obj+stripCommas", text: stripTrailingCommas(obj) });
    candidates.push({ label: "obj+smartQuotes", text: normalizeSmartQuotes(obj) });
    candidates.push({ label: "obj+ctrlChars", text: escapeControlCharsInStrings(obj) });
    candidates.push({ label: "obj+arrayCommentary", text: repairArrayCommentary(obj) });
    candidates.push({
      label: "obj+all",
      text: stripTrailingCommas(
        repairArrayCommentary(
          escapeControlCharsInStrings(normalizeSmartQuotes(obj))
        )
      ),
    });
  }
  const errors: string[] = [];
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand.text);
      if (parsed && typeof parsed === "object")
        return parsed as Record<string, unknown>;
    } catch (e) {
      errors.push(`${cand.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Every candidate failed — log full diagnostics so the exact
  // malformation is visible in the server log, not just "parse failed".
  console.error(
    "[ai/extract] safeParseJSON: all candidates failed.\n" +
      `  raw length: ${s.length}\n` +
      errors.map((e) => `  ✗ ${e}`).join("\n") +
      `\n  --- full raw response ---\n${s}\n  --- end raw response ---`
  );
  return null;
}

type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/csv"
  | "text/plain";

function getMimeType(filename: string): SupportedMediaType {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, SupportedMediaType> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    // Text formats commonly exported by banks. Sent to Claude as plain
    // text rather than as an image/document — the extraction prompt is
    // format-agnostic and Claude reads tabular text just as well.
    ".csv": "text/csv",
    ".tsv": "text/csv",
    ".txt": "text/plain",
  };
  return map[ext] || "image/jpeg";
}

/**
 * Returned by extractDocument when Claude responded but the response
 * couldn't be parsed as JSON. Caller is expected to surface the raw
 * response in review_notes so a human can see what went wrong.
 */
export interface ExtractionFailure {
  error: "parse_failed";
  raw_text: string;
  stop_reason: string | null;
}

/**
 * Result envelope: extraction payload + usage metadata. Usage stays even
 * on failed parses so we can still surface the cost + flag truncation
 * to the user.
 *
 * `data` shape:
 *  - DocumentExtraction (single-doc scan, the 95% case)
 *  - { documents: DocumentExtraction[] } (multi-doc scan — e.g. 4
 *    receipts on one phone photo). The analyze route detects this and
 *    splits into separate DB rows.
 *  - ExtractionFailure (Claude responded but JSON parse failed)
 *  - null (empty/no response)
 */
export interface BoundingBox {
  /** All in normalised 0..1 image space, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A single 2D point in NORMALISED 0..1 image coordinates, top-left
 * origin. Used for polygon vertices returned by the multi-doc detection
 * prompt. */
export type Point = { x: number; y: number };

/** A polygon that hugs one receipt's perimeter. Vertices are listed
 * clockwise starting from the receipt's OWN top-left corner (i.e. the
 * corner with the printed header), even if the receipt is tilted on
 * the page. `rotation_estimate_degrees` is the receipt's tilt vs
 * upright: 0 = upright, positive = clockwise. Optional; the polygon
 * code can re-derive it from the longest edge if missing. */
export type ReceiptPolygon = {
  vertices: Point[];
  rotation_estimate_degrees?: number;
};

export interface MultiDocumentExtraction {
  documents: DocumentExtraction[];
  /** Polygons that hug each receipt's perimeter. Same length + index
   * as documents[]. Preferred form: handles tilted receipts on
   * cluttered backgrounds far better than axis-aligned rectangles. */
  polygons?: ReceiptPolygon[];
  /** Legacy / backward-compat form — axis-aligned rectangles. Older
   * prompt responses (and the manual diag script before the rewrite)
   * still emit this. The parser auto-converts to rectangular polygons
   * when only this is present. Same length + index as documents[]. */
  bounding_boxes?: BoundingBox[];
}

export type ExtractionData =
  | DocumentExtraction
  | MultiDocumentExtraction
  | ExtractionFailure;

export function isMultiDoc(
  d: ExtractionData | null
): d is MultiDocumentExtraction {
  return (
    !!d &&
    typeof d === "object" &&
    "documents" in d &&
    Array.isArray((d as MultiDocumentExtraction).documents)
  );
}

/**
 * Convert an axis-aligned BoundingBox to a 4-vertex rectangular
 * ReceiptPolygon, listed clockwise starting from top-left. Used when
 * Claude returned the legacy `bounding_boxes` field instead of the
 * preferred `polygons` field — the downstream cropper only needs to
 * understand polygons.
 */
export function bboxToPolygon(b: BoundingBox): ReceiptPolygon {
  const x = Math.max(0, Math.min(1, Number(b.x) || 0));
  const y = Math.max(0, Math.min(1, Number(b.y) || 0));
  const w = Math.max(0, Math.min(1 - x, Number(b.w) || 0));
  const h = Math.max(0, Math.min(1 - y, Number(b.h) || 0));
  return {
    vertices: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    // A bounding-box has no rotation hint; the polygon code falls back
    // to longest-edge geometry, which on a rectangle yields ~0°.
    rotation_estimate_degrees: 0,
  };
}

/**
 * In-place normalisation of a parsed multi-doc response:
 *   - If polygons[] is already present and length-matches documents[], keep as-is.
 *   - Otherwise, if bounding_boxes[] is present and length-matches, convert
 *     each box to a rectangular polygon and stash on polygons[].
 *   - Otherwise (neither present, or length mismatch), leave polygons
 *     undefined; the consumer will fall back to the shared-image
 *     extraction. Logs a warning so the case is visible in server logs.
 */
function normaliseMultiDocPolygons(m: MultiDocumentExtraction): void {
  const docCount = Array.isArray(m.documents) ? m.documents.length : 0;
  if (docCount === 0) return;
  // If polygons are already present and well-formed, leave them.
  if (
    Array.isArray(m.polygons) &&
    m.polygons.length === docCount &&
    m.polygons.every(
      (p) => p && Array.isArray(p.vertices) && p.vertices.length >= 3
    )
  ) {
    return;
  }
  // Try the legacy bounding_boxes form.
  if (
    Array.isArray(m.bounding_boxes) &&
    m.bounding_boxes.length === docCount
  ) {
    m.polygons = m.bounding_boxes.map(bboxToPolygon);
    console.log(
      `[ai/extract] multi-doc: converted ${m.bounding_boxes.length} bounding_boxes → polygons (legacy form)`
    );
    return;
  }
  if (docCount > 1) {
    console.warn(
      `[ai/extract] multi-doc with ${docCount} documents but no polygons AND no bounding_boxes (or count mismatch). Cropping will be skipped; the analyze pipeline will fall back to shared-image per-doc extractions.`
    );
  }
}

export interface ExtractResult {
  data: ExtractionData | null;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
  max_tokens_cap: number;
}

export interface ExtractOptions {
  /** Override the default 64k output cap. Pass AI_MAX_TOKENS_EXTENDED
   *  (~128k) for the "Retry full" path. */
  maxTokens?: number;
  /** When true, sends the Sonnet 4 extended-output beta header so the
   *  model is allowed to actually emit up to ~128k tokens. */
  useExtendedOutput?: boolean;
  /** Per-user taxonomy hint, built by lib/services/taxonomy.ts →
   *  buildTaxonomyHint(). Injected near the top of the prompt so Claude
   *  prefers reusing existing subcategory tokens instead of inventing
   *  drift (apple/apples/appel...). */
  taxonomyHint?: string;
  /** Internal flag — set by extractDocument when re-invoking itself
   *  after an empty-line_items first response. Prepends a stricter
   *  "enumerate every printed line item" preface to the prompt and
   *  guards against infinite recursion. Callers should NEVER set this. */
  __isRetry?: boolean;
  /** When true, skip the auto-retry on empty line_items. Set by the
   *  multi-doc job worker because each per-crop step has a 60s Vercel
   *  budget — a second call doubles the time and can blow the budget.
   *  Single-doc synchronous callers leave this false to keep the retry
   *  safety net for marginal-quality receipts. */
  disableLineItemRetry?: boolean;
}

export async function extractDocument(
  fileBuffer: Buffer,
  filename: string,
  opts: ExtractOptions = {}
): Promise<ExtractResult> {
  console.log("[ai/extract] starting extraction for:", filename);

  const mimeType = getMimeType(filename);

  const basePrompt = buildExtractionPrompt(opts.taxonomyHint);
  const promptText = opts.__isRetry
    ? `RETRY: the previous extraction returned an empty line_items array, but this is a receipt-style document so there ARE printed line items on it. Look more carefully — every printed line that shows an item being purchased (item name, optionally with price and quantity) MUST be in line_items. Even if the print quality is marginal and you can't read every digit, include the item name with whatever you can read. Empty line_items is the wrong answer for this document type.\n\n${basePrompt}`
    : basePrompt;
  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: promptText },
  ];

  if (mimeType === "text/csv" || mimeType === "text/plain") {
    // CSV (or any plain-text export) — drop the raw text in as a second
    // text block. Cheaper + more accurate than asking Claude to OCR a
    // PDF rendering of the same data. Works for any bank's CSV layout
    // since the prompt asks for canonical fields by NAME, not by column.
    const raw = fileBuffer.toString("utf8");
    contentBlocks.push({
      type: "text",
      text: `Below is the raw text export of the document (likely CSV from a bank). Extract per the schema above.\n\n---\n${raw}\n---`,
    });
  } else if (mimeType === "application/pdf") {
    const base64Data = fileBuffer.toString("base64");
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64Data,
      },
    } as unknown as Anthropic.ContentBlockParam);
  } else {
    const base64Data = fileBuffer.toString("base64");
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: base64Data,
      },
    });
  }

  const maxTokens = opts.maxTokens ?? AI_MAX_TOKENS_DEFAULT;
  const useExtended =
    opts.useExtendedOutput || maxTokens > AI_MAX_TOKENS_DEFAULT;
  // IMPORTANT: must use streaming, not messages.create(). With a 64k+
  // max_tokens, Sonnet's worst-case response time exceeds 10 minutes,
  // and the SDK's non-streaming guard throws ("Streaming is strongly
  // recommended for operations that may take longer than 10 minutes")
  // BEFORE the request is even sent — so every extraction failed.
  // .stream() has no such guard; .finalMessage() returns the identical
  // Message object once the stream completes, so everything downstream
  // (content, stop_reason, usage) is unchanged.
  const stream = client.messages.stream(
    {
      model: AI_MODEL_SMART,
      // Default 64k tokens covers ~250-transaction bank statements,
      // ~80 pages of dense text, any realistic receipt/invoice.
      // Caller can opt into the 128k extended cap (with the beta header)
      // via opts.maxTokens + opts.useExtendedOutput — used by the
      // "Retry full" path after a truncation.
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: contentBlocks }],
    },
    useExtended
      ? { headers: { "anthropic-beta": AI_EXTENDED_BETA_HEADER } }
      : undefined
  );
  const response = await stream.finalMessage();

  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = safeParseJSON(rawText);

  console.log(
    "[ai/extract] complete:",
    filename,
    "stop:",
    response.stop_reason,
    "in:",
    response.usage?.input_tokens,
    "out:",
    response.usage?.output_tokens,
    "parsed?",
    !!parsed
  );

  const usage = {
    input_tokens: response.usage?.input_tokens || 0,
    output_tokens: response.usage?.output_tokens || 0,
  };

  if (parsed) {
    // The parsed JSON is either a single DocumentExtraction OR a
    // { documents: [...] } multi-doc wrapper. The type guard `isMultiDoc`
    // in callers picks them apart. We just cast — both shapes are valid.
    // For multi-doc responses, normalise the polygons / bounding_boxes
    // pair so downstream code only ever needs to look at `polygons`.
    const maybeMulti = parsed as Record<string, unknown>;
    const isMultiDocShape =
      !!maybeMulti &&
      Array.isArray(maybeMulti["documents"]) &&
      (maybeMulti["documents"] as unknown[]).length > 0;
    if (isMultiDocShape) {
      normaliseMultiDocPolygons(
        maybeMulti as unknown as MultiDocumentExtraction
      );
    }

    // ---- Line-items improvement (image receipts only) ----
    // Two focused stages, both gated to receipt-shaped image docs and
    // skipped on retry / when disabled / on doc types that don't have
    // line items (contracts, IDs, ...):
    //
    //   STAGE 1 — FILL. Pattern we hit in production: Sonnet returns the
    //     basic fields (sender, amount, date) but `line_items: []` even
    //     though items are clearly printed (the full prompt's "you may
    //     omit line_items" escape hatch + heavy per-line schema makes it
    //     skip them on marginal crops). When empty, a focused stripped
    //     prompt (name/qty/price only) reliably reads what's there.
    //
    //   STAGE 2 — RECONCILE. line_items are present but don't sum to the
    //     receipt total → some line was missed or misread. Fire a focused
    //     pass that is TOLD the gap (e.g. "you have €14.27 of €17.79,
    //     ~€3.52 is missing") and asked ONLY for the missing lines. Append
    //     them only if they bring the sum CLOSER to the total — that guard
    //     rejects a retry that just duplicated an existing line (which
    //     would overshoot and increase the error). Never makes it worse.
    //
    // Both stages keep sender/amount/date from the first call untouched.
    // Recursion is impossible (the helpers are standalone calls, not
    // extractDocument), but we still respect opts.__isRetry as a kill switch.
    let liInTokens = 0;
    let liOutTokens = 0;
    if (
      !isMultiDocShape &&
      mimeType.startsWith("image/") &&
      !opts.__isRetry &&
      !opts.disableLineItemRetry &&
      lineItemsExpected(parsed)
    ) {
      const orig = parsed as Record<string, unknown>;
      const ef = (orig["extracted_fields"] as Record<string, unknown>) || {};
      let items: Array<Record<string, unknown>> = Array.isArray(ef["line_items"])
        ? (ef["line_items"] as Array<Record<string, unknown>>)
        : [];

      const lineTotal = (it: Record<string, unknown>): number | null => {
        const t = it["total"];
        if (typeof t === "number" && Number.isFinite(t)) return t;
        // Focused/missing items carry `price` as the line amount.
        const p = it["price"];
        return typeof p === "number" && Number.isFinite(p) ? p : null;
      };
      const sumOf = (arr: Array<Record<string, unknown>>): number =>
        arr.reduce((s, it) => s + (lineTotal(it) ?? 0), 0);
      // Basic {name,price,quantity} → display schema the UI reads.
      const toRow = (x: {
        name: string;
        price: number | null;
        quantity: number;
      }): Record<string, unknown> => ({
        description: x.name,
        total: x.price,
        quantity: x.quantity,
        category: null,
      });

      // STAGE 1 — fill empties.
      if (items.length === 0) {
        console.log(
          "[ai/extract] empty line_items — firing focused line-items fallback"
        );
        const filled = await extractLineItemsFocused(
          fileBuffer,
          mimeType,
          opts.taxonomyHint
        );
        liInTokens += filled.usage.input_tokens;
        liOutTokens += filled.usage.output_tokens;
        if (filled.line_items.length > 0) items = filled.line_items.map(toRow);
      }

      // STAGE 2 — reconcile against the receipt total.
      const receiptTotal =
        typeof orig["amount"] === "number" && Number.isFinite(orig["amount"])
          ? (orig["amount"] as number)
          : null;
      const numWithTotal = items.filter((it) => lineTotal(it) != null).length;
      if (items.length > 0 && receiptTotal != null && numWithTotal > 0) {
        const sum = sumOf(items);
        const tol = Math.max(0.02, Math.abs(receiptTotal) * 0.005);
        if (Math.abs(sum - receiptTotal) > tol) {
          console.log(
            `[ai/extract] line-items short by ${(receiptTotal - sum).toFixed(2)} ` +
              `(have ${sum.toFixed(2)} of ${receiptTotal.toFixed(2)}) — firing reconcile retry`
          );
          const missing = await extractMissingLineItems(fileBuffer, mimeType, {
            existing: items.map((it) => ({
              name: String(it["description"] ?? it["name"] ?? "").trim(),
              total: lineTotal(it),
            })),
            foundSum: sum,
            receiptTotal,
            currency:
              typeof orig["currency"] === "string"
                ? (orig["currency"] as string)
                : null,
          });
          liInTokens += missing.usage.input_tokens;
          liOutTokens += missing.usage.output_tokens;
          if (missing.line_items.length > 0) {
            const merged = items.concat(missing.line_items.map(toRow));
            const newSum = sumOf(merged);
            if (Math.abs(newSum - receiptTotal) < Math.abs(sum - receiptTotal)) {
              items = merged;
              console.log(
                `[ai/extract] reconcile retry added ${missing.line_items.length} line(s); ` +
                  `sum ${sum.toFixed(2)} -> ${newSum.toFixed(2)} (total ${receiptTotal.toFixed(2)})`
              );
            } else {
              console.log(
                `[ai/extract] reconcile retry rejected — ${newSum.toFixed(2)} not closer to ${receiptTotal.toFixed(2)}`
              );
            }
          }
        }
      }

      if (items.length > 0) {
        orig["extracted_fields"] = { ...ef, line_items: items };
      }
    }

    return {
      data: parsed as unknown as ExtractionData,
      usage: {
        input_tokens: usage.input_tokens + liInTokens,
        output_tokens: usage.output_tokens + liOutTokens,
      },
      stop_reason: response.stop_reason || null,
      max_tokens_cap: maxTokens,
    };
  }
  return {
    data: {
      error: "parse_failed",
      raw_text: rawText,
      stop_reason: response.stop_reason || null,
    } as ExtractionFailure,
    usage,
    stop_reason: response.stop_reason || null,
    max_tokens_cap: maxTokens,
  };
}

/** Document types where empty line_items is CORRECT (no items expected).
 * Skip the focused fallback for these to avoid wasting a Sonnet call.
 * Everything else (receipt, invoice, "other", null, unknown types) gets
 * the fallback if line_items is empty.
 *
 * Why a denylist instead of an allowlist: in production we saw Sonnet
 * classify marginal-quality receipt crops as `document_type: "other"`,
 * which fell outside the previous allowlist and never got the fallback.
 * Inverting the check covers that case while still skipping docs that
 * genuinely have no items. */
const SKIP_RETRY_DOC_TYPES = new Set([
  "id_document",
  "certificate",
  "letter",
  "appointment_letter",
  "rental_agreement",
  "contract",
  "warranty",
  "payment_confirmation", // a simple total-only confirmation
  "bank_statement", // line items live in a different code path (CAMT/CSV)
  "multi_doc_scan", // container — items live on children
]);

/**
 * Focused line-items extraction — a SECOND Sonnet call with a stripped
 * prompt that asks ONLY for the line items, never for the full schema.
 * Used as a fallback when the main extraction returned empty line_items
 * on a receipt-shaped doc.
 *
 * Why a focused second call instead of just nudging the main prompt:
 * the main prompt is ~200 lines and asks for ~10 fields per line item
 * (name, qty, unit, price, total, category, category_path, vat_rate,
 * discount_amount, printed_raw). Sonnet on a marginal-quality crop
 * appears to give up on the full schema. A simple prompt asking only
 * for name + price + quantity reliably extracts what's there — the
 * diag proved this on a crop that returned empty from the full prompt.
 *
 * The returned items have only the basic three fields. Downstream
 * code that expects category/category_path will see undefined; that's
 * fine — the taxonomy canonicalisation pass treats missing fields as
 * "needs categorisation later" and the UI shows them as uncategorised.
 *
 * Tokens cap kept low (8k) — line_items rarely exceed a few hundred
 * tokens even on long receipts, no need for the 64k that the main
 * prompt budgets for.
 */
async function extractLineItemsFocused(
  fileBuffer: Buffer,
  mimeType: SupportedMediaType,
  _taxonomyHint?: string
): Promise<{
  line_items: Array<{ name: string; price: number | null; quantity: number }>;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const prompt = `Extract the LINE ITEMS from this receipt and return STRICT JSON:
{
  "line_items": [
    { "name": "<item name as printed>", "price": <number or null>, "quantity": <number, default 1> }
  ]
}

Enumerate EVERY printed line item — every product, every fee, every discount. Include every line even if you can read the name but not the price (set price to null). Empty line_items is the WRONG answer for a receipt with visible item lines.

Return ONLY the JSON object. No markdown, no extra fields, no surrounding prose.`;

  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: prompt },
  ];
  if (mimeType === "application/pdf") {
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: fileBuffer.toString("base64"),
      },
    } as unknown as Anthropic.ContentBlockParam);
  } else {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: fileBuffer.toString("base64"),
      },
    });
  }
  try {
    const stream = client.messages.stream({
      model: AI_MODEL_SMART,
      max_tokens: 8000,
      temperature: 0,
      messages: [{ role: "user", content: contentBlocks }],
    });
    const resp = await stream.finalMessage();
    const text =
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("") || "";
    const parsed = safeParseJSON(text);
    const usage = {
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
    };
    if (!parsed) {
      console.warn("[ai/extract] focused line-items parse failed");
      return { line_items: [], usage };
    }
    const items = Array.isArray(parsed["line_items"])
      ? (parsed["line_items"] as unknown[])
      : [];
    // Sanitise the items — keep only objects with a name. Coerce numbers,
    // default quantity to 1 if missing.
    const cleaned = items
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const o = it as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        if (!name) return null;
        const priceRaw = o.price;
        const price =
          typeof priceRaw === "number" && Number.isFinite(priceRaw)
            ? priceRaw
            : null;
        const qtyRaw = o.quantity;
        const quantity =
          typeof qtyRaw === "number" && Number.isFinite(qtyRaw) && qtyRaw > 0
            ? qtyRaw
            : 1;
        return { name, price, quantity };
      })
      .filter((x): x is { name: string; price: number | null; quantity: number } =>
        x !== null
      );
    console.log(
      `[ai/extract] focused line-items fallback returned ${cleaned.length} items (in=${usage.input_tokens} out=${usage.output_tokens})`
    );
    return { line_items: cleaned, usage };
  } catch (e) {
    console.warn(
      "[ai/extract] focused line-items fallback threw:",
      e instanceof Error ? e.message : String(e)
    );
    return {
      line_items: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

/**
 * Reconciliation-guided line-items retry. Fired when line_items ARE
 * present but don't sum to the receipt total. Unlike the empty-fill
 * fallback, this call is TOLD the gap and the names it already has, then
 * asked ONLY for the lines that are still missing — turning a blind
 * "list everything" into a targeted search for a known shortfall, which
 * vision models handle far better. Returns basic {name,price,quantity}
 * rows for the caller to append (and accept only if they close the gap).
 */
async function extractMissingLineItems(
  fileBuffer: Buffer,
  mimeType: SupportedMediaType,
  ctx: {
    existing: Array<{ name: string; total: number | null }>;
    foundSum: number;
    receiptTotal: number;
    currency: string | null;
  }
): Promise<{
  line_items: Array<{ name: string; price: number | null; quantity: number }>;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const cur = ctx.currency ? `${ctx.currency} ` : "";
  const gap = ctx.receiptTotal - ctx.foundSum;
  const haveList =
    ctx.existing
      .map(
        (e) =>
          `- ${e.name || "(unnamed)"}${
            e.total != null ? ` = ${cur}${e.total.toFixed(2)}` : ""
          }`
      )
      .join("\n") || "(none)";

  const prompt = `This receipt's printed TOTAL is ${cur}${ctx.receiptTotal.toFixed(
    2
  )}.

So far these line items have been read (summing to ${cur}${ctx.foundSum.toFixed(
    2
  )}):
${haveList}

That leaves about ${cur}${gap.toFixed(
    2
  )} unaccounted for — meaning ONE OR MORE printed lines were missed (or a price was misread). Look very carefully at the receipt, especially faint or tightly-spaced lines, and find the lines that are NOT already in the list above.

Return STRICT JSON with ONLY the MISSING line items (do NOT repeat any line already listed above):
{
  "line_items": [
    { "name": "<item name as printed>", "price": <line amount as a number, or null>, "quantity": <number, default 1> }
  ]
}

Rules:
- Only include lines that are genuinely missing from the list above.
- "price" is the line's printed amount (negative for a discount line).
- If, after looking carefully, you cannot find any additional lines, return {"line_items": []}.
- Return ONLY the JSON object. No markdown, no prose.`;

  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: prompt },
  ];
  if (mimeType === "application/pdf") {
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: fileBuffer.toString("base64"),
      },
    } as unknown as Anthropic.ContentBlockParam);
  } else {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: fileBuffer.toString("base64"),
      },
    });
  }
  try {
    const stream = client.messages.stream({
      model: AI_MODEL_SMART,
      max_tokens: 8000,
      temperature: 0,
      messages: [{ role: "user", content: contentBlocks }],
    });
    const resp = await stream.finalMessage();
    const text =
      resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("") || "";
    const parsed = safeParseJSON(text);
    const usage = {
      input_tokens: resp.usage?.input_tokens || 0,
      output_tokens: resp.usage?.output_tokens || 0,
    };
    if (!parsed) {
      console.warn("[ai/extract] reconcile retry parse failed");
      return { line_items: [], usage };
    }
    const raw = Array.isArray(parsed["line_items"])
      ? (parsed["line_items"] as unknown[])
      : [];
    const cleaned = raw
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const o = it as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        if (!name) return null;
        const priceRaw = o.price;
        const price =
          typeof priceRaw === "number" && Number.isFinite(priceRaw)
            ? priceRaw
            : null;
        const qtyRaw = o.quantity;
        const quantity =
          typeof qtyRaw === "number" && Number.isFinite(qtyRaw) && qtyRaw > 0
            ? qtyRaw
            : 1;
        return { name, price, quantity };
      })
      .filter(
        (x): x is { name: string; price: number | null; quantity: number } =>
          x !== null
      );
    console.log(
      `[ai/extract] reconcile retry returned ${cleaned.length} candidate line(s) (in=${usage.input_tokens} out=${usage.output_tokens})`
    );
    return { line_items: cleaned, usage };
  } catch (e) {
    console.warn(
      "[ai/extract] reconcile retry threw:",
      e instanceof Error ? e.message : String(e)
    );
    return { line_items: [], usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

/** True when the doc type is one where line items are expected (so the
 * fill/reconcile passes should run). Inverse of the SKIP denylist — a
 * denylist (not an allowlist) so that marginal receipts mis-classified as
 * "other" still get the line-items passes. */
function lineItemsExpected(parsed: Record<string, unknown>): boolean {
  const docType = String(parsed["document_type"] || "").toLowerCase();
  return !(docType && SKIP_RETRY_DOC_TYPES.has(docType));
}
