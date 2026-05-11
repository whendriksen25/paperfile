/**
 * Client-side image compression — runs in the browser BEFORE the file leaves
 * the phone. Two reasons it matters:
 *
 *  1. iPhone Photos saves in HEIC by default. Sharp on the server can't
 *     decode HEIC reliably (its bundled libheif only supports AVIF). Doing
 *     the decode in the browser sidesteps that entirely.
 *  2. Vercel Hobby has a 4.5 MB request body limit. A 4-page iPhone scan
 *     is easily 10+ MB of HEIC, which fails at the edge before our function
 *     even runs. Compressed JPEGs at ~300 KB each fit comfortably.
 *
 * Decode strategy:
 *   - First try the browser's native image decoder (works for HEIC on iOS
 *     Safari and macOS Safari, and for everything everywhere else).
 *   - If that fails, dynamically import heic2any (~700 KB WASM) and decode
 *     via libheif — this is the cross-browser HEIC fallback.
 *
 * Output: JPEG at the requested quality, scaled so the longest edge is at
 * most `maxDimension` pixels (preserves aspect ratio).
 */

const HEIC_BRANDS = new Set(["heic", "heix", "mif1", "msf1", "heim", "heis"]);

/** Sniff HEIC by magic bytes (don't trust the file extension). */
async function isHeicFile(file: File): Promise<boolean> {
  if (file.size < 12) return false;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  // ftyp box at bytes 4-7
  const ftyp = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (ftyp !== "ftyp") return false;
  const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
  return HEIC_BRANDS.has(brand);
}

/**
 * Loads any image (HEIC included on Safari) into an HTMLImageElement.
 * Throws if the browser can't decode the format natively.
 */
function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser could not decode image natively"));
    };
    img.src = url;
  });
}

/** Convert HEIC → JPEG using heic2any (lazy-loaded WASM). */
async function heicToJpegBlob(file: File): Promise<Blob> {
  // Dynamic import so the 700 KB WASM only ships when actually needed.
  // heic2any's CJS export is a function; ESM dynamic import wraps it under
  // .default. Cast through unknown to satisfy the strict type checker.
  const mod = (await import("heic2any")) as unknown as {
    default: (opts: {
      blob: Blob;
      toType?: string;
      quality?: number;
    }) => Promise<Blob | Blob[]>;
  };
  const out = await mod.default({
    blob: file,
    toType: "image/jpeg",
    quality: 0.9,
  });
  return Array.isArray(out) ? out[0] : out;
}

/**
 * Decode + resize + recompress to a JPEG File. Safe to call on any image
 * format the browser can read; HEIC is handled via the heic2any fallback.
 */
export async function compressImageInBrowser(
  file: File,
  opts: { maxDimension?: number; quality?: number } = {}
): Promise<File> {
  const maxDimension = opts.maxDimension ?? 2000;
  const quality = opts.quality ?? 0.85;

  // 1. Get an Image we can draw — try native decode first, HEIC fallback if that fails
  let img: HTMLImageElement;
  try {
    img = await loadImageFromBlob(file);
  } catch (nativeErr) {
    // Likely HEIC on a browser that can't decode natively (Chrome/Firefox).
    if (!(await isHeicFile(file))) throw nativeErr;
    const jpegBlob = await heicToJpegBlob(file);
    img = await loadImageFromBlob(jpegBlob);
  }

  // 2. Compute target dimensions (keep aspect ratio)
  const longest = Math.max(img.width, img.height);
  const scale = longest > maxDimension ? maxDimension / longest : 1;
  const targetW = Math.round(img.width * scale);
  const targetH = Math.round(img.height * scale);

  // 3. Draw to canvas + export as JPEG
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob returned null"))),
      "image/jpeg",
      quality
    );
  });

  // 4. Wrap as a File so FormData treats it like an upload
  const newName = file.name
    .replace(/\.(heic|heif)$/i, ".jpg")
    .replace(/\.(png|webp|gif|tiff?)$/i, ".jpg");
  return new File([blob], newName, { type: "image/jpeg" });
}

/**
 * Light decision helper: does this file actually need compression?
 *
 *  - PDFs: never (already optimised, and we don't compress them).
 *  - Anything ≤ maxBytes: skip — small enough to fit in Vercel's 4.5 MB
 *    body limit comfortably with margin. Compression is purely an
 *    optimisation for large iPhone scans; small files don't need it.
 *    Skipping HEIC compression for small files is safe because the server
 *    has its own HEIC fallback (heic-convert).
 *  - Everything else (HEIC, large JPEGs, PNGs > maxBytes): compress.
 *
 * Default threshold is 1 MB — slightly higher than before so common
 * iPhone camera output (700 KB-ish JPEGs) skips the canvas/heic2any
 * path entirely, which was the source of "Load failed" errors on iOS
 * when the dynamic import for heic2any flaked.
 */
export function shouldCompress(file: File, maxBytes = 1_000_000): boolean {
  if (file.type === "application/pdf") return false;
  // Non-image formats (CSV, XML, plain text — used for bank statement
  // imports) get uploaded as-is. Compression only ever applied to images.
  if (file.type && !file.type.startsWith("image/")) return false;
  // File-extension fallback for browsers that don't fill .type reliably.
  if (/\.(csv|xml|tsv|txt|json)$/i.test(file.name)) return false;
  if (file.size <= maxBytes) return false;
  return true;
}
