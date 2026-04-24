import Anthropic from "@anthropic-ai/sdk";
import { PROFILE_ENRICHMENT_PROMPT } from "./prompts";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface EnrichedProfile {
  name?: string;
  description?: string;
  ai_summary?: string;
  aliases?: string[];
  attributes?: Record<string, string>;
}

function stripCodeFence(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1].trim() : s.trim();
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

/**
 * Strip HTML to a plain-text excerpt suitable for Claude. Removes scripts,
 * styles, comments, collapses whitespace, and caps length so the prompt stays
 * cheap.
 */
export function htmlToTextExcerpt(html: string, maxChars = 8000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export async function enrichProfileFromText(
  url: string,
  text: string
): Promise<EnrichedProfile | null> {
  console.log("[ai/enrich-profile] enriching", url, "len:", text.length);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `${PROFILE_ENRICHMENT_PROMPT}\n\nURL: ${url}\n\nPAGE TEXT:\n${text}\n\nJSON:`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text : "";
  const parsed = safeParseJSON(raw);
  if (!parsed) return null;

  // Drop empty attribute keys to keep the JSONB clean
  const attrs: Record<string, string> = {};
  if (parsed.attributes && typeof parsed.attributes === "object") {
    for (const [k, v] of Object.entries(parsed.attributes as Record<string, unknown>)) {
      if (v != null && String(v).trim() !== "" && String(v).toLowerCase() !== "null") {
        attrs[k] = String(v).trim();
      }
    }
  }

  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    description:
      typeof parsed.description === "string" ? parsed.description : undefined,
    ai_summary:
      typeof parsed.ai_summary === "string" ? parsed.ai_summary : undefined,
    aliases: Array.isArray(parsed.aliases)
      ? (parsed.aliases as unknown[])
          .map((a) => String(a).trim())
          .filter(Boolean)
      : undefined,
    attributes: Object.keys(attrs).length ? attrs : undefined,
  };
}
