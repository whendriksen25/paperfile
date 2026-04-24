import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  console.log("[api/documents] start");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const type = searchParams.get("type");
  const batch = searchParams.get("batch");
  const person = searchParams.get("person");

  let query = supabase
    .from("documents")
    .select("*")
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(200);

  if (q) {
    query = query.textSearch("fts", q, { type: "websearch", config: "simple" });
  }
  if (type) query = query.eq("document_type", type);
  if (batch) query = query.eq("batch", batch);
  if (person) query = query.eq("person", person);

  const { data, error } = await query;
  console.log("[api/documents] done", data?.length);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
