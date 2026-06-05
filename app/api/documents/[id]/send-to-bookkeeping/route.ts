import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { getUserSettings } from "@/lib/services/user-settings";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/documents/[id]/send-to-bookkeeping
 *
 * Pushes the original file + structured metadata to the bookkeeping app
 * configured in the user's settings (URL + shared secret). Manual trigger;
 * also used by the "Re-send" button. Idempotent on the bookkeeping side
 * (it dedupes by paperfile_doc_id).
 *
 * On success:
 *   - documents.sent_to_bookkeeping_at = now()
 *   - documents.bookkeeping_doc_id     = whatever bookkeeping returned
 *   - documents.bookkeeping_url        = the URL we pushed to (audit)
 *   - any open send_to_bookkeeping action for this doc is closed.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  console.log("[send-to-bookkeeping] start", id);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 1. Settings: bookkeeping URL + shared secret must be configured.
  const settings = await getUserSettings(supabase, user.id);
  const baseUrl = settings.bookkeeping_url || null;
  const token = settings.bookkeeping_token || null;
  if (!baseUrl) {
    return NextResponse.json(
      {
        error:
          "Bookkeeping URL not set. Open Settings and paste the URL of your bookkeeping app first.",
      },
      { status: 400 }
    );
  }

  // 2. Load the document
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

  // 3. Build the metadata payload that bookkeeping will receive alongside
  //    the file. Includes the canonical Paperfile id so bookkeeping can
  //    dedupe + link back.
  //
  // Bank statements: also include every parsed bank_transactions row so the
  // receiver doesn't have to re-parse the CAMT/PDF. This is what lets a
  // bookkeeping app book per-transaction to the right account without
  // duplicating Paperfile's parser. Skipped for non-statement docs.
  let bank_transactions: Array<Record<string, unknown>> | undefined = undefined;
  if (doc.document_type === "bank_statement") {
    const { data: txns } = await admin
      .from("bank_transactions")
      .select(
        "id, position, amount, currency, booking_date, value_date, counterparty_name, counterparty_iban, description, reference, transaction_id, category, notes"
      )
      .eq("statement_id", doc.id)
      .order("position", { ascending: true, nullsFirst: false })
      .order("booking_date", { ascending: true, nullsFirst: false });
    bank_transactions = (txns || []) as Array<Record<string, unknown>>;
  }

  // 3b. Generate a temporary download link so aiutofin can fetch the
  //     file directly from Dropbox — no need to shuttle the binary through
  //     this server. The link expires after ~4 hours (Dropbox default).
  let file_temporary_link: string | null = null;
  if (doc.dropbox_path) {
    try {
      const storage = getStorage(doc.storage_provider);
      file_temporary_link = await storage.getTemporaryLink(doc.dropbox_path);
    } catch (e: unknown) {
      console.log("[send-to-bookkeeping] temp link failed, will send path only:", e instanceof Error ? e.message : e);
    }
  }

  const metadata = {
    paperfile_doc_id: doc.id,
    paperfile_origin: process.env.NEXT_PUBLIC_APP_URL || null,
    // The user's email — the receiver uses it to look up the matching
    // user account on the bookkeeping side (the two apps don't share
    // user_ids, but email is a stable cross-app identifier).
    user_email: user.email || null,
    file_name: doc.file_name,
    file_type: doc.file_type,
    file_size_bytes: doc.file_size_bytes,
    document_type: doc.document_type,
    document_subtype: doc.document_subtype,
    document_date: doc.document_date,
    sender: doc.sender,
    recipient: doc.recipient,
    primary_profile_id: doc.primary_profile_id,
    amount: doc.amount,
    currency: doc.currency,
    purchase_category: doc.purchase_category,
    title: doc.title,
    summary: doc.summary,
    tags: doc.tags || [],
    extracted_fields: doc.extracted_fields || {},
    ocr_text: doc.ocr_text || null,
    // File location — aiutofin fetches from Dropbox directly.
    file_storage_path: doc.dropbox_path || null,
    file_storage_provider: doc.storage_provider || "dropbox",
    file_temporary_link,
    payment_status:
      (doc.extracted_fields as Record<string, unknown> | null)?.[
        "payment_status"
      ] || null,
    paid_date:
      (doc.extracted_fields as Record<string, unknown> | null)?.["paid_date"] ||
      null,
    // Only present for bank_statement docs.
    ...(bank_transactions !== undefined ? { bank_transactions } : {}),
  };

  // 4. POST JSON (no file binary — aiutofin fetches from Dropbox via the
  //    temporary link or its own Dropbox credentials).
  const target = `${baseUrl}/api/external/paperfile-import`;

  let pushed: { ok: boolean; bookkeeping_doc_id?: string | null; error?: string } = {
    ok: false,
  };
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-paperfile-token": token } : {}),
      },
      body: JSON.stringify(metadata),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json as { error?: string }).error || `HTTP ${res.status}`;
      return NextResponse.json(
        { error: `Bookkeeping rejected the push: ${msg}` },
        { status: 502 }
      );
    }
    pushed = {
      ok: true,
      bookkeeping_doc_id: (json as { id?: string }).id || null,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "network error";
    return NextResponse.json(
      {
        error: `Could not reach bookkeeping at ${target}: ${msg}. Make sure the app is running and the URL is correct.`,
      },
      { status: 502 }
    );
  }

  // 6. Record on the doc + close any open action
  await admin
    .from("documents")
    .update({
      sent_to_bookkeeping_at: new Date().toISOString(),
      bookkeeping_doc_id: pushed.bookkeeping_doc_id,
      bookkeeping_url: baseUrl,
    })
    .eq("id", id);

  await admin
    .from("actions")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      notes: `Pushed to bookkeeping at ${baseUrl}.`,
    })
    .eq("document_id", id)
    .eq("action_type", "send_to_bookkeeping")
    .eq("status", "open");

  console.log("[send-to-bookkeeping] done", id, "→", target);
  return NextResponse.json({
    ok: true,
    bookkeeping_doc_id: pushed.bookkeeping_doc_id,
    bookkeeping_url: baseUrl,
  });
}
