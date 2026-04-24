import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createDropbox, dropboxRootFolder } from "@/lib/dropbox/client";

export const runtime = "nodejs";

/** Dev-only: lists the root /Archive folder recursively for debugging. */
export async function POST(request: NextRequest) {
  if (process.env.DEV_AUTO_LOGIN !== "true") {
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  }
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  }
  const host = (request.headers.get("host") || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1") {
    return NextResponse.json({ error: "Localhost only." }, { status: 403 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const dbx = createDropbox();
  const root = dropboxRootFolder();

  try {
    const res = await dbx.filesListFolder({ path: root, recursive: true });
    const entries = res.result.entries.map((e) => ({
      tag: e[".tag"],
      path: e.path_display,
      size: (e as { size?: number }).size,
      modified: (e as { server_modified?: string }).server_modified,
    }));
    return NextResponse.json({ ok: true, root, count: entries.length, entries });
  } catch (e: unknown) {
    const err = e as { status?: number; error?: unknown; message?: string };
    return NextResponse.json({
      ok: false,
      root,
      dropbox_status: err.status || null,
      dropbox_error: err.error || err.message || "unknown",
    }, { status: 500 });
  }
}
