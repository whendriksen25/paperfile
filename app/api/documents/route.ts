import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  INBOX_CARD_FIELDS,
  INBOX_PAGE_SIZE,
  reshapeInboxRow,
} from "@/lib/queries/inbox";

export const runtime = "nodejs";

/**
 * Inbox listing with cursor pagination.
 *
 * Query params:
 *   q          — full-text search (uses `fts` GIN index)
 *   type       — filter by document_type
 *   batch      — filter by batch
 *   profile_id — filter by primary_profile_id
 *   after      — ISO timestamp; returns docs older than this. Used by the
 *                infinite-scroll loader; the cursor is `created_at` so new
 *                uploads can't shift positions.
 *   limit      — page size (default INBOX_PAGE_SIZE, max 50)
 *
 * Returns:
 *   { data: DocumentRow[], next_cursor: string | null }
 *     next_cursor is the created_at of the last row, or null if there are
 *     no more pages.
 */
export async function GET(request: NextRequest) {
  console.log("[api/documents] start");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const q = sp.get("q");
  const type = sp.get("type");
  const batch = sp.get("batch");
  const profileId = sp.get("profile_id");
  const after = sp.get("after");
  const triage = sp.get("needs_review") === "1";
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || INBOX_PAGE_SIZE));

  let query = supabase
    .from("documents")
    .select(INBOX_CARD_FIELDS)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (q) query = query.textSearch("fts", q, { type: "websearch", config: "simple" });
  if (type) query = query.eq("document_type", type);
  if (batch) query = query.eq("batch", batch);
  // Profile filter is intentionally suppressed in triage mode — same logic
  // as the server-rendered inbox page (otherwise an unassigned doc gets
  // hidden behind an active profile filter when paginating).
  if (profileId && !triage) query = query.eq("primary_profile_id", Number(profileId));
  if (triage) {
    query = query.or("primary_profile_id.is.null,needs_review.eq.true");
  }
  // Cursor: anything strictly older than `after`. Using `lt` (not `lte`) so
  // we don't return the same boundary row twice across pages.
  if (after) query = query.lt("created_at", after);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = ((data || []) as unknown as Array<Record<string, unknown>>).map(
    reshapeInboxRow
  );
  const nextCursor =
    rows.length === limit ? rows[rows.length - 1].created_at : null;

  console.log("[api/documents] done", rows.length, "next?", !!nextCursor);
  return NextResponse.json({ data: rows, next_cursor: nextCursor });
}
