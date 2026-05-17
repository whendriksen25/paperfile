import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { AI_MODEL_FAST } from "@/lib/ai/pricing";

/**
 * Final-mile sanity check: after the polygon detection + deskew has
 * (hopefully) made each receipt crop upright, ask Haiku one quick
 * question — "is this image upright?" — and return how many degrees of
 * rotation it still needs.
 *
 * Why a probe instead of trusting the upstream rotation hint:
 *   - The detection prompt asks Sonnet to estimate rotation in 1 pass
 *     on a busy scan. It's usually right, but it occasionally misjudges
 *     by a quarter-turn (returns 0 for an upside-down receipt).
 *   - A dedicated Haiku call on the already-cropped receipt is cheaper
 *     and more accurate for the simpler question "is this upright?".
 *   - Haiku at ~$0.001 per call × N receipts is negligible.
 *
 * The probe ONLY returns 0 / 90 / 180 / 270 — coarse quadrant correction.
 * Fine tilts (±2°) are NOT this probe's job; the polygon detection +
 * deskew handles those upstream.
 *
 * The function shrinks the image to ~512px on the long side before
 * sending to Haiku — orientation is obvious at low resolution and we
 * save tokens. Failures (network, parse, anything) return 0 (no
 * correction) rather than throwing, so the pipeline always proceeds.
 */
export async function probeOrientation(
  buffer: Buffer
): Promise<{ degrees: 0 | 90 | 180 | 270; rawResponse: string | null }> {
  try {
    // Shrink for speed + cost. Orientation is unambiguous at 512px.
    const small = await sharp(buffer)
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Look at this image of a receipt or document. Decide which way is up.

If the receipt is already upright (header at top, text reads left-to-right, total near the bottom), return 0.
If it needs to rotate 90° clockwise to become upright, return 90.
If it's upside-down (needs 180° rotation), return 180.
If it needs to rotate 90° counter-clockwise to become upright (equivalent to 270° clockwise), return 270.

Return STRICT JSON: {"rotation_needed_degrees": <0|90|180|270>}

Just the number — no reasoning, no markdown, no extra fields.`;

    const resp = await client.messages.create({
      model: AI_MODEL_FAST,
      max_tokens: 64,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: small.toString("base64"),
              },
            },
          ],
        },
      ],
    });

    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    // Pull the rotation value out — tolerant parse.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fence ? fence[1] : text).trim();
    let parsed: { rotation_needed_degrees?: unknown } | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Fallback: regex-pluck the first 0/90/180/270 in the response.
      const m = body.match(/\b(0|90|180|270)\b/);
      if (m) {
        const n = Number(m[1]);
        if (n === 0 || n === 90 || n === 180 || n === 270) {
          return { degrees: n, rawResponse: text };
        }
      }
      return { degrees: 0, rawResponse: text };
    }
    const v = Number(parsed?.rotation_needed_degrees);
    if (v === 0 || v === 90 || v === 180 || v === 270) {
      return { degrees: v, rawResponse: text };
    }
    // Unexpected value — fall back to no correction.
    return { degrees: 0, rawResponse: text };
  } catch (e) {
    console.warn(
      "[orientation-probe] failed, returning 0 (no correction):",
      e instanceof Error ? e.message : String(e)
    );
    return { degrees: 0, rawResponse: null };
  }
}

/**
 * Apply a quadrant rotation (0/90/180/270 clockwise) to a buffer.
 * Sharp handles these losslessly for 90/180/270 (no resampling — just
 * pixel rearrangement). For 0, returns the buffer unchanged.
 */
export async function applyQuadrantRotation(
  buffer: Buffer,
  degrees: 0 | 90 | 180 | 270
): Promise<Buffer> {
  if (degrees === 0) return buffer;
  try {
    return await sharp(buffer)
      .rotate(degrees, { background: "#ffffff" })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (e) {
    console.warn(
      "[orientation-probe] applyQuadrantRotation failed, returning original:",
      e instanceof Error ? e.message : String(e)
    );
    return buffer;
  }
}
