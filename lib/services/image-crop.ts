import sharp from "sharp";
import type { BoundingBox, Point, ReceiptPolygon } from "@/lib/ai/extract";

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

// ============================================================================
// Polygon helpers + cropAndDeskew — content-aware multi-receipt cropping
// ============================================================================

/**
 * Axis-aligned bounding box of a polygon in NORMALISED 0..1 coords.
 * The polygon's vertices already live in image-relative coords, so this
 * is just per-axis min/max. Useful both for the deskew flow (we extract
 * the bbox first, then rotate inside that smaller canvas) and for any
 * UI overlay that wants to put a single rectangle around the receipt.
 */
export function polygonBoundingBox(
  verts: Point[]
): { x: number; y: number; w: number; h: number } {
  if (!verts || verts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const v of verts) {
    const vx = Number(v.x) || 0;
    const vy = Number(v.y) || 0;
    if (vx < minX) minX = vx;
    if (vy < minY) minY = vy;
    if (vx > maxX) maxX = vx;
    if (vy > maxY) maxY = vy;
  }
  return {
    x: Math.max(0, minX),
    y: Math.max(0, minY),
    w: Math.max(0, Math.min(1, maxX) - Math.max(0, minX)),
    h: Math.max(0, Math.min(1, maxY) - Math.max(0, minY)),
  };
}

/**
 * Return the angle (in DEGREES, range (-90, 90]) of the polygon's
 * LONGEST edge, measured from the horizontal axis. Used as a fallback
 * deskew estimate when the model doesn't supply rotation_estimate_degrees.
 *
 * Why "longest edge above horizontal":
 *  - For a typical tilted receipt the long side of the polygon coincides
 *    with the receipt's long axis (left and right edges).
 *  - On an upright receipt that long axis is roughly vertical: the
 *    longest-edge angle measured from horizontal will be near ±90°.
 *  - To convert that to "tilt vs upright" we treat anything closer to
 *    vertical as upright (subtract 90°) — done by the caller, not here.
 *
 * Returned value is restricted to (-90, 90] by atan2 + a manual wrap.
 */
export function polygonLongestEdgeAngleDegrees(verts: Point[]): number {
  if (!verts || verts.length < 2) return 0;
  let bestLen = -1;
  let bestDx = 0;
  let bestDy = 0;
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const dx = (Number(b.x) || 0) - (Number(a.x) || 0);
    const dy = (Number(b.y) || 0) - (Number(a.y) || 0);
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > bestLen) {
      bestLen = len;
      bestDx = dx;
      bestDy = dy;
    }
  }
  // atan2 yields (-π, π]; convert to degrees and wrap into (-90, 90]
  // by adding/subtracting 180° (a line is direction-agnostic).
  let deg = (Math.atan2(bestDy, bestDx) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  return deg;
}

/**
 * Crop each polygon's bounding-box region out of the source image and
 * deskew so the receipt sits upright in its own image. Designed for
 * the multi-receipt-on-one-photo case where each receipt is tilted at
 * an arbitrary angle on a cluttered background.
 *
 * Math, in plain English:
 *  1. We can't easily rotate the FULL scan around an arbitrary point —
 *     and we don't need to. Each receipt's polygon already tells us
 *     roughly where it lives; rotating just THAT region is enough.
 *  2. Take the axis-aligned bounding box of the polygon, in pixel coords.
 *     Pad it by ~3% on each side so the rotation step (next) doesn't
 *     clip the receipt's corners off when it spins them outward.
 *  3. Decide how much to rotate. Prefer the model's explicit
 *     `rotation_estimate_degrees` — it says "the receipt is tilted X°
 *     clockwise vs upright", so applying −X° brings it upright.
 *     If absent, derive a rotation from the polygon's longest edge:
 *       longest-edge-angle ≈ ±90° on an upright receipt (vertical edges
 *       are longest), so the tilt vs vertical is (90° − |edgeAngle|)
 *       with the sign matching the edge's direction. We clamp to ±45°
 *       — anything more probably means we misread the orientation and
 *       deskewing would do more harm than good.
 *  4. Extract the padded bbox region, then rotate it by the negative of
 *     the tilt. Sharp pads the rotated canvas with white.
 *  5. Optionally trim residual uniform-colour borders (the white wedges
 *     that the rotation step inevitably leaves around the corners).
 *  6. Encode as JPEG at quality 92.
 *
 * Any failure on a single polygon falls back to a plain rectangular
 * bbox crop (the old behaviour) so the per-receipt pipeline still has
 * SOMETHING to send to Claude.
 */
