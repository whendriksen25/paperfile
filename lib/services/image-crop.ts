import sharp from "sharp";
import type { BoundingBox } from "@/lib/ai/extract";

/**
 * Crop one or more sub-regions out of a source image buffer.
 *
 * Used by the multi-document path: when Claude detects N receipts on a
 * single scan and returns bounding boxes, we crop each region into its
 * own buffer so the per-receipt re-extraction sees a full-resolution
 * image of just that receipt — instead of a quarter-pixel-density crop
 * inside the shared scan.
 *
 * Inputs:
 *   buffer       — the original full scan
 *   boxes        — normalised 0..1 boxes, top-left origin, with optional
 *                  padding already baked in by Claude
 *
 * Output:
 *   one Buffer per input box, in the same order. Cropping is clamped to
 *   the actual image bounds so a slightly-out-of-frame box doesn't fail.
 *   Boxes that are too small to be useful (< 5% area) get a Buffer of
 *   the full image as a graceful fallback — better to re-extract on the
 *   shared image than to fail.
 *
 * PDFs and CSVs are not supported — only raster images (JPEG/PNG/HEIC).
 * The caller should check mimeType before invoking; if non-image, fall
 * back to the shared-image extraction.
 */
export async function cropRegions(
  buffer: Buffer,
  boxes: BoundingBox[]
): Promise<Buffer[]> {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (W === 0 || H === 0) {
    // Unknown dimensions — return original for every box.
    return boxes.map(() => buffer);
  }
  const out: Buffer[] = [];
  for (const b of boxes) {
    // Clamp + sanity-check.
    const x = Math.max(0, Math.min(1, Number(b.x) || 0));
    const y = Math.max(0, Math.min(1, Number(b.y) || 0));
    const w = Math.max(0, Math.min(1 - x, Number(b.w) || 0));
    const h = Math.max(0, Math.min(1 - y, Number(b.h) || 0));
    if (w * h < 0.05) {
      // Box is too tiny to be a useful crop — give back the original.
      out.push(buffer);
      continue;
    }
    const px = Math.floor(x * W);
    const py = Math.floor(y * H);
    const pw = Math.max(1, Math.floor(w * W));
    const ph = Math.max(1, Math.floor(h * H));
    try {
      const cropped = await sharp(buffer)
        .extract({ left: px, top: py, width: pw, height: ph })
        .jpeg({ quality: 92 })
        .toBuffer();
      out.push(cropped);
    } catch (e) {
      console.warn("[image-crop] crop failed, using original:", e);
      out.push(buffer);
    }
  }
  return out;
}
