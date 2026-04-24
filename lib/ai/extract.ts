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

function safeParseJSON(s: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(stripCodeFence(s));
    } catch {
      return null;
    }
  }
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

export async function extractDocument(
  fileBuffer: Buffer,
  filename: string
): Promise<DocumentExtraction | null> {
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
    max_tokens: 8192,
    temperature: 0,
    messages: [{ role: "user", content: contentBlocks }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawText = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = safeParseJSON(rawText);

  console.log("[ai/extract] extraction complete for:", filename);

  if (!parsed) return null;
  return parsed as unknown as DocumentExtraction;
}
