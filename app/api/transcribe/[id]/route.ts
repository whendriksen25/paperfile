import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import {
  processTranscriptChunk,
  markTranscriptFailed,
} from "@/lib/services/transcribe";
import { kickAndForget } from "@/lib/utils/kick";

export const runtime = "nodejs";
// One chunk = one Claude call (≤5 pages, ~16k token cap). Comfortably
// inside 300s even for dense pages + a shrink pass.
export const maxDuration = 300;

/**
 * POST /api/transcribe/[id]?chunk=N
 *
 * Transcribes chunk N (5 pages) of the document's PDF verbatim and
 * self-chains chunk N+1 until the whole document is done, then assembles
 * the full transcript into ocr_text. Kick with chunk=0 (or omit chunk).
 *
 * Auto-triggered by /api/analyze for PDFs of 6+ pages; also wired to the
 * "Transcribe full text" button on the document detail page.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const chunk = Math.max(0, Number(request.nextUrl.searchParams.get("chunk")) || 0);
  console.log("[api/transcribe] start", id, "chunk", chunk);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await createServiceClient();
  // Ownership check — the service client bypasses RLS.
  const { data: doc } = await admin
    .from("documents")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((doc as { user_id: string }).user_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const result = await processTranscriptChunk(admin, id, chunk);

    if (!result.done) {
      // Chain the next chunk. kickAndForget guarantees dispatch before
      // this function is frozen (a plain void-fetch chain silently breaks).
      const next = `${request.nextUrl.origin}/api/transcribe/${id}?chunk=${chunk + 1}`;
      await kickAndForget(next, {
        method: "POST",
        headers: { cookie: request.headers.get("cookie") || "" },
      });
    }

    console.log(
      "[api/transcribe] done",
      id,
      `chunk ${chunk + 1}/${result.totalChunks}`,
      result.done ? "(transcript complete)" : ""
    );
    return NextResponse.json({
      ok: true,
      chunk,
      total_chunks: result.totalChunks,
      done_chunks: result.doneChunks,
      done: result.done,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Transcription failed";
    console.error("[api/transcribe] error:", msg);
    try {
      await markTranscriptFailed(admin, id, msg);
    } catch {
      /* best effort */
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
