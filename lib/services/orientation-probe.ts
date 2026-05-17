import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { AI_MODEL_FAST } from "@/lib/ai/pricing";

/**
 * Final-mile sanity check: after the polygon detection + deskew has
 * (hopefully) made each receipt crop upright, ask Haiku two related
 * questions in one call:
 *
 *   1. "Is this image upright?" — returns a QUADRANT correction
 *      (0/90/180/270 clockwise degrees needed to make it upright).
 *      Catches cases where Sonnet missed a quarter-turn upstream.
 *
 *   2. "After that quadrant correction, what fine tilt remains?" —
 *      returns a small-angle correction in degrees (range -15..+15)
 *      to make the text baseline horizontal. Catches the residual
 *      few-degree tilt the polygon detection often misses or ignores.
 *
 * Why merge them: one cheap Haiku call answers both, and Haiku sees a
 * cleanly cropped receipt — the simplest possible scene for judging
 * orientation. Doing the quadrant alone leaves visible ±5° tilts;
 * doing the fine tilt alone misses upside-down cases.
 *
 * Failures (network, parse, anything) return zeros (no correction)
 * rather than throwing, so the pipeline always proceeds.
 *
 * Cost: ~$0.001 per call. Latency: ~2-3 seconds.
 */
export async function probeOrientation(
  buffer: Buffer
): Promise<{
  degrees: 0 | 90 | 180 | 270;
  fineTilt: number; // degrees, clockwise positive, range -15..+15
  rawResponse: string | null;
}> {
  try {
    // Shrink for speed + cost. Orientation is unambiguous at 512px,
    // and the fine-tilt judgement only needs enough resolution to see
    // the text baseline. Larger crops waste tokens.
    const small = await sharp(buffer)
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `Look at this image of a receipt or document and report two corrections.

1. ROTATION_NEEDED_DEGREES (one of 0, 90, 180, 270):
   - 0 if already upright (header at top, text reads left-to-right)
   - 90 if it needs to rotate 90° CLOCKWISE to become upright
   - 180 if upside-down (needs 180° rotation)
   - 270 if it needs to rotate 90° COUNTER-CLOCKWISE (= 270° CW)

2. FINE_TILT_DEGREES (-15 to +15):
   AFTER applying the quadrant rotation above, what small angle remains
   to make the text baseline perfectly horizontal? Positive = the image
   needs to rotate clockwise to be straight; negative = counter-clockwise.
   If the text is already horizontal, return 0. Typical values: -10..+10.
   Don't report fine tilt for visual asymmetry from camera angle / paper
   curl — only for genuine receipt-on-page rotation.

Return STRICT JSON: {"rotation_needed_degrees": <0|90|180|270>, "fine_tilt_degrees": <number>}

No markdown, no reasoning, no extra fields.`;

    const resp = await client.messages.create({
      model: AI_MODEL_FAST,
      max_tokens: 128,
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

    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fence ? fence[1] : text).trim();
    let parsed: {
      rotation_needed_degrees?: unknown;
      fine_tilt_degrees?: unknown;
    } | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Fallback regex pluck — quadrant first, then fine tilt.
      const qm = body.match(/\b(0|90|180|270)\b/);
      const fm = body.match(/-?\d+\.?\d*/g);
      let quad: 0 | 90 | 180 | 270 = 0;
      if (qm) {
        const n = Number(qm[1]);
        if (n === 0 || n === 90 || n === 180 || n === 270) quad = n;
      }
      let fine = 0;
      if (fm && fm.length >= 2) {
        const v = Number(fm[1]);
        if (Number.isFinite(v) && Math.abs(v) <= 15) fine = v;
      }
      return { degrees: quad, fineTilt: fine, rawResponse: text };
    }
    const q = Number(parsed?.rotation_needed_degrees);
    let quadrant: 0 | 90 | 180 | 270 = 0;
    if (q === 0 || q === 90 || q === 180 || q === 270) quadrant = q;

    const f = Number(parsed?.fine_tilt_degrees);
    let fineTilt = 0;
    if (Number.isFinite(f)) {
      // Clamp to ±15° as a sanity guard.
      if (f > 15) fineTilt = 15;
      else if (f < -15) fineTilt = -15;
      else fineTilt = f;
    }
    return { degrees: quadrant, fineTilt, rawResponse: text };
  } catch (e) {
    console.warn(
      "[orientation-probe] failed, returning zeros (no correction):",
      e instanceof Error ? e.message : String(e)
    );
    return { degrees: 0, fineTilt: 0, rawResponse: null };
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
