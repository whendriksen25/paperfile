import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { normalizeSender } from "@/lib/services/sender-history";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/documents/[id]/propagate-refile
 *
 * After the user has refiled a single document, this endpoint propagates
 * that correction (document_type and/or primary_profile_id) to every
 * sibling — other docs from the same sender — that's currently classified
 * differently. Each sibling is moved in Dropbox to its new structured
 * path, the share link is refreshed, and the row is updated.
 *
 * Triggered by the "Apply to N similar docs" banner shown by the
 * RefileWidget after a user save when sibling_count > 0.
 *
 * The "source" doc (the one the user just refiled) is the source of
 * truth: its current document_type and primary_profile_id are what get
 * propagated. We don't second-guess via sender-history scoring — the
 * user explicitly picked these values.
 *
 * Safety: only the calling user's own docs are touched (RLS + explicit
 * user_id filter on the admin client). Every change is recorded in
 * maintenance_log.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/[id]/propagate-refile] start", id);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = await createServiceClient();
    // Source doc — establishes sender + the target type/profile values
    const { data: source, error: srcErr } = await admin
      .from("documents")
      .select("id, sender, document_type, primary_profile_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (srcErr || !source) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    if (!source.sender) {
      return NextResponse.json(
        { error: "Source document has no sender — nothing to propagate by." },
        { status: 400 }
      );
    }

    const senderNorm = normalizeSender(source.sender);
    const targetType = source.document_type as string | null;
    const targetProfileId = source.primary_profile_id as number | null;

    // Profile name lookup for buildDestinationPath
    let targetProfileName: string | null = null;
    if (targetProfileId) {
      const { data: prof } = await admin
        .from("profiles")
        .select("name")
        .eq("id", targetProfileId)
        .eq("user_id", user.id)
        .maybeSingle();
      targetProfileName = (prof?.name as string) || null;
    }

    // Find siblings (same user + same normalised sender, excluding source)
    const { data: candidates } = await admin
      .from("documents")
      .select(
        "id, sender, document_type, primary_profile_id, document_date, file_name, title, dropbox_path, dropbox_shared_link, storage_provider"
      )
      .eq("user_id", user.id)
      .eq("status", "processed")
      .neq("id", id)
      .not("sender", "is", null);

    const siblings = (candidates || []).filter(
      (c) => normalizeSender(c.sender as string) === senderNorm
    );

    let updated = 0;
    let failed = 0;
    const results: Array<{
      id: string;
      from_path: string | null;
      to_path?: string;
      error?: string;
    }> = [];

    for (const s of siblings) {
      const typeChanged = s.document_type !== targetType;
      const profileChanged = s.primary_profile_id !== targetProfileId;
      if (!typeChanged && !profileChanged) continue;

      // Look up sibling's current profile name (in case we're not changing
      // it but still need it for the destination path).
      let pName: string | null = targetProfileName;
      if (!profileChanged && s.primary_profile_id) {
        const { data: prof } = await admin
          .from("profiles")
          .select("name")
          .eq("id", s.primary_profile_id)
          .eq("user_id", user.id)
          .maybeSingle();
        pName = (prof?.name as string) || null;
      }

      const storage = getStorage(s.storage_provider);
      const destination = storage.buildDestinationPath({
        profileSlug: pName,
        documentType: targetType,
        documentDateISO: s.document_date,
        filename: s.file_name || "file.bin",
        sender: s.sender as string,
        title: s.title,
      });

      try {
        let newPath = s.dropbox_path as string;
        if (s.dropbox_path && destination !== s.dropbox_path) {
          newPath = await storage.moveFile(s.dropbox_path, destination);
        }
        let shareLink: string | null = s.dropbox_shared_link;
        try {
          shareLink = await storage.getOrCreateShareLink(newPath);
        } catch {
          /* keep old link */
        }
        const update: Record<string, unknown> = {
          dropbox_path: newPath,
          document_type: targetType,
          primary_profile_id: targetProfileId,
          needs_review: false,
        };
        if (shareLink) update.dropbox_shared_link = shareLink;
        const { error: upErr } = await admin
          .from("documents")
          .update(update)
          .eq("id", s.id);
        if (upErr) {
          failed++;
          results.push({
            id: s.id,
            from_path: s.dropbox_path,
            error: upErr.message,
          });
          continue;
        }
        updated++;
        results.push({
          id: s.id,
          from_path: s.dropbox_path,
          to_path: newPath,
        });
        await admin.from("maintenance_log").insert({
          user_id: user.id,
          document_id: s.id,
          kind: "propagate_refile",
          reason: `Propagated from refile of ${id}: type=${targetType}, profile_id=${targetProfileId}`,
          payload: {
            source_id: id,
            sender: source.sender,
            from_type: s.document_type,
            to_type: targetType,
            from_profile_id: s.primary_profile_id,
            to_profile_id: targetProfileId,
            from_path: s.dropbox_path,
            to_path: newPath,
          },
        });
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : "move failed";
        results.push({ id: s.id, from_path: s.dropbox_path, error: msg });
      }
    }

    console.log(
      "[api/documents/[id]/propagate-refile] done",
      id,
      "updated",
      updated,
      "failed",
      failed
    );
    return NextResponse.json({ ok: true, updated, failed, results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Propagate failed";
    console.error("[api/documents/[id]/propagate-refile] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
