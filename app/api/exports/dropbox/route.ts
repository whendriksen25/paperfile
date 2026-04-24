import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { dropboxRootFolder } from "@/lib/dropbox/client";
import { toCsv } from "@/lib/exports/csv";
import { safeSegment } from "@/lib/dropbox/upload";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/exports/dropbox
 * Body: { type?: string, profile_id?: number, batch?: string, label?: string }
 * Writes a CSV of the matched documents to /Archive/_exports/{date}_{slug}.csv
 * Returns { path, count, shareLink }.
 */
export async function POST(request: NextRequest) {
  console.log("[api/exports/dropbox] start");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const type = (body.type as string | undefined) || null;
  const profileId = body.profile_id ? Number(body.profile_id) : null;
  const batch = (body.batch as string | undefined) || null;
  const label = (body.label as string | undefined) || null;

  const admin = await createServiceClient();
  let q = admin
    .from("documents")
    .select(
      "id, title, sender, recipient, document_date, amount, currency, document_type, purchase_category, batch, primary_profile_id, dropbox_path, action_summary, due_date, file_name"
    )
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .order("created_at", { ascending: false });

  if (type) q = q.eq("document_type", type);
  if (profileId) q = q.eq("primary_profile_id", profileId);
  if (batch) q = q.eq("batch", batch);

  const { data, error } = await q;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data || []) as Record<string, unknown>[];

  const headers = [
    "id",
    "title",
    "sender",
    "recipient",
    "document_date",
    "amount",
    "currency",
    "document_type",
    "purchase_category",
    "batch",
    "file_name",
    "dropbox_path",
    "action_summary",
    "due_date",
  ];
  const csv = toCsv(
    headers,
    rows.map((r) => headers.map((h) => r[h] as string | number | null))
  );

  const today = new Date().toISOString().slice(0, 10);
  const slug = safeSegment(label || type || batch || "all");
  const exportPath = `${dropboxRootFolder()}/_exports/${today}_${slug}.csv`;
  const storage = getStorage();
  const uploaded = await storage.uploadAt({
    buffer: Buffer.from(csv, "utf8"),
    path: exportPath,
  });
  const shareLink = await storage.getOrCreateShareLink(uploaded.path);

  console.log("[api/exports/dropbox] done", uploaded.path, rows.length);
  return NextResponse.json({
    path: uploaded.path,
    count: rows.length,
    shareLink,
  });
}
