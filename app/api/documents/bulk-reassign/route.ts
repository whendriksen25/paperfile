import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reassignDocumentsToProfile } from "@/lib/services/reassign-bulk";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/bulk-reassign
 *
 * Body: { document_ids: string[], to_profile_id: number, dry_run?: boolean }
 *
 * Reassigns each listed document to the target profile — moves the file
 * in storage (Dropbox), refreshes the shared link, updates the DB row,
 * and logs to maintenance_log. Per-doc fail-soft; returns a result list.
 *
 * Auth: the calling user must own every listed document. The service
 * layer enforces the cross-user refusal too as defence-in-depth.
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
      to_profile_id?: number;
      dry_run?: boolean;
    };
    if (!Array.isArray(body.document_ids) || body.document_ids.length === 0) {
      return NextResponse.json(
        { error: "document_ids must be a non-empty array" },
        { status: 400 }
      );
    }
    if (typeof body.to_profile_id !== "number") {
      return NextResponse.json(
        { error: "to_profile_id must be a number" },
        { status: 400 }
      );
    }
    if (body.document_ids.length > 500) {
      return NextResponse.json(
        { error: "max 500 documents per call" },
        { status: 400 }
      );
    }

    const admin = await createServiceClient();
    const result = await reassignDocumentsToProfile(
      admin,
      body.document_ids,
      body.to_profile_id,
      { dryRun: !!body.dry_run, userId: user.id }
    );

    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Bulk reassign failed";
    console.error("[api/documents/bulk-reassign] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
