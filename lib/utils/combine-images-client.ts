"use client";

import { PDFDocument } from "pdf-lib";

/**
 * Stitches images into a single multi-page PDF, entirely in the browser.
 *
 * Each image becomes one page sized to its own pixels (portrait stays
 * portrait). Inputs MUST be JPEG — callers run `compressImageInBrowser` first,
 * which normalises any image (including iPhone HEIC) to JPEG. Running the stitch
 * client-side means a multipage scan can be combined and uploaded straight to
 * Dropbox without the raw pages ever passing through the app server (and its
 * ~4.5 MB request-body limit).
 *
 * Mirrors the server-side `combineImagesToPdf` output so downstream analysis is
 * identical.
 */
export async function combineImagesToPdfClient(
  files: File[],
  outName: string
): Promise<File> {
  if (files.length === 0) {
    throw new Error("combineImagesToPdfClient: no images supplied");
  }

  const pdf = await PDFDocument.create();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const img = await pdf.embedJpg(bytes);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }

  const bytes = await pdf.save();
  // Copy into a fresh ArrayBuffer-backed view so the File constructor's
  // BlobPart typing is satisfied (pdf-lib types its output as ArrayBufferLike,
  // which TS won't accept directly).
  const part = new Uint8Array(bytes.byteLength);
  part.set(bytes);
  const base = outName.trim() || `combined_${Date.now()}`;
  const name = base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
  return new File([part], name, { type: "application/pdf" });
}
