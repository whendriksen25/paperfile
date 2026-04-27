import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Dev-only: search docs by free-text — matches against sender, file_name,
 * title, person, or batch (case-insensitive contains). Returns enough info
 * per match to figure out where the doc is and what state it's in.
 *
 *   GET /api/admin-bridge/find?q=benu
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

  const q = request.nextUrl.searchParams.get("q") || "";
  const status = request.nextUrl.searchParams.get("status") || null;
  if (!q.trim() && !status)
    return NextResponse.json({ error: "Provide ?q= or ?status=" }, { status: 400 });

  const admin = await createServiceClient();
  let query = admin
    .from("documents")
    .select(
      "id, status, file_name, file_type, document_type, document_date, sender, recipient, title, person, primary_profile_id, dropbox_path, needs_review, review_notes, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (q.trim()) {
    const term = q.trim();
    query = query.or(
      `sender.ilike.%${term}%,file_name.ilike.%${term}%,title.ilike.%${term}%,person.ilike.%${term}%,batch.ilike.%${term}%,review_notes.ilike.%${term}%`
    );
  }
  if (status) {
    query = query.eq("status", status);
  }
  const { data, error } = await query;

  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // Also get profiles so the response is human-readable
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, name");
  const profileMap = new Map(
    ((profiles || []) as { id: number; name: string }[]).map((p) => [p.id, p.name])
  );

  const enriched = (data || []).map((d) => ({
    ...d,
    profile_name: d.primary_profile_id
      ? profileMap.get(d.primary_profile_id) || `id=${d.primary_profile_id}`
      : null,
  }));

  return NextResponse.json({ ok: true, count: enriched.length, docs: enriched });
}
