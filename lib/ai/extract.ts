import Anthropic from "@anthropic-ai/sdk";
import * as path from "path";
import { DOCUMENT_EXTRACTION_PROMPT } from "./prompts";
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
  const candidates: string[] = [s, fenced];
  if (obj) {
    candidates.push(obj);
    candidates.push(stripTrailingCommas(obj));
    const smartFixed = normalizeSmartQuotes(obj);
    candidates.push(smartFixed);
    const ctrlFixed = escapeControlCharsInStrings(obj);
    candidates.push(ctrlFixed);
    const arrayFixed = repairArrayCommentary(obj);
    candidates.push(arrayFixed);
    // Belt + braces: every fix combined.
    candidates.push(
      stripTrailingCommas(
        repairArrayCommentary(
          escapeControlCharsInStrings(normalizeSmartQuotes(obj))
        )
      )
    );
  }
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand);
      if (parsed && typeof parsed === "object")
        return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
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

export async function extractDocument(
  fileBuffer: Buffer,
  filename: string
): Promise<DocumentExtraction | ExtractionFailure | null> {
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

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    // 16k tokens — comfortably fits a multi-page bill with full OCR text +
    // line items. The previous 8k limit was the most common cause of
    // truncated-mid-JSON failures on long receipts.
    max_tokens: 16384,
    temperature: 0,
    messages: [{ role: "user", content: contentBlocks }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = safeParseJSON(rawText);

  console.log(
    "[ai/extract] complete:",
    filename,
    "stop:",
    response.stop_reason,
    "parsed?",
    !!parsed
  );

  if (parsed) return parsed as unknown as DocumentExtraction;
  return {
    error: "parse_failed",
    raw_text: rawText,
    stop_reason: response.stop_reason || null,
  };
}
