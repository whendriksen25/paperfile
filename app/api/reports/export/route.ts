import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toCsv } from "@/lib/exports/csv";

export const runtime = "nodejs";

const MEDICAL_TYPES = [
  "medical_bill",
  "prescription",
  "lab_result",
  "appointment_letter",
];

function periodRange(period: string): { from: string | null; to: string | null } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case "all":
      return { from: null, to: null };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return {
        from: new Date(y, qStart, 1).toISOString().slice(0, 10),
        to: new Date(y, qStart + 3, 0).toISOString().slice(0, 10),
      };
    }
    case "this_year":
    default:
      return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/**
 * GET /api/reports/export?profile_id=4&type=medical_bill&type=prescription&period=this_year
 *
 * Returns a CSV download of the filtered documents — same filters as
 * /reports. Designed to be handed straight to a tax form, an insurer, or
 * a bookkeeper.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const profileId = sp.get("profile_id") ? Number(sp.get("profile_id")) : null;
  const types = sp.getAll("type").length ? sp.getAll("type") : MEDICAL_TYPES;
  const period = sp.get("period") || "this_year";
  const { from, to } = periodRange(period);

  let q = supabase
    .from("documents")
    .select(
      "id, document_date, sender, recipient, title, document_type, document_subtype, amount, currency, primary_profile_id, dropbox_path, extracted_fields"
    )
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .in("document_type", types)
    .order("document_date", { ascending: false, nullsFirst: false })
    .limit(2000);
  if (profileId) q = q.eq("primary_profile_id", profileId);
  if (from) q = q.gte("document_date", from);
  if (to) q = q.lte("document_date", to);

  const { data, error } = await q;
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve profile names so the CSV is human-readable
  const { data: profileData } = await supabase.from("profiles").select("id, name");
  const profileMap = new Map(
    ((profileData || []) as { id: number; name: string }[]).map((p) => [p.id, p.name])
  );

  type Row = {
    id: string;
    document_date: string | null;
    sender: string | null;
    recipient: string | null;
    title: string | null;
    document_type: string | null;
    document_subtype: string | null;
    amount: number | null;
    currency: string | null;
    primary_profile_id: number | null;
    dropbox_path: string | null;
    extracted_fields: Record<string, unknown> | null;
  };

  const headers = [
    "document_date",
    "sender",
    "recipient",
    "title",
    "type",
    "subtype",
    "amount",
    "currency",
    "profile",
    "payment_status",
    "paid_date",
    "dropbox_path",
  ];
  const rows = ((data || []) as Row[]).map((d) => {
    const ef = (d.extracted_fields as Record<string, unknown> | null) || {};
    return [
      d.document_date || "",
      d.sender || "",
      d.recipient || "",
      d.title || "",
      d.document_type || "",
      d.document_subtype || "",
      d.amount != null ? d.amount : "",
      d.currency || "",
      d.primary_profile_id ? profileMap.get(d.primary_profile_id) || "" : "",
      String(ef["payment_status"] || ""),
      String(ef["paid_date"] || ""),
      d.dropbox_path || "",
    ];
  });

  const csv = toCsv(headers, rows);
  const filenameBits = [
    "paperfile-report",
    profileId ? profileMap.get(profileId)?.toLowerCase() : "all",
    period,
    new Date().toISOString().slice(0, 10),
  ].filter(Boolean);
  const filename = filenameBits.join("_") + ".csv";

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
