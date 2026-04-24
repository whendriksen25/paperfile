import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  console.log("[api/upload] start");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const batch = (formData.get("batch") as string | null) || null;
    const personRaw = (formData.get("person") as string | null) || null;
    const profileIdRaw = formData.get("profile_id") as string | null;
    const profileId = profileIdRaw ? Number(profileIdRaw) : null;
    const tagsRaw = (formData.get("tags") as string | null) || "";
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const buffer = Buffer.from(await file.arrayBuffer());

    // 1. Upload to the configured storage backend's staging area
    const storage = getStorage();
    const uploaded = await storage.uploadToInbox({
      buffer,
      filename: file.name,
    });

    // 2. Insert row (status = pending)
    const admin = await createServiceClient();
    const { data: row, error: insertError } = await admin
      .from("documents")
      .insert({
        user_id: user.id,
        dropbox_path: uploaded.path,
        storage_provider: storage.provider,
        file_name: file.name,
        file_type: file.type || null,
        file_size_bytes: uploaded.size,
        batch,
        person: personRaw,
        primary_profile_id: profileId,
        tags,
        status: "pending",
        uploaded_by: user.email || user.id,
      })
      .select("id, dropbox_path, status")
      .single();

    if (insertError || !row) {
      console.error("[api/upload] insert error", insertError);
      return NextResponse.json(
        { error: insertError?.message || "Insert failed" },
        { status: 500 }
      );
    }

    // 3. Kick off extraction asynchronously
    const analyzeUrl = new URL(
      `/api/analyze/${row.id}`,
      request.nextUrl.origin
    );
    fetch(analyzeUrl, {
      method: "POST",
      headers: { cookie: request.headers.get("cookie") || "" },
    }).catch((e) => console.error("[api/upload] analyze trigger failed", e));

    console.log("[api/upload] done", row.id);
    return NextResponse.json({ data: row });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    console.error("[api/upload] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
