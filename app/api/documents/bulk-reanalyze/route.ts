import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/bulk-reanalyze
 *
 * Body: { document_ids: string[] }
 *
 * Re-runs the analyze pipeline on every listed document. The pipeline
 * itself does multi-doc detection: if a scan turns out to contain
 * multiple distinct documents, the extra ones are spawned as child
 * rows (parent_document_id pointing back at the original). So this
 * is the batch path for "split these existing scans where they should
 * be multiple documents."
 *
 * Auth: the user must be logged in. Each per-doc analyze call goes
 * through the existing /api/analyze/[id] route, which does its own
 * owner check. We just kick them off in parallel and wait.
 *
 * Concurrency: capped at 5 parallel to stay polite with the Anthropic
 * API and keep memory in check. For 50 selected docs that's ~10 waves.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      document_ids?: string[];
    };
    if (!Array.isArray(body.document_ids) || body.document_ids.length === 0) {
      return NextResponse.json(
        { error: "document_ids must be a non-empty array" },
        { status: 400 }
      );
    }
    if (body.document_ids.length > 50) {
      return NextResponse.json(
        { error: "max 50 documents per call" },
        { status: 400 }
      );
    }

    // Cookie forwarded so the inner /api/analyze/[id] sees the same
    // auth session.
    const cookie = request.headers.get("cookie") || "";
    const origin = request.nextUrl.origin;

    const CONCURRENCY = 5;
    const results: Array<{
      document_id: string;
      ok: boolean;
      child_count?: number;
      error?: string;
    }> = [];
    for (let i = 0; i < body.document_ids.length; i += CONCURRENCY) {
      const wave = body.document_ids.slice(i, i + CONCURRENCY);
      const waveResults = await Promise.all(
        wave.map(async (docId) => {
          try {
            const res = await fetch(`${origin}/api/analyze/${docId}`, {
              method: "POST",
              headers: { cookie },
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
              return {
                document_id: docId,
                ok: false,
                error: json.error || `HTTP ${res.status}`,
              };
            }
            const childCount = Array.isArray(json.child_document_ids)
              ? json.child_document_ids.length
              : 0;
            return {
              document_id: docId,
              ok: true,
              child_count: childCount,
            };
          } catch (e) {
            return {
              document_id: docId,
              ok: false,
              error: e instanceof Error ? e.message : "Network error",
            };
          }
        })
      );
      results.push(...waveResults);
    }

    const totalChildren = results.reduce(
      (sum, r) => sum + (r.child_count || 0),
      0
    );
    const failed = results.filter((r) => !r.ok).length;
    return NextResponse.json({
      attempted: results.length,
      succeeded: results.length - failed,
      failed,
      total_children_spawned: totalChildren,
      results,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Bulk re-analyze failed";
    console.error("[api/documents/bulk-reanalyze] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
