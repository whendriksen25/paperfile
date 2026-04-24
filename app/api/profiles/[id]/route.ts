import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** GET /api/profiles/[id] — fetch a single fresh profile row. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/profiles/:id GET]", id);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", Number(id))
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/profiles/:id PATCH]", id);
  const supabase = await createClient();
  const body = await request.json();

  const allowed = [
    "name",
    "type",
    "color",
    "is_default",
    "description",
    "aliases",
    "attributes",
    "ai_summary",
    "website",
  ] as const;
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];

  console.log("[api/profiles/:id PATCH] patch keys:", Object.keys(patch));

  // Setting is_default = true: clear any other default for this user first
  if (patch.is_default === true) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from("profiles")
        .update({ is_default: false })
        .eq("user_id", user.id)
        .neq("id", Number(id));
    }
  }

  // Defensive retry: if PostgREST's schema cache doesn't know a newer column,
  // strip it and retry so the user's other edits aren't lost.
  const droppedColumns: string[] = [];
  async function updateWithRetry(
    p: Record<string, unknown>,
    attempt = 0
  ): Promise<{
    data: unknown;
    error: { message: string } | null;
  }> {
    const result = await supabase
      .from("profiles")
      .update(p)
      .eq("id", Number(id))
      .select("*")
      .maybeSingle();
    if (result.error && attempt < 5) {
      const match = result.error.message.match(
        /Could not find the '([^']+)' column/
      );
      if (match && match[1] in p) {
        droppedColumns.push(match[1]);
        const copy = { ...p };
        delete copy[match[1]];
        console.warn(
          `[api/profiles/:id PATCH] column '${match[1]}' not in schema cache, retrying without it`
        );
        return updateWithRetry(copy, attempt + 1);
      }
    }
    return result;
  }

  const { data, error } = await updateWithRetry(patch);
  if (error) {
    console.error("[api/profiles/:id PATCH] failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (droppedColumns.length) {
    console.warn(
      "[api/profiles/:id PATCH] dropped columns during save:",
      droppedColumns
    );
  }
  return NextResponse.json({
    data,
    droppedColumns: droppedColumns.length ? droppedColumns : undefined,
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/profiles/:id DELETE]", id);
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("is_default")
    .eq("id", Number(id))
    .maybeSingle();
  if (profile?.is_default) {
    return NextResponse.json(
      {
        error:
          "Cannot delete the default profile. Make another profile default first.",
      },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("profiles")
    .delete()
    .eq("id", Number(id));
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
