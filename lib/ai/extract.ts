import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import { DOCUMENT_EXTRACTION_PROMPT } from "./prompts";
import {
  AI_MAX_TOKENS_DEFAULT,
  AI_MAX_TOKENS_EXTENDED,
  AI_EXTENDED_BETA_HEADER,
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
 */
export interface ExtractResult {
  data: DocumentExtraction | ExtractionFailure | null;
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
}

export async function extractDocument(
  fileBuffer: Buffer,
  filename: string,
  opts: ExtractOptions = {}
): Promise<ExtractResult> {
  console.log("[ai/extract] starting extraction for:", filename);

  const mimeType = getMimeType(filename);

  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: DOCUMENT_EXTRACTION_PROMPT },
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
      model: "claude-sonnet-4-20250514",
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
    return {
      data: parsed as unknown as DocumentExtraction,
      usage,
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
