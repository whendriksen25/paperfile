import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { combineImagesToPdf } from "@/lib/utils/combine-images";

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

    // Two ingest modes:
    //  - "combine=1" with N "files" (plural) — server stitches into a single PDF
    //  - default: one "file" — uploaded as-is
    const combine =
      (formData.get("combine") as string | null) === "1" ||
      (formData.get("combine") as string | null) === "true";

    let buffer: Buffer;
    let displayName: string;

    if (combine) {
      // Multiple-image stitch path. Accepts files under "files" OR
      // "files[]"; both are common.
      const collected: File[] = [];
      for (const k of ["files", "files[]"]) {
        for (const v of formData.getAll(k)) {
          if (v instanceof File) collected.push(v);
        }
      }
      if (collected.length === 0) {
        return NextResponse.json(
          { error: "Combine mode requires at least one file under 'files'." },
          { status: 400 }
        );
      }
      const inputs = await Promise.all(
        collected.map(async (f) => ({
          buffer: Buffer.from(await f.arrayBuffer()),
          name: f.name,
        }))
      );
      try {
        buffer = await combineImagesToPdf(inputs);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Combine failed";
        return NextResponse.json({ error: msg }, { status: 400 });
      }
      // Name the combined PDF after the user's choice (combinedName) or
      // fall back to a timestamped default.
      const requestedName =
        (formData.get("combinedName") as string | null) || null;
      const baseName = requestedName?.trim() || `combined_${Date.now()}`;
      displayName = baseName.toLowerCase().endsWith(".pdf")
        ? baseName
        : `${baseName}.pdf`;
      console.log(
        `[api/upload] combined ${inputs.length} images into ${displayName} (${buffer.length} bytes)`
      );
    } else {
      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: "No file provided" }, { status: 400 });
      }
      buffer = Buffer.from(await file.arrayBuffer());
      displayName = file.name;
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

    // Layer 1 dedup: SHA-256 hash of the final buffer (post-combine if
    // applicable). If the same user has already uploaded a doc with the
    // same hash, short-circuit — return their existing doc instead of
    // creating a duplicate row + uploading to Dropbox.
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const admin = await createServiceClient();
    {
      const { data: existing } = await admin
        .from("documents")
        .select("id, file_name, status, dropbox_path")
        .eq("user_id", user.id)
        .eq("content_hash", contentHash)
        .limit(1)
        .maybeSingle();
      if (existing) {
        console.log(
          "[api/upload] duplicate detected — returning existing doc",
          existing.id
        );
        return NextResponse.json({
          data: existing,
          duplicate: true,
          duplicate_of: existing.id,
          duplicate_reason: "Same file content (SHA-256) as an existing upload.",
        });
      }
    }

    // 1. Upload to the configured storage backend's staging area
    const storage = getStorage();
    const uploaded = await storage.uploadToInbox({
      buffer,
      filename: displayName,
    });

    // 2. Insert row (status = pending)
    const { data: row, error: insertError } = await admin
      .from("documents")
      .insert({
        user_id: user.id,
        dropbox_path: uploaded.path,
        storage_provider: storage.provider,
        file_name: displayName,
        file_type: combine ? "application/pdf" : ((formData.get("file") as File | null)?.type || null),
        file_size_bytes: uploaded.size,
        content_hash: contentHash,
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
