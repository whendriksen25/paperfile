import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { extractDocument } from "@/lib/ai/extract";
import { suggestProfile } from "@/lib/ai/suggest-profile";
import {
  listProfilesForUser,
  matchProfileByHint,
  ensureDefaultProfile,
} from "@/lib/services/profiles";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Dev-only: runs the full analyze pipeline (download from storage + Claude +
 * profile match + move + action) on a specific document id as the document's
 * OWNER (looked up from the row), not the caller. Same gates as sql bridge.
 */
export async function POST(request: NextRequest) {
  if (process.env.DEV_AUTO_LOGIN !== "true")
    return NextResponse.json({ error: "Disabled." }, { status: 403 });
  if (process.env.NODE_ENV === "production")
    return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  const host = (request.headers.get("host") || "").split(":")[0];
  if (host !== "localhost" && host !== "127.0.0.1")
    return NextResponse.json({ error: "Localhost only." }, { status: 403 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { document_id } = await request.json().catch(() => ({}));
  if (!document_id)
    return NextResponse.json({ error: "Provide document_id" }, { status: 400 });

  const admin = await createServiceClient();
  const { data: doc, error } = await admin
    .from("documents")
    .select("*")
    .eq("id", document_id)
    .maybeSingle();
  if (error || !doc)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  console.log("[admin-bridge/analyze] start for doc", doc.id, "owner", doc.user_id);

  try {
    await admin.from("documents").update({ status: "processing" }).eq("id", doc.id);

    const storage = getStorage(doc.storage_provider);
    console.log("[admin-bridge/analyze] downloading", doc.dropbox_path);
    const buffer = await storage.downloadFile(doc.dropbox_path);
    console.log("[admin-bridge/analyze] downloaded", buffer.length, "bytes");
    const extractRes = await extractDocument(buffer, doc.file_name || "file.jpg");
    const result = extractRes.data;
    console.log("[admin-bridge/analyze] extracted", !!result);
  if (!result) {
    await admin
      .from("documents")
      .update({ status: "failed", needs_review: true, review_notes: "Empty response from Claude" })
      .eq("id", doc.id);
    return NextResponse.json({ error: "Claude returned no response" }, { status: 500 });
  }
  if ("error" in result && result.error === "parse_failed") {
    const note = [
      "Claude's response wasn't valid JSON.",
      `stop_reason: ${result.stop_reason || "unknown"}`,
      `Response length: ${result.raw_text.length} chars`,
      "Raw response (first 4000 chars):",
      result.raw_text.slice(0, 4000),
    ].join("\n");
    await admin
      .from("documents")
      .update({ status: "failed", needs_review: true, review_notes: note.slice(0, 4000) })
      .eq("id", doc.id);
    return NextResponse.json({ error: "Non-JSON response", stop_reason: result.stop_reason }, { status: 500 });
  }
  const extraction = result as Exclude<typeof result, { error: string }>;

  // Profile resolution (same as analyze/[id] route) — but using the row's owner
  let profileId: number | null = doc.primary_profile_id || null;
  let profileName: string | null = null;
  const profiles = await listProfilesForUser(admin, doc.user_id);
  if (!profileId) {
    try {
      const suggestion = await suggestProfile(extraction, profiles);
      if (suggestion && suggestion.profileId != null && suggestion.confidence >= 0.7) {
        profileId = suggestion.profileId;
      }
    } catch (e) { console.warn("[admin-bridge/analyze] suggest failed", e); }
    if (!profileId && extraction.profile_hint) {
      const m = matchProfileByHint(extraction.profile_hint, profiles);
      if (m) profileId = m.id;
    }
    if (!profileId) {
      const def = await ensureDefaultProfile(admin, doc.user_id);
      profileId = def.id;
    }
  }
  profileName = profiles.find((p) => p.id === profileId)?.name || null;

  // Move file
  const destination = storage.buildDestinationPath({
    profileSlug: profileName,
    documentType: extraction.document_type,
    documentDateISO: extraction.document_date,
    filename: doc.file_name || "file.jpg",
    sender: extraction.sender,
    title: extraction.title,
  });
  let newPath = doc.dropbox_path;
  let shareLink: string | null = doc.dropbox_shared_link;
  try {
    newPath = await storage.moveFile(doc.dropbox_path, destination);
    shareLink = await storage.getOrCreateShareLink(newPath);
  } catch (e) { console.warn("[admin-bridge/analyze] move failed", e); }

  const existingTags: string[] = doc.tags || [];
  const mergedTags = Array.from(new Set([...existingTags, ...(extraction.tags || [])].map(t => t.toLowerCase())));

  const needsAction = !!extraction.needs_action;
  const isFinancial = ["invoice","receipt","bill","utility_bill","payslip","bank_statement"].includes(extraction.document_type || "");

  const { error: updateErr } = await admin.from("documents").update({
    dropbox_path: newPath,
    dropbox_shared_link: shareLink,
    primary_profile_id: profileId,
    document_type: extraction.document_type || null,
    document_subtype: extraction.document_subtype || null,
    confidence: extraction.confidence ?? null,
    document_date: extraction.document_date || null,
    sender: extraction.sender || null,
    recipient: extraction.recipient || null,
    person: extraction.profile_hint || null,
    language: extraction.language || null,
    amount: extraction.amount ?? null,
    currency: extraction.currency || null,
    purchase_category: extraction.purchase_category || null,
    title: extraction.title || null,
    summary: extraction.summary || null,
    tags: mergedTags,
    extracted_fields: extraction.extracted_fields || {},
    ocr_text: extraction.ocr_text || null,
    needs_action: needsAction,
    action_type: needsAction ? (extraction.action_type || "other") : null,
    due_date: extraction.due_date || null,
    action_summary: needsAction ? (extraction.action_summary || null) : null,
    handoff_status: isFinancial ? "pending" : "not_applicable",
    status: "processed",
  }).eq("id", doc.id);

  if (updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 });

  if (needsAction && extraction.action_summary) {
    await admin.from("actions").upsert({
      user_id: doc.user_id,
      document_id: doc.id,
      profile_id: profileId,
      action_type: extraction.action_type || "other",
      summary: extraction.action_summary,
      due_date: extraction.due_date || null,
      status: "open",
    }, { onConflict: "document_id" });
  }

  return NextResponse.json({
    ok: true,
    document_id: doc.id,
    document_type: extraction.document_type,
    title: extraction.title,
    summary: extraction.summary,
    profile_name: profileName,
    needs_action: needsAction,
    new_path: newPath,
  });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "analyze failed";
    const stack = e instanceof Error ? e.stack : null;
    console.error("[admin-bridge/analyze] CRASH:", msg, stack);
    await admin
      .from("documents")
      .update({ status: "failed", needs_review: true, review_notes: msg.slice(0, 500) })
      .eq("id", document_id);
    return NextResponse.json({ error: msg, stack: stack?.slice(0, 1000) }, { status: 500 });
  }
}
