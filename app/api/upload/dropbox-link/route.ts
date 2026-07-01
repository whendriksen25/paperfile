import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Step 1 of the direct-to-storage upload flow.
 *
 * Returns a one-time upload URL the browser can send the raw file bytes to,
 * landing the file directly in the storage backend's inbox WITHOUT the bytes
 * passing through this Vercel function. This is what lets large / multipage
 * documents bypass Vercel's ~4.5 MB request-body limit.
 *
 * The client then PUTs/POSTs the file straight to `uploadUrl`, and afterwards
 * calls POST /api/upload/finalize with the returned `path` + metadata.
 */
export async function POST(request: NextRequest) {
  console.log("[api/upload/dropbox-link] start");

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      filename?: unknown;
    };
    const filename =
      typeof body.filename === "string" && body.filename.trim()
        ? body.filename.trim()
        : null;
    if (!filename) {
      return NextResponse.json({ error: "filename required" }, { status: 400 });
    }

    const storage = getStorage();
    const { uploadUrl, path } = await storage.getTemporaryUploadLink({
      filename,
    });

    console.log("[api/upload/dropbox-link] done", path);
    return NextResponse.json({ uploadUrl, path, provider: storage.provider });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to get upload link";
    console.error("[api/upload/dropbox-link] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
