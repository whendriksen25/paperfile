import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { AI_MODEL_SMART } from "@/lib/ai/pricing";

/**
 * Per-crop polygon refinement — a SECOND Sonnet call that takes a
 * rough crop (which probably includes background and possibly fragments
 * of adjacent receipts) and identifies the actual 4 corners of THE
 * receipt within it. Returns a tight polygon in crop-relative
 * coordinates (0..1, normalised to the crop's own width/height).
 *
 * Why this matters: the first-pass detection returns axis-aligned
 * rectangles that include background on tilted receipts and often
 * leak into adjacent receipts' content. A second focused call on each
 * crop, where the receipt usually fills 70–95% of the frame, gets a
 * much tighter polygon — and Sonnet is way more reliable on this
 * "find the corners in THIS image" task than on the original "split
 * the multi-receipt scan" task.
 *
 * Returns null when:
 *   - the API call failed (network, parse, anything)
 *   - the returned polygon is degenerate (<3 vertices, all in a line,
 *     covers <30% of the crop area — too small to be the receipt)
 *
 * Cost: ~5s + ~$0.01 per crop. With opt-out via
 * env DISABLE_POLYGON_REFINEMENT=1 or per-call option.
 */
export async function refineCropPolygon(
  cropBuffer: Buffer
): Promise<{ vertices: { x: number; y: number }[] } | null> {
  if (process.env.DISABLE_POLYGON_REFINEMENT === "1") {
    return null;
  }
  try {
    // Downsize for the corner-detection task — corner geometry is
    // unambiguous at 1024px and we save tokens.
    const small = await sharp(cropBuffer)
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = `This image is a rough, generously-padded crop containing ONE main receipt plus background and possibly fragments of OTHER receipts at the edges. Your job is to trace the precise paper boundary of the MAIN (central, most complete) receipt so it can be cropped out cleanly.

Work in this order, like a human would:
1. ORIENT: find the receipt's header (store name / logo at the top) and read which way the text runs. That tells you which way is "up" on the receipt.
2. TRACE EDGES: follow the four physical paper edges of that receipt — top, right, bottom, left. The receipt may be TILTED on the page, so its corners will NOT be axis-aligned: each corner will have a different x AND a different y. Capture the FULL width including the right-hand price/amount column and the FULL height including the header and the bottom total/barcode. Do not cut the receipt short — it is critical that the right-side numbers column is inside your polygon.
3. IGNORE fragments of any other receipt and all background.

Return STRICT JSON with the 4 corner points of the main receipt:
{
  "corners": [
    {"x": <0..1>, "y": <0..1>},
    {"x": <0..1>, "y": <0..1>},
    {"x": <0..1>, "y": <0..1>},
    {"x": <0..1>, "y": <0..1>}
  ]
}

Coordinates normalised to THIS crop's dimensions (top-left = 0,0; bottom-right = 1,1), NOT the original scan.
List the 4 corners CLOCKWISE starting from the receipt's OWN top-left corner (the top-left as the printed header sees it). If the receipt is tilted, that first corner might be at e.g. (0.10, 0.06) — that's correct, just trace clockwise from there.

If the receipt genuinely fills the whole crop edge-to-edge, return the image corners (0,0),(1,0),(1,1),(0,1).
If you cannot identify a single coherent receipt (all background, or two receipts equally overlap), return {"corners": null}.

Return ONLY the JSON object. No prose, no markdown.`;

    const resp = await client.messages.create({
      model: AI_MODEL_SMART,
      max_tokens: 256,
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
    let parsed: { corners?: unknown } | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.warn("[polygon-refinement] JSON parse failed:", text.slice(0, 200));
      return null;
    }
    if (!parsed?.corners || !Array.isArray(parsed.corners) || parsed.corners.length < 3) {
      // Either Sonnet said "can't identify" (corners: null) or returned
      // a degenerate shape. Fall back to the rough crop.
      return null;
    }
    const vertices: { x: number; y: number }[] = [];
    for (const c of parsed.corners) {
      if (c && typeof c === "object") {
        const x = Number((c as Record<string, unknown>).x);
        const y = Number((c as Record<string, unknown>).y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          // Clamp to [0..1] — Sonnet sometimes overshoots slightly.
          vertices.push({
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y)),
          });
        }
      }
    }
    if (vertices.length < 3) return null;

    // Quality check: polygon must cover >30% of the crop area. Anything
    // smaller is probably a hallucination of where the receipt is.
    const area = shoelaceArea(vertices);
    if (area < 0.3) {
      console.log(
        `[polygon-refinement] refined polygon area ${(area * 100).toFixed(1)}% < 30% threshold; using rough crop`
      );
      return null;
    }
    console.log(
      `[polygon-refinement] refined polygon: ${vertices.length} vertices, area=${(area * 100).toFixed(1)}%`
    );
    return { vertices };
  } catch (e) {
    console.warn(
      "[polygon-refinement] threw, falling back to rough crop:",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

/** Shoelace polygon area in normalised units (0..1). */
function shoelaceArea(verts: { x: number; y: number }[]): number {
  if (verts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
