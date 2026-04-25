import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Inbox poll endpoint. Returns:
 *   - count: how many docs are mid-processing (drives the banner visibility)
 *   - stuck: docs whose analyze never fired or got dropped (status=pending
 *     for >20s, or status=processing with no updates for >2min). The banner
 *     uses this to auto-retry them via /api/analyze/[id].
 *
 * Why we need stuck-detection at all: the upload route fires the analyze
 * fetch and doesn't await it. In dev mode (and on serverless), that
 * fire-and-forget fetch can be dropped if the parent request finishes
 * before it lands. Without a safety net, the doc rots in 'pending' forever.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, status, created_at, updated_at")
    .in("status", ["pending", "processing"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = Date.now();
  const stuck: { id: string; status: string; stuck_seconds: number }[] = [];
  for (const d of data || []) {
    const updated = new Date(d.updated_at).getTime();
    const ageSec = Math.floor((now - updated) / 1000);
    // Pending > 20s = upload's fire-and-forget likely got dropped.
    // Processing > 120s = analyze hung mid-stream.
    if (
      (d.status === "pending" && ageSec > 20) ||
      (d.status === "processing" && ageSec > 120)
    ) {
      stuck.push({ id: d.id, status: d.status, stuck_seconds: ageSec });
    }
  }

  return NextResponse.json({
    count: (data || []).length,
    stuck,
  });
}
