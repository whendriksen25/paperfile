import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { runSanityCheck } from "@/lib/services/sanity-check";

export const runtime = "nodejs";
// Long-running: orphan recovery hits Dropbox per-doc, reclassify hits
// Dropbox per-move. 5 min headroom for a thousand-doc archive.
export const maxDuration = 300;

/**
 * POST /api/maintenance/sanity-check
 *
 * Runs the self-healing maintenance pipeline for the calling user:
 *   1. Detects + recovers orphan documents (file moved in Dropbox but
 *      DB row not updated). Conservative — only auto-repoints when
 *      there's exactly ONE size+sender match in Dropbox.
 *   2. Applies sender-history reclassification with safety guards
 *      (≥80% majority, no generic winners, no specific→generic downgrades).
 *
 * Every change is recorded in the maintenance_log table.
 *
 * Triggered by: a "Run now" button in the UI, OR fire-and-forget from
 * the upload route every 20 successful uploads.
 */
export async function POST(request: NextRequest) {
  console.log("[api/maintenance/sanity-check] start");
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = await createServiceClient();
    const result = await runSanityCheck(admin, user.id);

    return NextResponse.json({ ok: true, result });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Sanity check failed";
    console.error("[api/maintenance/sanity-check] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/maintenance/sanity-check
 *
 * Returns the most recent maintenance_log entries for the calling user
 * — used by the UI to show "last run" + "what was changed."
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limit = Math.min(
      Number(request.nextUrl.searchParams.get("limit") || "50"),
      200
    );
    const admin = await createServiceClient();
    const { data, error } = await admin
      .from("maintenance_log")
      .select("id, document_id, kind, reason, payload, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const lastRun = data && data.length > 0 ? data[0].created_at : null;
    return NextResponse.json({ ok: true, last_run: lastRun, entries: data });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to load log";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
