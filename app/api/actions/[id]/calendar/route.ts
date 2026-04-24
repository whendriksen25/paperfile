import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildIcs } from "@/lib/exports/ics";

export const runtime = "nodejs";

/** GET /api/actions/[id]/calendar — single-action .ics download */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("actions")
    .select(
      "id, summary, action_type, due_date, document:documents(title, sender, file_name)"
    )
    .eq("id", id)
    .maybeSingle();
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const action = data as unknown as {
    id: string;
    summary: string;
    action_type: string;
    due_date: string | null;
    document?: { title: string | null; sender: string | null; file_name: string | null } | null;
  };

  if (!action.due_date) {
    return NextResponse.json(
      { error: "Action has no due date — nothing to schedule" },
      { status: 400 }
    );
  }

  const ics = buildIcs([
    {
      uid: action.id,
      summary: action.summary,
      description: `Action: ${action.action_type}\nDocument: ${
        action.document?.title || action.document?.file_name || ""
      }\nFrom: ${action.document?.sender || ""}`,
      date: action.due_date,
    },
  ]);

  return new NextResponse(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="paperfile-action-${action.id.slice(
        0,
        8
      )}.ics"`,
    },
  });
}
