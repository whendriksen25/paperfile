import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Step 2 of the direct-to-storage upload flow.
 *
 * The browser has already uploaded the file bytes straight to the storage
 * backend (via the one-time link from /api/upload/dropbox-link). This endpoint
 * receives ONLY the small metadata, confirms the file landed, dedups, inserts
 * the `documents` row (status = pending) and kicks off extraction — exactly
 * like the second half of /api/upload does today.
 *
 * Body (JSON):
 *   path           storage path the bytes landed at (from dropbox-link)
 *   fileName       display filename
 *   fileType       MIME type (ignored when combine=true → application/pdf)
 *   fileSizeBytes  client-reported size (server re-verifies against storage)
 *   contentHash    SHA-256 of the exact uploaded bytes (computed client-side)
 *   combine        true when the file is a browser-stitched multipage PDF
 *   batch, person, profileId, tags   optional filing metadata
 */
export async function POST(request: NextRequest) {
  console.log("[api/upload/finalize] start");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const {
      path,
      fileName,
      fileType,
      fileSizeBytes,
      contentHash,
      combine,
      batch,
      person,
      profileId,
      tags,
    } = body;

    if (typeof path !== "string" || !path) {
      return NextResponse.json({ error: "path required" }, { status: 400 });
    }
    if (typeof fileName !== "string" || !fileName) {
      return NextResponse.json({ error: "fileName required" }, { status: 400 });
    }
    if (typeof contentHash !== "string" || !contentHash) {
      return NextResponse.json(
        { error: "contentHash required" },
        { status: 400 }
      );
    }

    const storage = getStorage();

    // 1. Confirm the file actually landed in storage. Guards against a client
    //    that reported success but whose direct upload silently failed. Uses
    //    the backend's authoritative size; the client-reported size is only a
    //    fallback.
    const verifiedSize = await storage.getFileSize(path);
    if (verifiedSize === null) {
      return NextResponse.json(
        {
          error:
            "Uploaded file not found in storage — the direct upload may not have completed.",
        },
        { status: 409 }
      );
    }
    const sizeBytes =
      verifiedSize ||
      (typeof fileSizeBytes === "number" && Number.isFinite(fileSizeBytes)
        ? fileSizeBytes
        : 0);

    const admin = await createServiceClient();

    // 2. Dedup on content hash (same rule as /api/upload). Hash was computed
    //    client-side over the exact bytes that were uploaded.
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
          "[api/upload/finalize] duplicate detected — returning existing doc",
          existing.id
        );
        return NextResponse.json({
          data: existing,
          duplicate: true,
          duplicate_of: existing.id,
          duplicate_reason:
            "Same file content (SHA-256) as an existing upload.",
        });
      }
    }

    const profileIdNum =
      typeof profileId === "number"
        ? profileId
        : typeof profileId === "string" && profileId.trim()
          ? Number(profileId)
          : null;
    const tagList = Array.isArray(tags)
      ? tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const isCombined = combine === true || combine === "1" || combine === "true";

    // 3. Insert row (status = pending) — mirrors /api/upload's insert.
    const { data: row, error: insertError } = await admin
      .from("documents")
      .insert({
        user_id: user.id,
        dropbox_path: path,
        storage_provider: storage.provider,
        file_name: fileName,
        file_type: isCombined
          ? "application/pdf"
          : typeof fileType === "string"
            ? fileType
            : null,
        file_size_bytes: sizeBytes,
        content_hash: contentHash,
        batch: typeof batch === "string" && batch ? batch : null,
        person: typeof person === "string" && person ? person : null,
        primary_profile_id: profileIdNum,
        tags: tagList,
        status: "pending",
        uploaded_by: user.email || user.id,
      })
      .select("id, dropbox_path, status")
      .single();

    if (insertError || !row) {
      console.error("[api/upload/finalize] insert error", insertError);
      return NextResponse.json(
        { error: insertError?.message || "Insert failed" },
        { status: 500 }
      );
    }

    // 4. Kick off extraction asynchronously (same as /api/upload).
    const analyzeUrl = new URL(
      `/api/analyze/${row.id}`,
      request.nextUrl.origin
    );
    fetch(analyzeUrl, {
      method: "POST",
      headers: { cookie: request.headers.get("cookie") || "" },
    }).catch((e) =>
      console.error("[api/upload/finalize] analyze trigger failed", e)
    );

    // 5. Periodic self-healing sanity check every 20th upload (same as
    //    /api/upload).
    try {
      const { count } = await admin
        .from("documents")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id);
      if (count && count % 20 === 0) {
        console.log(
          "[api/upload/finalize] triggering sanity check at count",
          count
        );
        const sanityUrl = new URL(
          `/api/maintenance/sanity-check`,
          request.nextUrl.origin
        );
        fetch(sanityUrl, {
          method: "POST",
          headers: { cookie: request.headers.get("cookie") || "" },
        }).catch((e) =>
          console.warn("[api/upload/finalize] sanity-check trigger failed", e)
        );
      }
    } catch (e) {
      console.warn(
        "[api/upload/finalize] count query for sanity-check failed",
        e
      );
    }

    console.log("[api/upload/finalize] done", row.id);
    return NextResponse.json({ data: row });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Finalize failed";
    console.error("[api/upload/finalize] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
