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
 * Try increasingly aggressive parses until one works. We prefer the
 * cleanest input but degrade gracefully:
 *  1. raw text
 *  2. text with code fence removed
 *  3. first balanced {…} sliced out
 *  4. that slice with trailing commas removed
 * Returns null if everything fails (truncation, gibberish, etc.).
 */
function safeParseJSON(s: string): Record<string, unknown> | null {
  if (!s) return null;
  const candidates = [s, stripCodeFence(s)];
  const obj = extractFirstObject(s) || extractFirstObject(stripCodeFence(s));
  if (obj) {
    candidates.push(obj);
    candidates.push(stripTrailingCommas(obj));
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

function getMimeType(
  filename: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf" {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<
    string,
    "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf"
  > = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
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
  const base64Data = fileBuffer.toString("base64");

  const contentBlocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: DOCUMENT_EXTRACTION_PROMPT },
  ];

  if (mimeType === "application/pdf") {
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64Data,
      },
    } as unknown as Anthropic.ContentBlockParam);
  } else {
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
