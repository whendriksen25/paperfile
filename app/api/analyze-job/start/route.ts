import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { prepareAnalyzeJob } from "@/lib/services/analyze-job";
import { kickAndForget } from "@/lib/utils/kick";

export const runtime = "nodejs";
// 60s is plenty for the prepare step: download (~2s) + auto-rotate
// (~50ms) + Sonnet detection (~10s) + crop (~1s) + upload N crops
// (~1s each, parallelisable). On a Hobby plan we still want headroom.
export const maxDuration = 60;

/**
 * POST /api/analyze-job/start
 *
 * Body: { documentId: string, fromOriginal?: boolean, forceProfile?: boolean }
 *
 * Kicks off a background "re-analyse full scan" job. Returns the job's
 * id + total step count so the client can render the progress panel.
 *
 * Single-doc fallback: if Sonnet's detection finds only 1 document on
 * the scan, no job is created. The client should then POST to the
 * existing inline /api/analyze/[id] route (which is fine because the
 * job pattern only exists to fit MULTIPLE per-crop AI calls inside
 * the 60s ceiling). We return { jobId: null, fallback: 'single_doc_synchronous' }
 * so the client can distinguish.
 */
export async function POST(request: NextRequest) {
  console.log("[api/analyze-job/start] start");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      documentId?: string;
      fromOriginal?: boolean;
      forceProfile?: boolean;
    };
    if (!body.documentId) {
      return NextResponse.json(
        { error: "documentId required" },
        { status: 400 }
      );
    }

    const admin = await createServiceClient();
    // Verify the doc belongs to the calling user (defense in depth —
    // the service-role client bypasses RLS).
    const { data: doc } = await admin
      .from("documents")
      .select("id, user_id")
      .eq("id", body.documentId)
      .maybeSingle();
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if ((doc as { user_id: string }).user_id !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await prepareAnalyzeJob(admin, {
      documentId: body.documentId,
      userId: user.id,
      fromOriginal: body.fromOriginal !== false, // default true
      forceProfile: body.forceProfile === true,
    });

    if (result.singleDoc) {
      // Single-doc — tell the client to fall back to the inline analyze
      // route. We don't proxy it server-side because the inline route's
      // own auth + bookkeeping is best left where it is.
      return NextResponse.json({
        jobId: null,
        fallback: "single_doc_synchronous",
        reason: result.reason || null,
      });
    }

    // Kick the first step so the job self-drives. Each step self-chains the
    // next (see the analyze-step route), so the job runs to completion even
    // with NO UI polling — essential for fresh uploads handed off here. For
    // re-analyse the progress panel also polls, which just races harmlessly.
    // kickAndForget (awaited, ~2.5s max) guarantees the request is actually
    // DISPATCHED before this function returns and gets frozen — a plain
    // void-fetch here is routinely lost on Vercel.
    {
      const origin = request.nextUrl.origin;
      await kickAndForget(`${origin}/api/analyze-step/${result.jobId}`, {
        method: "POST",
        headers: { cookie: request.headers.get("cookie") || "" },
      });
    }

    return NextResponse.json({
      jobId: result.jobId,
      totalCrops: result.totalCrops,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Start failed";
    console.error("[api/analyze-job/start] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
