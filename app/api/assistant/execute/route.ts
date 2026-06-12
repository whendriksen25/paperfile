import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ACTION_TOOLS } from "@/lib/ai/assistant-tools";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/assistant/execute — runs a confirmed assistant proposal.
// Body: { tool: string, input: Record<string, unknown> }
//
// Only called after the user clicked Confirm in the chat. Mutations reuse
// the app's existing API routes via an internal fetch with the caller's
// cookies forwarded — so every validation, storage move, and side effect
// (Dropbox re-filing, Google Tasks closing, bookkeeping push, action
// bookkeeping) behaves exactly as if the user clicked the button in the UI.
export async function POST(request: NextRequest) {
  console.log("[api/assistant/execute] POST start");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const tool: string = body.tool;
  const input: Record<string, unknown> = body.input || {};

  if (!tool || !ACTION_TOOLS.has(tool)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const origin = request.nextUrl.origin;
  const cookie = request.headers.get("cookie") || "";
  const internal = async (
    path: string,
    method: string,
    json?: Record<string, unknown>
  ) => {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };

  try {
    if (tool === "refile_document") {
      const id = String(input.document_id || "");
      const payload: Record<string, unknown> = {};
      if (typeof input.profile_id === "number") payload.profile_id = input.profile_id;
      if (typeof input.document_type === "string" && input.document_type)
        payload.document_type = input.document_type;
      const r = await internal(`/api/documents/${id}/refile`, "POST", payload);
      if (!r.ok)
        return NextResponse.json(
          { error: (r.data as { error?: string }).error || "Re-file failed" },
          { status: 502 }
        );
      return NextResponse.json({ success: true, summary: "Document re-filed." });
    }

    if (tool === "create_action") {
      const { error } = await supabase.from("actions").insert({
        user_id: user.id,
        document_id:
          typeof input.document_id === "string" && input.document_id
            ? input.document_id
            : null,
        profile_id: typeof input.profile_id === "number" ? input.profile_id : null,
        action_type:
          typeof input.action_type === "string" && input.action_type
            ? input.action_type
            : "other",
        summary: String(input.summary || "").slice(0, 500),
        due_date:
          typeof input.due_date === "string" && input.due_date ? input.due_date : null,
        status: "open",
      });
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ success: true, summary: "Action created." });
    }

    if (tool === "complete_action" || tool === "dismiss_action") {
      const id = String(input.action_id || "");
      const patch: Record<string, unknown> =
        tool === "complete_action"
          ? {
              status: "done",
              ...(typeof input.note === "string" && input.note
                ? { notes: input.note }
                : {}),
            }
          : { status: "dismissed" };
      const r = await internal(`/api/actions/${id}`, "PATCH", patch);
      if (!r.ok)
        return NextResponse.json(
          { error: (r.data as { error?: string }).error || "Update failed" },
          { status: 502 }
        );
      return NextResponse.json({
        success: true,
        summary: tool === "complete_action" ? "Action marked done." : "Action dismissed.",
      });
    }

    if (tool === "send_to_bookkeeping") {
      const id = String(input.document_id || "");
      const r = await internal(`/api/documents/${id}/send-to-bookkeeping`, "POST");
      if (!r.ok)
        return NextResponse.json(
          { error: (r.data as { error?: string }).error || "Push failed" },
          { status: 502 }
        );
      const d = r.data as {
        imported?: number | null;
        skipped_duplicates?: number | null;
      };
      const detail =
        d.imported != null
          ? ` ${d.imported} imported, ${d.skipped_duplicates ?? 0} already known.`
          : "";
      return NextResponse.json({
        success: true,
        summary: `Sent to bookkeeping.${detail}`,
      });
    }

    if (tool === "reanalyze_document") {
      const id = String(input.document_id || "");
      const r = await internal(`/api/analyze/${id}?force_profile=1`, "POST");
      if (!r.ok)
        return NextResponse.json(
          { error: (r.data as { error?: string }).error || "Re-analysis failed" },
          { status: 502 }
        );
      return NextResponse.json({ success: true, summary: "Re-analysis complete." });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    console.error("[api/assistant/execute] error:", err);
    return NextResponse.json({ error: "Action failed." }, { status: 500 });
  }
}
