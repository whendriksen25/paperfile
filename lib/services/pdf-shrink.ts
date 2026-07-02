import { PDFDocument, PDFRawStream, PDFName, PDFArray } from "pdf-lib";
import sharp from "sharp";

/**
 * PDF downsampling for oversized scans.
 *
 * WHY: Claude's API caps a request at ~32 MB. Base64 inflates a PDF by
 * 4/3, so any PDF over ~22 MB raw gets rejected with 413
 * request_too_large (first hit by Fluxa.pdf, 29.3 MB / 21 pages).
 * Big scans are mostly wasted pixels: Claude's vision reads at roughly
 * ~1.15 megapixels per page, while phone/office scanners emit 6+ MP
 * pages. Downsampling the embedded images loses (almost) nothing that
 * Claude would actually have seen — and keeps the WHOLE document in one
 * request, preserving cross-page context (totals, running balances,
 * clause references) that page-chunking would destroy.
 *
 * The original file in Dropbox is never touched — we shrink an in-memory
 * copy right before the API call.
 *
 * Claude also has a hard 100-page-per-PDF limit that no amount of
 * downsampling can fix; callers should surface that as a clear error
 * (page-chunking is the eventual answer for those).
 */

/** Raw-PDF size above which extractDocument shrinks before sending.
 *  32 MB API cap ÷ 4/3 base64 inflation ≈ 24 MB, minus headroom for the
 *  prompt text and JSON envelope. */
export const PDF_RAW_LIMIT_BYTES = 20 * 1024 * 1024;

/** Claude's hard per-PDF page limit. */
export const CLAUDE_PDF_PAGE_LIMIT = 100;

interface ShrinkPass {
  longEdgePx: number;
  jpegQuality: number;
}

/** Progressively harsher passes. Each restarts from the ORIGINAL bytes so
 *  quality loss never compounds. 2000 px long edge is still ~2.6 MP for an
 *  A4 scan — comfortably above Claude's effective reading resolution. */
const PASSES: ShrinkPass[] = [
  { longEdgePx: 2000, jpegQuality: 75 },
  { longEdgePx: 1600, jpegQuality: 62 },
  { longEdgePx: 1250, jpegQuality: 50 },
];

export interface ShrinkResult {
  buffer: Buffer;
  pageCount: number;
  /** false when no pass got it under the limit (buffer = harshest attempt). */
  fits: boolean;
  /** The pass that produced the returned buffer, null if input returned as-is. */
  pass: ShrinkPass | null;
  /** Images rewritten / images skipped (non-JPEG or masks) in the returned buffer. */
  rewritten: number;
  skipped: number;
}

const nameOf = (v: unknown): string | null =>
  v instanceof PDFName ? v.decodeText() : null;

/** True when the stream's Filter is exactly DCTDecode (optionally as a
 *  1-element array) — i.e. the contents are plain JPEG bytes. */
function isPlainJpeg(stream: PDFRawStream): boolean {
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (nameOf(filter) === "DCTDecode") return true;
  if (filter instanceof PDFArray) {
    const arr = filter.asArray();
    return arr.length === 1 && nameOf(arr[0]) === "DCTDecode";
  }
  return false;
}

async function shrinkOnce(
  original: Buffer,
  pass: ShrinkPass
): Promise<{ buffer: Buffer; pageCount: number; rewritten: number; skipped: number }> {
  const doc = await PDFDocument.load(original, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  let rewritten = 0;
  let skipped = 0;

  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (nameOf(dict.get(PDFName.of("Subtype"))) !== "Image") continue;
    // Stencil masks / soft masks carry meaning per-bit — leave alone.
    if (dict.get(PDFName.of("ImageMask"))) continue;
    if (!isPlainJpeg(obj)) {
      // Flate/JBIG2/CCITT images (rare in phone scans). Skipping keeps
      // them pixel-identical; the JPEGs are where the megabytes live.
      skipped++;
      continue;
    }

    try {
      const jpegBytes = Buffer.from(obj.getContents());
      const meta = await sharp(jpegBytes).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) {
        skipped++;
        continue;
      }
      const out = await sharp(jpegBytes)
        .resize({
          width: pass.longEdgePx,
          height: pass.longEdgePx,
          fit: "inside",
          withoutEnlargement: true,
        })
        .toColourspace("srgb")
        .jpeg({ quality: pass.jpegQuality, mozjpeg: true })
        .toBuffer();
      if (out.length >= jpegBytes.length) continue; // never make it bigger
      const outMeta = await sharp(out).metadata();

      const newStream = doc.context.stream(out, {
        Type: "XObject",
        Subtype: "Image",
        Width: outMeta.width || w,
        Height: outMeta.height || h,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        Filter: "DCTDecode",
      });
      doc.context.assign(ref, newStream);
      rewritten++;
    } catch (e) {
      console.warn(
        "[pdf-shrink] image rewrite failed, keeping original image:",
        e instanceof Error ? e.message : String(e)
      );
      skipped++;
    }
  }

  const saved = await doc.save({ useObjectStreams: true });
  return {
    buffer: Buffer.from(saved),
    pageCount: doc.getPageCount(),
    rewritten,
    skipped,
  };
}

/**
 * Shrinks a PDF until it fits under `limitBytes` (default: the Claude
 * request budget). Tries progressively harsher resolution/quality passes,
 * each from the original bytes. Returns the first passing result, or the
 * harshest attempt with fits=false when nothing gets it under the limit
 * (e.g. 100 pages of dense CCITT scans we refuse to touch).
 */
export async function shrinkPdfForClaude(
  original: Buffer,
  limitBytes: number = PDF_RAW_LIMIT_BYTES
): Promise<ShrinkResult> {
  let last: ShrinkResult | null = null;
  for (const pass of PASSES) {
    const t0 = Date.now();
    const r = await shrinkOnce(original, pass);
    console.log(
      `[pdf-shrink] pass ${pass.longEdgePx}px/q${pass.jpegQuality}: ` +
        `${(original.length / 1048576).toFixed(1)}MB → ${(r.buffer.length / 1048576).toFixed(1)}MB ` +
        `(${r.rewritten} images rewritten, ${r.skipped} skipped, ${r.pageCount}p, ${Date.now() - t0}ms)`
    );
    last = { ...r, fits: r.buffer.length <= limitBytes, pass };
    if (last.fits) return last;
  }
  // PASSES is non-empty, so last is always set here.
  return last as ShrinkResult;
}
