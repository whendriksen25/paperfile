import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/:id GET]", id);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/:id PATCH]", id);
  const supabase = await createClient();
  const body = await request.json();

  const allowed = [
    "title",
    "summary",
    "sender",
    "recipient",
    "person",
    "document_type",
    "document_subtype",
    "document_date",
    "amount",
    "currency",
    "language",
    "tags",
    "batch",
    "status",
    "needs_review",
    "review_notes",
    "extracted_fields",
  ] as const;

  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];

  const { data, error } = await supabase
    .from("documents")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/:id DELETE soft]", id);
  const supabase = await createClient();
  const { error } = await supabase
    .from("documents")
    .update({ status: "deleted" })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
