import sharp from "sharp";

/**
 * Auto-rotate an image buffer to its correct upright orientation BEFORE
 * sending it to Claude.
 *
 * Why this exists: phone uploads carry EXIF orientation metadata that
 * tells the OS to display the photo right-side-up, but the bytes
 * themselves are still stored in the sensor orientation. Some apps
 * (and pretty much all client-side resizers) strip EXIF before upload.
 * Result: Claude receives an upside-down or rotated image and either
 * fails to detect document boundaries or extracts the wrong way around.
 *
 * sharp().rotate() with no args applies whatever EXIF orientation tag
 * is present, then writes out the rotated pixels. After this pass:
 *   - the EXIF tag is gone (because the pixels are now upright)
 *   - Claude sees the receipt the way a human would
 *
 * For non-images (PDF, CSV, XML) we return the buffer unchanged —
 * sharp can't open them and they don't have orientation anyway. The
 * caller is responsible for not calling this on bank statements.
 *
 * Note this does NOT handle "the user rotated their phone after
 * shooting and EXIF says 0° but the photo really is 90° off." That
 * case would need a content-based orientation probe (a quick Haiku
 * call: "is this image upright?"). We'll add that as a follow-up if
 * EXIF auto-orient turns out not to be enough on real-world scans.
 *
 * The function is defensive: any sharp failure (corrupt header,
 * unsupported codec) falls back to returning the original buffer
 * rather than throwing, so the analyze pipeline still proceeds.
 *
 * Performance: ~50-200ms on a typical phone photo. Negligible vs the
 * 5-30s Claude call that follows.
 */
export async function autoOrientImage(
  buffer: Buffer,
  fileName: string | null | undefined
): Promise<{ buffer: Buffer; rotated: boolean; degrees: number | null }> {
  // Heuristic: only run on raster-image filenames. PDFs/CSVs/XML pass
  // through untouched.
  const isImage = /\.(jpe?g|png|webp|gif|heic|heif|tiff?|bmp)$/i.test(
    fileName || ""
  );
  if (!isImage) {
    return { buffer, rotated: false, degrees: null };
  }
  try {
    const img = sharp(buffer);
    const meta = await img.metadata();
    // EXIF orientation values: 1=normal, 3=180°, 6=90°CW, 8=90°CCW.
    // Other values (2, 4, 5, 7) are mirrored variants — sharp handles
    // those too.
    const exifOrient = meta.orientation || 1;
    if (exifOrient === 1) {
      // Already upright per EXIF. No work to do.
      return { buffer, rotated: false, degrees: 0 };
    }
    const rotated = await sharp(buffer)
      // .rotate() with no args reads EXIF, applies the rotation, and
      // strips the orientation tag. Output is canonical-orientation
      // JPEG/PNG (we re-encode as JPEG quality 92 for size).
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
    // Map EXIF code → human-readable degrees for logging.
    const degreesMap: Record<number, number> = {
      1: 0,
      2: 0, // mirrored horizontally
      3: 180,
      4: 180, // mirrored vertically (= 180 + mirror)
      5: 90, // mirrored + 90°CCW
      6: 90,
      7: 90, // mirrored + 90°CW
      8: 270,
    };
    return {
      buffer: rotated,
      rotated: true,
      degrees: degreesMap[exifOrient] ?? null,
    };
  } catch (e) {
    // Bad header, unsupported codec, anything else — leave the buffer
    // alone and let downstream try its best.
    console.warn("[image-orient] auto-orient failed, using original:", e);
    return { buffer, rotated: false, degrees: null };
  }
}
