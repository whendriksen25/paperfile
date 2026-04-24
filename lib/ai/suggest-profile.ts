import Anthropic from "@anthropic-ai/sdk";
import { PROFILE_SUGGESTION_PROMPT } from "./prompts";
import type {
  DocumentExtraction,
  ProfileRow,
  ProfileSuggestion,
} from "@/types/document";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function stripCodeFence(s: string): string {
  if (!s) return s;
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

function summariseDocumentForMatch(e: DocumentExtraction): string {
  const lines: string[] = [];
  if (e.document_type) lines.push(`Type: ${e.document_type}`);
  if (e.document_subtype) lines.push(`Subtype: ${e.document_subtype}`);
  if (e.document_date) lines.push(`Date: ${e.document_date}`);
  if (e.sender) lines.push(`Sender: ${e.sender}`);
  if (e.recipient) lines.push(`Recipient: ${e.recipient}`);
  if (e.profile_hint) lines.push(`Name on document: ${e.profile_hint}`);
  if (e.amount != null) lines.push(`Amount: ${e.amount} ${e.currency || ""}`);
  if (e.title) lines.push(`Title: ${e.title}`);
  if (e.summary) lines.push(`Summary: ${e.summary}`);
  if (e.extracted_fields && Object.keys(e.extracted_fields).length) {
    lines.push("Extracted fields:");
    for (const [k, v] of Object.entries(e.extracted_fields)) {
      lines.push(`  - ${k}: ${String(v)}`);
    }
  }
  if (e.ocr_text) {
    // Cap OCR text — only need enough to spot identifiers (IBANs, addresses, IDs)
    const snippet = e.ocr_text.slice(0, 1500);
    lines.push(`OCR snippet:\n${snippet}`);
  }
  return lines.join("\n");
}

function profileForPrompt(p: ProfileRow): string {
  const lines = [`- [${p.id}] ${p.name} (${p.type})`];
  if (p.website) lines.push(`  Website: ${p.website}`);
  if (p.aliases?.length)
    lines.push(`  Aliases: ${p.aliases.join(", ")}`);
  if (p.ai_summary) lines.push(`  Summary: ${p.ai_summary}`);
  else if (p.description) lines.push(`  Description: ${p.description}`);
  if (p.attributes && Object.keys(p.attributes).length) {
    const attrs = Object.entries(p.attributes)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    lines.push(`  Attributes: ${attrs}`);
  }
  return lines.join("\n");
}

/**
 * Ask Claude to rank the profiles for a given extracted document.
 * Returns null on failure (caller should fall back to default profile).
 */
export async function suggestProfile(
  extraction: DocumentExtraction,
  profiles: ProfileRow[]
): Promise<ProfileSuggestion | null> {
  if (!profiles.length) return null;

  console.log("[ai/suggest-profile] ranking", profiles.length, "profiles");

  const profilesBlock = profiles.map(profileForPrompt).join("\n\n");
  const documentBlock = summariseDocumentForMatch(extraction);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: "user",
        content:
          `${PROFILE_SUGGESTION_PROMPT}\n\n--- DOCUMENT ---\n${documentBlock}\n\n--- PROFILES ---\n${profilesBlock}\n\nJSON:`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  const raw = text && "text" in text ? text.text : "";
  const parsed = safeParseJSON(raw);

  if (!parsed || !Array.isArray(parsed.scores)) {
    console.warn("[ai/suggest-profile] parse failed");
    return null;
  }

  const ranked = (parsed.scores as Array<Record<string, unknown>>)
    .map((s) => {
      const id = Number(s.profileId);
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return null;
      return {
        profileId: id,
        name: profile.name,
        probability: Math.max(0, Math.min(1, Number(s.probability) || 0)),
        reason: String(s.reason || ""),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.probability - a.probability);

  const bestRaw = parsed.best as Record<string, unknown> | undefined;
  const bestId = bestRaw?.profileId == null ? null : Number(bestRaw.profileId);
  const bestProfile =
    bestId != null ? profiles.find((p) => p.id === bestId) : null;

  return {
    profileId: bestProfile ? bestProfile.id : null,
    confidence: Math.max(
      0,
      Math.min(1, Number(bestRaw?.confidence) || (ranked[0]?.probability ?? 0))
    ),
    reason: String(bestRaw?.reason || ranked[0]?.reason || ""),
    ranked,
  };
}
