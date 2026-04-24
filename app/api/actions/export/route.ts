import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildIcs } from "@/lib/exports/ics";
import { toCsv } from "@/lib/exports/csv";

export const runtime = "nodejs";

/**
 * GET /api/actions/export?format=ics|trello&status=open|all
 *
 * - `ics`: returns a calendar feed of open actions (subscribable in Apple/Google/Outlook).
 * - `trello`: returns a CSV with columns Trello (and most kanban tools) recognise.
 */
export async function GET(request: NextRequest) {
  console.log("[api/actions/export]");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const format = (searchParams.get("format") || "ics").toLowerCase();
  const status = searchParams.get("status") || "open";

  let q = supabase
    .from("actions")
    .select(
      "id, summary, action_type, due_date, status, document:documents(title, sender, document_type, file_name)"
    )
    .order("due_date", { ascending: true, nullsFirst: false });
  if (status !== "all") q = q.eq("status", status);

  const { data, error } = await q;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  type ActRow = {
    id: string;
    summary: string;
    action_type: string;
    due_date: string | null;
    status: string;
    document?: {
      title: string | null;
      sender: string | null;
      document_type: string | null;
      file_name: string | null;
    } | null;
  };
  // Supabase returns related document as an array — flatten to a single object.
  const rows: ActRow[] = ((data || []) as unknown as Array<Record<string, unknown>>).map(
    (r) => ({
      id: r.id as string,
      summary: r.summary as string,
      action_type: r.action_type as string,
      due_date: (r.due_date as string | null) || null,
      status: r.status as string,
      document: Array.isArray(r.document)
        ? (r.document[0] as ActRow["document"]) || null
        : ((r.document as ActRow["document"]) || null),
    })
  );

  if (format === "ics") {
    const events = rows
      .filter((r) => r.due_date)
      .map((r) => ({
        uid: r.id,
        summary: r.summary,
        description: `Action: ${r.action_type}\nDocument: ${
          r.document?.title || r.document?.file_name || ""
        }\nFrom: ${r.document?.sender || ""}`,
        date: r.due_date as string,
      }));
    const ics = buildIcs(events);
    return new NextResponse(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": 'attachment; filename="paperfile-actions.ics"',
      },
    });
  }

  if (format === "trello" || format === "csv") {
    // Trello CSV: Card name, Description, Labels, Due Date, List
    const headers = ["Name", "Description", "Labels", "Due Date", "List"];
    const csvRows = rows.map((r) => [
      r.summary,
      `Action type: ${r.action_type}\nDocument: ${
        r.document?.title || r.document?.file_name || ""
      }\nSender: ${r.document?.sender || ""}`,
      [r.action_type, r.document?.document_type].filter(Boolean).join(","),
      r.due_date || "",
      r.status === "open" ? "To Do" : r.status === "done" ? "Done" : "Backlog",
    ]);
    const csv = toCsv(headers, csvRows);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition":
          'attachment; filename="paperfile-actions-trello.csv"',
      },
    });
  }

  return NextResponse.json({ error: "Unknown format" }, { status: 400 });
}
