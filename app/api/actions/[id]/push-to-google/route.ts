import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { createGoogleTask } from "@/lib/integrations/google-tasks";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/actions/[id]/push-to-google
 *
 * Pushes a single Paperfile action into the user's "Paperfile" Google Tasks
 * list. Creates the list if missing. Stores the returned Google task id +
 * list id back on the action so future "mark done" can sync.
 *
 * Idempotent: if the action already has a google_task_id, returns it
 * without creating a duplicate.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = await createServiceClient();
  const { data: action, error } = await admin
    .from("actions")
    .select(
      "id, user_id, summary, due_date, action_type, google_task_id, google_task_list_id, document_id, document:documents(title, sender, dropbox_shared_link)"
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !action) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (action.google_task_id) {
    return NextResponse.json({
      ok: true,
      already_pushed: true,
      task_id: action.google_task_id,
    });
  }

  // Build a small notes block linking back to Paperfile + the source.
  const doc = (action.document as
    | { title?: string | null; sender?: string | null; dropbox_shared_link?: string | null }
    | null) || null;
  const origin = process.env.NEXT_PUBLIC_APP_URL || "";
  const notes = [
    doc?.sender ? `From: ${doc.sender}` : null,
    doc?.title ? `Doc: ${doc.title}` : null,
    origin && action.document_id
      ? `Open in Paperfile: ${origin}/document/${action.document_id}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const created = await createGoogleTask(user.id, {
      title: action.summary,
      notes,
      due: action.due_date,
    });

    await admin
      .from("actions")
      .update({
        google_task_id: created.task_id,
        google_task_list_id: created.list_id,
        google_task_synced_at: new Date().toISOString(),
      })
      .eq("id", id);

    return NextResponse.json({ ok: true, task_id: created.task_id });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Push failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