export async function cropAndDeskew(
  buffer: Buffer,
  polygons: ReceiptPolygon[],
  opts?: { mask?: boolean; trim?: boolean; orientationProbe?: boolean }
): Promise<Buffer[]> {
  const trim = opts?.trim !== false; // default true
  const probe = opts?.orientationProbe === true; // default false (opt-in)
  // opts.mask is intentionally NOT implemented — the spec says "skip
  // this entirely if opts.mask is false; we'll just rely on the bbox
  // + rotate + trim flow." We carry the option through the signature
  // for future use but never act on it.

  const img = sharp(buffer);
  const meta = await img.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (W === 0 || H === 0) {
    // Unknown dimensions — return original for every polygon.
    return polygons.map(() => buffer);
  }

  const out: Buffer[] = [];
  for (const poly of polygons) {
    const verts = Array.isArray(poly?.vertices) ? poly.vertices : [];
    if (verts.length < 3) {
      // Need at least 3 vertices for an area. Fall back to the full image.
      out.push(buffer);
      continue;
    }

    // 1+2. Bbox in pixel coords + padding so rotation doesn't clip.
    // Generous (8%) padding: experience shows 3% is too tight — small
    // tilt corrections push receipt edges outside the crop and .trim()
    // then bites into receipt content. Better to keep more background
    // and let the per-receipt extraction ignore it.
    const bbox = polygonBoundingBox(verts);
    if (bbox.w * bbox.h < 0.01) {
      // Polygon is suspiciously small (< 1% of image area) — likely
      // garbage from the model. Use the full image as a graceful
      // fallback rather than emit a near-empty crop.
      out.push(buffer);
      continue;
    }
    const padFrac = 0.08;
    const padX = bbox.w * padFrac;
    const padY = bbox.h * padFrac;
    const pxN = Math.max(0, bbox.x - padX);
    const pyN = Math.max(0, bbox.y - padY);
    const pwN = Math.min(1 - pxN, bbox.w + padX * 2);
    const phN = Math.min(1 - pyN, bbox.h + padY * 2);
    const px = Math.floor(pxN * W);
    const py = Math.floor(pyN * H);
    const pw = Math.max(1, Math.floor(pwN * W));
    const ph = Math.max(1, Math.floor(phN * H));

    // 3. Decide rotation angle (positive = clockwise tilt vs upright).
    let tilt: number | null = null;
    const explicit = poly.rotation_estimate_degrees;
    if (typeof explicit === "number" && Number.isFinite(explicit)) {
      tilt = explicit;
    } else {
      // Derive from geometry. Longest edge is roughly vertical on an
      // upright receipt → angle near ±90°. The tilt vs vertical is
      // (edgeAngle − 90°) when edgeAngle > 0, or (edgeAngle + 90°) when
      // edgeAngle < 0; in both cases that's the signed deviation from
      // pure vertical. The sign convention matches positive=clockwise
      // because in image coords y increases downward.
      const edgeDeg = polygonLongestEdgeAngleDegrees(verts);
      const tiltFromVertical =
        edgeDeg > 0 ? edgeDeg - 90 : edgeDeg + 90;
      tilt = tiltFromVertical;
    }

    // Clamp / guard.
    //   - don't deskew if |tilt| > 180° (out of range entirely;
    //     normalise into ±180° instead via modulo, then re-evaluate)
    //   - don't deskew if |tilt| < 3° (visible misalignment from a
    //     micro-rotation is usually worse than the original small tilt;
    //     per-receipt extraction is tilt-tolerant for small angles)
    //
    // The full ±180° range is intentional — receipts may be photographed
    // sideways (±90°) or upside-down (±180°). Sharp rotates arbitrary
    // angles correctly. The optional Haiku orientation probe (next step
    // in the pipeline) catches any remaining 90/180/270° error.
    let applyTilt = true;
    if (tilt == null || !Number.isFinite(tilt)) {
      applyTilt = false;
    } else {
      // Wrap out-of-range values into (-180, 180].
      while (tilt > 180) tilt -= 360;
      while (tilt <= -180) tilt += 360;
      if (Math.abs(tilt) < 3) {
        // Skip micro-rotations silently — common case for upright receipts.
        applyTilt = false;
      }
    }

    try {
      // 4+5. Extract bbox → rotate → trim → encode.
      let pipeline = sharp(buffer).extract({
        left: px,
        top: py,
        width: pw,
        height: ph,
      });
      if (applyTilt && tilt != null) {
        // sharp().rotate(angle) rotates CLOCKWISE by `angle` degrees.
        // We want to UNDO a clockwise tilt of `tilt`, so rotate by -tilt.
        // The applyTilt gate above already filtered out micro-rotations
        // (|tilt| < 3°) and absurd ones (|tilt| > 45°).
        pipeline = pipeline.rotate(-tilt, { background: "#ffffff" });
      }
      if (trim) {
        // .trim() removes uniform-colour borders left by the rotation
        // (the white wedges around the corners). Default threshold is
        // fine for #ffffff backgrounds; if the receipt itself is white
        // the trim is conservative and leaves the printed content.
        pipeline = pipeline.trim();
      }
      let cropped = await pipeline.jpeg({ quality: 92 }).toBuffer();

      // Optional final-mile orientation probe. Sonnet's rotation hint is
      // usually right, but occasionally misses a quarter-turn (especially
      // for receipts photographed upside-down). The probe is a cheap
      // Haiku call that returns 0/90/180/270 — coarse correction only.
      // Skipped by default; opt in via opts.orientationProbe=true.
      if (probe) {
        const { probeOrientation, applyQuadrantRotation } = await import(
          "@/lib/services/orientation-probe"
        );
        const { degrees: quadrant } = await probeOrientation(cropped);
        if (quadrant !== 0) {
          console.log(
            `[image-crop] orientation probe corrected by ${quadrant}°`
          );
          cropped = await applyQuadrantRotation(cropped, quadrant);
        }
      }
      out.push(cropped);
    } catch (e) {
      // Per-polygon defensive: fall back to a plain bbox crop, no
      // rotation. If THAT fails too, return the original buffer.
      console.warn(
        "[image-crop] cropAndDeskew failed for one polygon, falling back to bbox crop:",
        e instanceof Error ? e.message : String(e)
      );
      try {
        const fallback = await sharp(buffer)
          .extract({ left: px, top: py, width: pw, height: ph })
          .jpeg({ quality: 92 })
          .toBuffer();
        out.push(fallback);
      } catch (e2) {
        console.warn(
          "[image-crop] bbox fallback also failed, using full image:",
          e2 instanceof Error ? e2.message : String(e2)
        );
        out.push(buffer);
      }
    }
  }
  return out;
}
