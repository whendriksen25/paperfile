import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { normalizeSender } from "@/lib/services/sender-history";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/refile
 * Body: { profile_id?: number | null, document_type?: string | null }
 *
 * Lets the user override the AI's filing decision. Calculates a new
 * destination via the storage adapter, moves the actual file in the
 * storage backend (e.g. Dropbox), refreshes the shared link, and
 * updates the documents row.
 *
 * Either field is optional — if omitted we keep the current value.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[api/documents/[id]/refile] start", id);

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const newProfileId =
      body.profile_id === null
        ? null
        : body.profile_id !== undefined
          ? Number(body.profile_id)
          : undefined;
    const newDocType =
      body.document_type === undefined
        ? undefined
        : (body.document_type as string | null);

    if (newProfileId === undefined && newDocType === undefined) {
      return NextResponse.json(
        { error: "Provide profile_id and/or document_type" },
        { status: 400 }
      );
    }

    const admin = await createServiceClient();
    const { data: doc, error } = await admin
      .from("documents")
      .select("*")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Resolve effective values
    const targetProfileId =
      newProfileId !== undefined ? newProfileId : doc.primary_profile_id;
    const targetDocType =
      newDocType !== undefined ? newDocType : doc.document_type;

    // Look up profile name (used in the destination path)
    let profileName: string | null = null;
    if (targetProfileId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("name")
        .eq("id", targetProfileId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!profile) {
        return NextResponse.json(
          { error: "Profile not found" },
          { status: 404 }
        );
      }
      profileName = profile.name;
    }

    const storage = getStorage(doc.storage_provider);
    const destination = storage.buildDestinationPath({
      profileSlug: profileName,
      documentType: targetDocType,
      documentDateISO: doc.document_date,
      filename: doc.file_name || "file.bin",
      sender: doc.sender,
      title: doc.title,
    });

    let newPath = doc.dropbox_path;
    let shareLink: string | null = doc.dropbox_shared_link;

    // Only physically move the file if the destination is different from where it is now.
    if (destination !== doc.dropbox_path) {
      newPath = await storage.moveFile(doc.dropbox_path, destination);
      try {
        shareLink = await storage.getOrCreateShareLink(newPath);
      } catch (e) {
        console.warn("[refile] share-link refresh failed", e);
      }
    }

    const { error: updateErr } = await admin
      .from("documents")
      .update({
        dropbox_path: newPath,
        dropbox_shared_link: shareLink,
        primary_profile_id: targetProfileId,
        document_type: targetDocType,
        // Mark as user-corrected so we don't accidentally override later.
        needs_review: false,
      })
      .eq("id", id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    console.log("[api/documents/[id]/refile] done", id, "→", newPath);

    // PROPAGATION HINT: count sibling docs from the same sender (normalized)
    // that are NOT currently classified the same way as the user just chose.
    // The UI uses this to render a one-click "apply to all N siblings"
    // banner so a single refile can fix every other doc from that sender.
    let siblingCount = 0;
    if (doc.sender) {
      const senderNorm = normalizeSender(doc.sender);
      // Pull all the user's docs with a sender; filter client-side because
      // PostgREST can't apply our normalisation rule.
      const { data: candidates } = await admin
        .from("documents")
        .select("id, sender, document_type, primary_profile_id")
        .eq("user_id", user.id)
        .neq("id", id)
        .eq("status", "processed")
        .not("sender", "is", null);
      siblingCount = (candidates || []).filter((c) => {
        if (normalizeSender(c.sender as string) !== senderNorm) return false;
        // A sibling is "out of sync" if either its type OR profile differs
        // from the values the user just chose (when those were specified).
        const typeChanged =
          newDocType !== undefined && c.document_type !== targetDocType;
        const profileChanged =
          newProfileId !== undefined && c.primary_profile_id !== targetProfileId;
        return typeChanged || profileChanged;
      }).length;
    }

    return NextResponse.json({
      ok: true,
      new_path: newPath,
      sibling_count: siblingCount,
      sender: doc.sender || null,
      target_type: targetDocType,
      target_profile_id: targetProfileId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Refile failed";
    console.error("[api/documents/[id]/refile] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
