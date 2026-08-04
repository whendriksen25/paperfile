import { PDFDocument } from "pdf-lib";
import { getStorage } from "@/lib/storage";
import { transcribePdfChunk } from "@/lib/ai/transcribe";
import { shrinkPdfForClaude, PDF_RAW_LIMIT_BYTES } from "./pdf-shrink";
import type { createServiceClient } from "@/lib/supabase/server";

type Admin = Awaited<ReturnType<typeof createServiceClient>>;

/** Pages per transcription chunk. 5 dense pages ≈ 3-6k output tokens —
 *  one comfortable Claude call well inside a function budget. */
export const TRANSCRIBE_CHUNK_PAGES = 5;

/** Auto-transcription threshold (pages). Shorter PDFs already get a full
 *  transcript from the main extraction; only longer ones need the
 *  chunked background pass. MUST match the hardcoded literal in
 *  app/api/analyze/[id]/route.ts (kept literal there so this module —
 *  which drags in pdf-lib + sharp — stays lazily imported). */
export const TRANSCRIBE_MIN_PAGES = 6;

export interface TranscriptState {
  status: "in_progress" | "done" | "failed";
  total_chunks: number;
  done_chunks: number;
  total_pages: number;
  /** Per-chunk transcripts, keyed by chunk index. Dropped on finalize —
   *  the assembled text lives in ocr_text. */
  parts?: Record<string, string>;
  error?: string;
  completed_at?: string;
}

/**
 * Transcribes ONE chunk of a document's PDF and persists progress under
 * extracted_fields._transcript. When the last chunk lands, assembles all
 * parts in page order into ocr_text (with page-range markers) and marks
 * the transcript done.
 *
 * Idempotent per chunk: re-running a chunk simply overwrites its part.
 */
export async function processTranscriptChunk(
  admin: Admin,
  docId: string,
  chunk: number
): Promise<{ totalChunks: number; doneChunks: number; done: boolean }> {
  const { data: doc, error } = await admin
    .from("documents")
    .select(
      "id, dropbox_path, storage_provider, file_name, file_type, extracted_fields"
    )
    .eq("id", docId)
    .maybeSingle();
  if (error || !doc) throw new Error("Document not found");

  // 1. Download + open the source PDF.
  const storage = getStorage(doc.storage_provider);
  const buffer = await storage.downloadFile(doc.dropbox_path);
  if (buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("Not a PDF — transcription only applies to PDF documents");
  }
  const src = await PDFDocument.load(buffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const totalPages = src.getPageCount();
  const totalChunks = Math.ceil(totalPages / TRANSCRIBE_CHUNK_PAGES);
  if (chunk < 0 || chunk >= totalChunks) {
    throw new Error(`Chunk ${chunk} out of range (0..${totalChunks - 1})`);
  }

  // 2. Copy this chunk's pages into a standalone mini-PDF.
  const from = chunk * TRANSCRIBE_CHUNK_PAGES;
  const to = Math.min(from + TRANSCRIBE_CHUNK_PAGES, totalPages); // exclusive
  const sub = await PDFDocument.create();
  const pages = await sub.copyPages(
    src,
    Array.from({ length: to - from }, (_, i) => from + i)
  );
  for (const p of pages) sub.addPage(p);
  let subBuffer: Buffer = Buffer.from(
    await sub.save({ useObjectStreams: true })
  ) as Buffer;

  // A 5-page slice of a huge scan can itself be oversized — shrink it the
  // same way the main extraction does.
  if (subBuffer.length > PDF_RAW_LIMIT_BYTES) {
    const shrunk = await shrinkPdfForClaude(subBuffer);
    subBuffer = shrunk.buffer;
  }

  // 3. Transcribe.
  const { text, usage } = await transcribePdfChunk(subBuffer);
  console.log(
    `[transcribe] doc ${docId} chunk ${chunk + 1}/${totalChunks} (p.${from + 1}-${to}): ${text.length} chars, ${usage.output_tokens} out-tokens`
  );

  // 4. Persist the part — read the FRESH row first so parallel chunks
  //    don't clobber each other's parts.
  const { data: fresh } = await admin
    .from("documents")
    .select("extracted_fields, ocr_text")
    .eq("id", docId)
    .maybeSingle();
  const ef =
    ((fresh?.extracted_fields as Record<string, unknown> | null) || {}) as Record<
      string,
      unknown
    >;
  const prev = (ef["_transcript"] as TranscriptState | undefined) || undefined;
  const parts: Record<string, string> = { ...(prev?.parts || {}) };
  parts[String(chunk)] = text;
  const doneChunks = Object.keys(parts).length;
  const allDone = doneChunks >= totalChunks;

  if (!allDone) {
    const state: TranscriptState = {
      status: "in_progress",
      total_chunks: totalChunks,
      done_chunks: doneChunks,
      total_pages: totalPages,
      parts,
    };
    await admin
      .from("documents")
      .update({ extracted_fields: { ...ef, _transcript: state } })
      .eq("id", docId);
    return { totalChunks, doneChunks, done: false };
  }

  // 5. Final chunk — assemble the full transcript in page order.
  const assembled = Array.from({ length: totalChunks }, (_, i) => {
    const f = i * TRANSCRIBE_CHUNK_PAGES + 1;
    const t = Math.min((i + 1) * TRANSCRIBE_CHUNK_PAGES, totalPages);
    const header = `===== Pagina ${f}–${t} van ${totalPages} =====`;
    return `${header}\n\n${(parts[String(i)] || "[deel ontbreekt]").trim()}`;
  }).join("\n\n");
  const state: TranscriptState = {
    status: "done",
    total_chunks: totalChunks,
    done_chunks: totalChunks,
    total_pages: totalPages,
    completed_at: new Date().toISOString(),
    // parts intentionally dropped — assembled text lives in ocr_text.
  };
  await admin
    .from("documents")
    .update({
      ocr_text: assembled,
      extracted_fields: { ...ef, _transcript: state },
    })
    .eq("id", docId);
  console.log(
    `[transcribe] doc ${docId} COMPLETE: ${totalPages} pages, ${assembled.length} chars`
  );
  return { totalChunks, doneChunks: totalChunks, done: true };
}

/** Marks the transcript failed so the UI can offer a retry. */
export async function markTranscriptFailed(
  admin: Admin,
  docId: string,
  message: string
): Promise<void> {
  const { data: fresh } = await admin
    .from("documents")
    .select("extracted_fields")
    .eq("id", docId)
    .maybeSingle();
  const ef =
    ((fresh?.extracted_fields as Record<string, unknown> | null) || {}) as Record<
      string,
      unknown
    >;
  const prev = (ef["_transcript"] as TranscriptState | undefined) || undefined;
  await admin
    .from("documents")
    .update({
      extracted_fields: {
        ...ef,
        _transcript: {
          status: "failed",
          total_chunks: prev?.total_chunks || 0,
          done_chunks: prev?.done_chunks || 0,
          total_pages: prev?.total_pages || 0,
          error: message.slice(0, 400),
        } satisfies TranscriptState,
      },
    })
    .eq("id", docId);
}
