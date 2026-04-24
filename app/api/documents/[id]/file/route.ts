import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/:id/file]", id);
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("documents")
    .select("dropbox_path, storage_provider")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const storage = getStorage(doc.storage_provider);
    const link = await storage.getTemporaryLink(doc.dropbox_path);
    return NextResponse.json({ url: link });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Could not get file link";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
