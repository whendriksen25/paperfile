import Anthropic from "@anthropic-ai/sdk";
import { AI_MODEL_SMART } from "./pricing";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Verbatim transcription of a PDF fragment (a handful of pages).
 *
 * Unlike the extraction prompt this returns PLAIN TEXT, not JSON — no
 * schema pressure, no summarising instinct. Each fragment is small
 * enough (≤5 pages) that a full verbatim transcript comfortably fits
 * the response budget; the transcribe service stitches fragments back
 * together in page order.
 */
const TRANSCRIBE_PROMPT = `Transcribe this document fragment VERBATIM, top to bottom.

Rules:
- Output the transcription ONLY — no introduction, no commentary, no markdown fences.
- Keep the ORIGINAL language exactly as printed. Do not translate.
- Preserve the reading order and approximate line breaks. Keep headings on their own lines.
- Tables: one row per line, cells separated by " | ".
- Transcribe EVERY line of every page in this fragment — headers, footers, fine print, page numbers. Nothing may be skipped or summarised.
- Mark genuinely unreadable spots as [onleesbaar]. Never guess content into existence.
- Separate each page with a line containing only: ===PAGE===`;

export async function transcribePdfChunk(pdfBuffer: Buffer): Promise<{
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const stream = client.messages.stream({
    model: AI_MODEL_SMART,
    max_tokens: 16384,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: TRANSCRIBE_PROMPT },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBuffer.toString("base64"),
            },
          } as unknown as Anthropic.ContentBlockParam,
        ],
      },
    ],
  });
  const msg = await stream.finalMessage();
  const tb = msg.content.find((b) => b.type === "text");
  return {
    text: tb && "text" in tb ? tb.text : "",
    usage: {
      input_tokens: msg.usage?.input_tokens || 0,
      output_tokens: msg.usage?.output_tokens || 0,
    },
  };
}
