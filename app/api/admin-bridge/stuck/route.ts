import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Dev-only: lists every document currently in pending/processing status
 * along with when it was created, when it was last updated, file size, and
 * how many minutes it's been stuck. Used to triage docs that never finished
 * the AI extraction pipeline.
 *
 * Open in a browser at:
 *   http://localhost:3002/api/admin-bridge/stuck
 */
export async function GET(request: NextRequest) {
  if (process.env.DEV_AUTO_LOGIN !== "true")
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  if (process.env.NODE_ENV === "production")
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  const host = (request.headers.get("host") || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1")
    return NextResponse.json({ error: "Localhost only." }, { status: 403 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createServiceClient();
  const { data, error } = await admin
    .from("documents")
    .select(
      "id, status, file_name, file_type, file_size_bytes, dropbox_path, storage_provider, created_at, updated_at, review_notes, primary_profile_id"
    )
    .in("status", ["pending", "processing"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  const enriched = (data || []).map((d) => {
    const created = new Date(d.created_at).getTime();
    const updated = new Date(d.updated_at).getTime();
    return {
      ...d,
      stuck_minutes: Math.floor((now - updated) / 60000),
      age_minutes: Math.floor((now - created) / 60000),
      file_size_mb: d.file_size_bytes
        ? +(d.file_size_bytes / 1024 / 1024).toFixed(2)
        : null,
    };
  });

  return NextResponse.json({
    ok: true,
    count: enriched.length,
    docs: enriched,
  });
}
