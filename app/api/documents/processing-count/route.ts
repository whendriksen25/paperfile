import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Lightweight poll endpoint — returns how many of the current user's
 * documents are still being processed by the AI. Used by the inbox
 * ProcessingBanner to show a live "AI working on N documents" indicator
 * and to decide when to refresh the server-rendered inbox.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "processing"]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ count: count || 0 });
}
