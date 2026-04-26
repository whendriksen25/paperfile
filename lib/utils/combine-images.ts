import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import heicConvert from "heic-convert";

export interface CombineInput {
  /** Raw image buffer (jpg/png/heic/etc). */
  buffer: Buffer;
  /** Original filename, only used for error messages. */
  name: string;
}

/**
 * iPhone Photos saves in HEIC by default and Sharp's bundled libheif only
 * supports AVIF, NOT the HEVC-encoded HEIC that Apple uses. Without this
 * conversion every iPhone scan upload would silently fail.
 *
 * Detection by magic bytes (the `ftyp` box): bytes 4-7 are "ftyp" and the
 * brand at bytes 8-11 is one of heic/heix/mif1/msf1/heim/heis.
 */
function isHeic(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  const brand = buffer.toString("ascii", 8, 12);
  return ["heic", "heix", "mif1", "msf1", "heim", "heis"].includes(brand);
}

async function maybeConvertHeic(input: CombineInput): Promise<CombineInput> {
  if (!isHeic(input.buffer)) return input;
  try {
    // heic-convert types want ArrayBufferLike but in practice happily takes
    // a Node Buffer (which IS an ArrayBuffer view at the JS layer). Cast.
    const jpegArrayBuffer = await heicConvert({
      buffer: input.buffer as unknown as ArrayBufferLike,
      format: "JPEG",
      quality: 0.9,
    });
    return {
      buffer: Buffer.from(jpegArrayBuffer),
      name: input.name.replace(/\.heic$/i, ".jpg") + ".jpg",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "HEIC decode failed";
    throw new Error(`Could not decode HEIC "${input.name}": ${msg}`);
  }
}

/**
 * Stitches multiple image buffers into a single multi-page PDF.
 *
 *  - Each image becomes one page, sized to its own pixels (so portrait stays
 *    portrait, landscape stays landscape — no awkward auto-rotation).
 *  - HEIC and any other format Sharp understands gets normalised to JPEG
 *    first, since PDFs only embed JPEG/PNG natively.
 *  - JPEG quality is bumped down to 85 to keep the output under typical
 *    upload size limits without losing readable text.
 *  - Returns the PDF as a Buffer; caller is responsible for storing it.
 */
export async function combineImagesToPdf(
  inputs: CombineInput[]
): Promise<Buffer> {
  if (inputs.length === 0) {
    throw new Error("combineImagesToPdf: no images supplied");
  }

  const pdf = await PDFDocument.create();

  for (const original of inputs) {
    // Convert HEIC → JPEG if needed (iPhone Photos default format).
    const input = await maybeConvertHeic(original);
    // Normalise to JPEG (covers HEIC/HEIF/WebP/etc.) and let Sharp
    // tell us the final pixel dimensions.
    let normalised: Buffer;
    let width: number;
    let height: number;
    try {
      const pipe = sharp(input.buffer).rotate(); // honour EXIF orientation
      const meta = await pipe.metadata();
      const jpegBuffer = await pipe.jpeg({ quality: 85 }).toBuffer();
      normalised = jpegBuffer;
      width = meta.width || 1240;
      height = meta.height || 1754;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "image decode failed";
      throw new Error(`Could not read "${input.name}": ${msg}`);
    }

    const embedded = await pdf.embedJpg(normalised);
    const page = pdf.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
