import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  console.log("[api/actions GET]");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") || "open";
  const profileIdRaw = searchParams.get("profile_id");
  const profileId = profileIdRaw ? Number(profileIdRaw) : null;

  let query = supabase
    .from("actions")
    .select(
      "*, document:documents(id, title, sender, document_type, file_name, file_type, dropbox_path, amount, currency, extracted_fields)"
    )
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (status !== "all") {
    query = query.eq("status", status);
  }
  if (profileId) {
    query = query.eq("profile_id", profileId);
  }

  const { data, error } = await query;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
