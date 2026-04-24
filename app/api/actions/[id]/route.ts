import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/actions/:id PATCH]", id);
  const supabase = await createClient();
  const body = await request.json();

  const allowed = [
    "status",
    "snooze_until",
    "notes",
    "summary",
    "due_date",
    "action_type",
  ] as const;
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];

  // When marking done, stamp completed_at
  if (patch.status === "done") {
    patch.completed_at = new Date().toISOString();
  } else if (patch.status === "open" || patch.status === "snoozed") {
    patch.completed_at = null;
  }

  const { data, error } = await supabase
    .from("actions")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
