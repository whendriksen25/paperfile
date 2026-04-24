import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Upload endpoint for the iOS Shortcut. Authenticated via a bearer token
 * (stored in Supabase as a row in `shortcut_tokens`, or the SHORTCUT_MASTER_TOKEN env var).
 *
 * The iOS Shortcut should POST multipart/form-data with:
 *   - file: the file data
 *   - (optional) batch, person, tags
 *   - Authorization: Bearer <token>
 */
export async function POST(request: NextRequest) {
  console.log("[api/shortcut/upload] start");

  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const admin = await createServiceClient();

  let userId: string | null = null;

  // Option 1: master token from env (single-user convenience)
  const master = process.env.SHORTCUT_MASTER_TOKEN;
  if (master && token === master) {
    // Need a user to own the row. Use the first user in the DB (single-user app).
    const { data: firstUser } = await admin.auth.admin.listUsers();
    userId = firstUser?.users?.[0]?.id || null;
  }

  // Option 2: token stored in shortcut_tokens
  if (!userId) {
    const { data: row } = await admin
      .from("shortcut_tokens")
      .select("user_id")
      .eq("token", token)
      .maybeSingle();
    userId = row?.user_id || null;
    if (userId) {
      await admin
        .from("shortcut_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("token", token);
    }
  }

  if (!userId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }

  const batch = (formData.get("batch") as string | null) || null;
  const person = (formData.get("person") as string | null) || null;
  const tagsRaw = (formData.get("tags") as string | null) || "";
  const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);

  const buffer = Buffer.from(await file.arrayBuffer());
  const storage = getStorage();
  const uploaded = await storage.uploadToInbox({ buffer, filename: file.name });

  const { data: row, error } = await admin
    .from("documents")
    .insert({
      user_id: userId,
      dropbox_path: uploaded.path,
      storage_provider: storage.provider,
      file_name: file.name,
      file_type: file.type || null,
      file_size_bytes: uploaded.size,
      batch,
      person,
      tags,
      status: "pending",
      uploaded_by: "ios-shortcut",
    })
    .select("id")
    .single();

  if (error || !row) {
    return NextResponse.json({ error: error?.message || "Insert failed" }, { status: 500 });
  }

  // Trigger async extraction
  const analyzeUrl = new URL(`/api/analyze/${row.id}`, request.nextUrl.origin);
  fetch(analyzeUrl, { method: "POST" }).catch(() => {});

  console.log("[api/shortcut/upload] done", row.id);
  return NextResponse.json({ id: row.id, status: "pending" });
}
