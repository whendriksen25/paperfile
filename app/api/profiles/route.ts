import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  console.log("[api/profiles GET]");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("is_default", { ascending: false })
    .order("name");
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(request: NextRequest) {
  console.log("[api/profiles POST]");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const name = (body.name as string | undefined)?.trim();
  if (!name)
    return NextResponse.json({ error: "Name required" }, { status: 400 });

  const type = body.type === "business" ? "business" : "person";
  const color = body.color || null;
  const description = (body.description as string | undefined) || null;
  const website = (body.website as string | undefined) || null;
  const ai_summary = (body.ai_summary as string | undefined) || null;
  const aliases = Array.isArray(body.aliases)
    ? (body.aliases as string[]).map((s) => s.trim()).filter(Boolean)
    : [];
  const attributes =
    body.attributes && typeof body.attributes === "object"
      ? (body.attributes as Record<string, string>)
      : {};

  const { data, error } = await supabase
    .from("profiles")
    .insert({
      user_id: user.id,
      name,
      type,
      color,
      description,
      website,
      ai_summary,
      aliases,
      attributes,
      is_default: false,
    })
    .select("*")
    .single();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
