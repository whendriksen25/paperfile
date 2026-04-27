import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  formatDate,
  formatMoney,
  titleCase,
  formatBytes,
} from "@/lib/utils/format";
import { Badge } from "@/components/ui/badge";
import { LineItemsSection, type LineItem } from "@/components/inbox/line-items";
import { RefileWidget } from "@/components/inbox/refile-widget";
import { RenameFilenameButton } from "@/components/inbox/rename-filename-button";
import {
  ProfileMatchPanel,
  type ProfileMatchInfo,
} from "@/components/inbox/profile-match-panel";
import { parseStoragePath } from "@/lib/utils/storage-path";
import type { DocumentRow, ProfileRow, ActionRow } from "@/types/document";
import {
  ArrowLeft,
  ExternalLink,
  Sparkles,
  CircleDot,
  Building2,
  User,
  FolderOpen,
  ChevronRight,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DocumentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) notFound();
  const doc = data as DocumentRow;

  // Display name is the actual filename in storage (logical name like
  // 20251223_cak.pdf), with the original-as-uploaded as a fallback for
  // very old rows or pre-classified docs that haven't been moved yet.
  const displayName =
    parseStoragePath(doc.dropbox_path).filename || doc.file_name || "";

  let profile: ProfileRow | null = null;
  if (doc.primary_profile_id) {
    const { data: p } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", doc.primary_profile_id)
      .maybeSingle();
    profile = (p as ProfileRow) || null;
  }

  let action: ActionRow | null = null;
  const { data: a } = await supabase
    .from("actions")
    .select("*")
    .eq("document_id", id)
    .maybeSingle();
  action = (a as ActionRow) || null;

  const isPending = doc.status === "pending" || doc.status === "processing";

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <Link
        href="/inbox"
        className="text-xs font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to library
      </Link>

      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">
          {doc.title || displayName || "Untitled document"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {doc.sender || titleCase(doc.document_type) || "Unknown sender"}
          {doc.document_date ? ` · ${formatDate(doc.document_date)}` : ""}
        </p>
        {/* Payment status — surfaces handwritten "PAID" annotations */}
        {(() => {
          const ef = doc.extracted_fields as Record<string, unknown> | null;
          const status = String(ef?.["payment_status"] || "").toLowerCase();
          const paidDate = (ef?.["paid_date"] as string | undefined) || null;
          const note = (ef?.["paid_note"] as string | undefined) || null;
          if (!status || status === "unknown") return null;
          if (status === "paid") {
            return (
              <div className="mt-3 inline-flex items-center gap-2 rounded-2xl bg-brand-green/10 border border-brand-green/30 px-3 py-2 text-sm">
                <CircleDot className="h-4 w-4 text-brand-green" />
                <span className="font-bold text-brand-green">
                  Paid
                  {paidDate ? ` on ${formatDate(paidDate)}` : ""}
                </span>
                {note && (
                  <span className="text-xs text-brand-green/80">· {note}</span>
                )}
              </div>
            );
          }
          if (status === "partial") {
            return (
              <div className="mt-3 inline-flex items-center gap-2 rounded-2xl bg-amber-100 border border-amber-300 px-3 py-2 text-sm font-bold text-amber-800">
                Partially paid
                {paidDate ? ` (last payment ${formatDate(paidDate)})` : ""}
              </div>
            );
          }
          return null;
        })()}
      </header>

      {isPending && (
        <div className="surface p-5 mb-5 bg-brand-gradient-soft border-brand-purple/30">
          <div className="flex items-center gap-2 text-brand-purple font-bold text-sm">
            <Sparkles className="h-4 w-4" />
            Paperfile AI is processing this document…
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Refresh in a moment to see the extracted details.
          </p>
        </div>
      )}

      {/* Two-pane layout: source on left, AI suggestions on right */}
      <div className="grid lg:grid-cols-2 gap-5 mb-5">
        {/* Source document */}
        <div className="surface p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-sm">Source Document</h2>
          </div>
          <DocumentPreview
            id={doc.id}
            fileName={displayName}
            fileType={doc.file_type}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs min-w-0">
              <RenameFilenameButton
                documentId={doc.id}
                currentFilename={displayName}
              />
              <div className="text-muted-foreground mt-0.5">
                {formatBytes(doc.file_size_bytes)}
              </div>
            </div>
            <a
              href={`/api/documents/${doc.id}/preview`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-xs !py-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open full
            </a>
          </div>
        </div>

        {/* AI suggestions */}
        <div className="surface p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="flex items-center gap-2 font-bold text-sm">
              <Sparkles className="h-4 w-4 text-brand-purple" />
              Paperfile AI Suggestions
            </h2>
            {(() => {
              // Pill that reflects the doc's ACTUAL state, not a static
              // "Auto-processed" label. The previous static label was
              // misleading — a doc could be mid-processing or flagged for
              // review and still show "Auto-processed".
              if (isPending) {
                return (
                  <span className="pill bg-muted text-muted-foreground">
                    Processing…
                  </span>
                );
              }
              if (doc.status === "failed") {
                return (
                  <span className="pill bg-destructive/10 text-destructive">
                    Failed
                  </span>
                );
              }
              if (doc.needs_review) {
                return (
                  <span className="pill bg-amber-500/10 text-amber-600">
                    Needs review
                  </span>
                );
              }
              return (
                <span className="pill bg-brand-purple/10 text-brand-purple">
                  Auto-processed
                </span>
              );
            })()}
          </div>

          <div className="space-y-4">
            <Field label="Belongs To Profile">
              <div className="flex items-center justify-between gap-2 input bg-muted/40 border-transparent">
                <span className="flex items-center gap-2">
                  {profile?.type === "business" ? (
                    <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  {profile?.name || "Unassigned"}
                </span>
                {doc.confidence != null && (
                  <Badge variant="match">
                    {Math.round(doc.confidence * 100)}% Match
                  </Badge>
                )}
              </div>
            </Field>

            {doc.document_type && (
              <Field label="Category">
                <div className="flex items-center justify-between gap-2 input bg-muted/40 border-transparent">
                  <span>{titleCase(doc.document_type)}</span>
                  {doc.confidence != null && (
                    <Badge variant="match">
                      {Math.round((doc.confidence || 0) * 100)}% Match
                    </Badge>
                  )}
                </div>
              </Field>
            )}

            {action && (
              <Field label="Extracted Action">
                <div className="rounded-2xl border-2 border-brand-teal/30 bg-brand-teal/5 px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-brand-teal/15 flex items-center justify-center">
                      <CircleDot className="h-4 w-4 text-brand-teal" />
                    </div>
                    <div>
                      <div className="font-bold text-sm">{action.summary}</div>
                      {action.due_date && (
                        <div className="text-xs text-muted-foreground">
                          Due {formatDate(action.due_date)}
                        </div>
                      )}
                    </div>
                  </div>
                  <Badge variant="green">
                    {Math.round((doc.confidence || 0.85) * 100)}% match
                  </Badge>
                </div>
              </Field>
            )}
          </div>
        </div>
      </div>

      {doc.summary && (
        <div className="surface p-5 mb-5">
          <h2 className="section-label mb-2">Summary</h2>
          <p className="text-sm leading-relaxed">{doc.summary}</p>
        </div>
      )}

      {/* Profile match reasoning — visible only when the analyzer has captured it */}
      {(() => {
        const m = (doc.extracted_fields as Record<string, unknown> | null)?.[
          "_profile_match"
        ];
        if (!m || typeof m !== "object") return null;
        return (
          <ProfileMatchPanel
            match={m as ProfileMatchInfo}
            currentProfileName={profile?.name || null}
          />
        );
      })()}

      {/* Line items table — only present for receipts/invoices/etc with itemised charges */}
      {(() => {
        const items = (doc.extracted_fields as Record<string, unknown> | null)?.[
          "line_items"
        ];
        if (!Array.isArray(items) || items.length === 0) return null;
        return (
          <LineItemsSection
            items={items as LineItem[]}
            currency={doc.currency}
          />
        );
      })()}

      <div className="grid md:grid-cols-2 gap-5 mb-5">
        <div className="surface p-5">
          <h2 className="section-label mb-3">Extracted</h2>
          <dl className="space-y-2 text-sm">
            {profile && <Row label="Profile" value={profile.name} />}
            {doc.sender && <Row label="Sender" value={doc.sender} />}
            {doc.recipient && <Row label="Recipient" value={doc.recipient} />}
            {doc.person && <Row label="Name on doc" value={doc.person} />}
            {doc.document_date && (
              <Row label="Document date" value={formatDate(doc.document_date)} />
            )}
            {doc.amount != null && (
              <Row label="Amount" value={formatMoney(doc.amount, doc.currency)} />
            )}
            {doc.purchase_category && (
              <Row label="Category" value={titleCase(doc.purchase_category)} />
            )}
            {doc.language && <Row label="Language" value={doc.language} />}
          </dl>
        </div>

        <div className="surface p-5">
          <h2 className="section-label mb-3">File</h2>
          <dl className="space-y-2 text-sm">
            <Row label="Name" value={displayName} />
            <Row label="Type" value={doc.file_type} />
            <Row label="Size" value={formatBytes(doc.file_size_bytes)} />
            <Row label="Storage" value={titleCase(doc.storage_provider)} />
          </dl>
        </div>
      </div>

      {/* Filed at — Dropbox storage location */}
      {doc.dropbox_path && (
        <div className="surface p-5 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="section-label flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5" />
              Filed at
            </h2>
            {doc.dropbox_shared_link && (
              <a
                href={doc.dropbox_shared_link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-brand-purple hover:underline inline-flex items-center gap-1"
              >
                Open in Dropbox
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <FiledAtBreadcrumb path={doc.dropbox_path} />
          <p className="mt-2 text-[11px] text-muted-foreground font-mono break-all">
            {doc.dropbox_path}
          </p>
          <RefileWidget
            documentId={doc.id}
            currentProfileId={doc.primary_profile_id}
            currentDocumentType={doc.document_type}
          />
        </div>
      )}

      {doc.extracted_fields &&
        Object.keys(doc.extracted_fields).filter(
          (k) => k !== "line_items" && k !== "_profile_match"
        ).length > 0 && (
          <div className="surface p-5 mb-5">
            <h2 className="section-label mb-3">Fields</h2>
            <dl className="space-y-2 text-sm">
              {Object.entries(doc.extracted_fields)
                .filter(([k]) => k !== "line_items" && k !== "_profile_match")
                .map(([k, v]) => (
                  <Row
                    key={k}
                    label={titleCase(k)}
                    value={
                      typeof v === "object" && v !== null
                        ? JSON.stringify(v)
                        : String(v ?? "")
                    }
                  />
                ))}
            </dl>
          </div>
        )}

      {doc.ocr_text && (
        <div className="surface p-5">
          <h2 className="section-label mb-3">OCR text</h2>
          <pre className="text-xs whitespace-pre-wrap text-muted-foreground font-sans leading-relaxed">
            {doc.ocr_text}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground mb-1.5">
        {label}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  if (value == null || value === "") return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground text-xs uppercase tracking-wider min-w-[90px] font-bold">
        {label}
      </dt>
      <dd
        className={`text-foreground text-right break-all ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Breadcrumb-style display of the Dropbox storage location, e.g.
 *   Archive › Father › 2026 › Medical Bill
 * with special states for staged (_inbox) and unsorted (_unsorted) files.
 */
function FiledAtBreadcrumb({ path }: { path: string }) {
  const parsed = parseStoragePath(path);

  if (parsed.inInbox) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <strong>Awaiting filing.</strong> This document is still in the inbox
        staging folder — it will be moved to its final home once the AI
        classification finishes.
      </div>
    );
  }

  if (parsed.unsorted) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
        <strong>Unsorted.</strong> The AI couldn&apos;t pick a confident profile
        or category, so the file lives in the shared <code>_unsorted</code>{" "}
        folder.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-sm">
      {parsed.breadcrumb.map((seg, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <span
            className={
              i === 0
                ? "text-muted-foreground"
                : "font-bold text-foreground"
            }
          >
            {seg}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Renders the actual file inline. Streams via /api/documents/{id}/preview
 * (server-side download from the storage adapter) so we don't depend on
 * Dropbox shared-link state and works for any future storage backend.
 *
 * - PDFs render in an <iframe> (browser PDF viewer).
 * - Images render in an <img> tag.
 * - Anything else (e.g. unknown binary) shows a fallback placeholder.
 */
function DocumentPreview({
  id,
  fileName,
  fileType,
}: {
  id: string;
  fileName: string | null;
  fileType: string | null;
}) {
  const url = `/api/documents/${id}/preview`;
  const ext = (fileName || "").toLowerCase();
  const mime = (fileType || "").toLowerCase();
  const isPdf = mime.includes("pdf") || ext.endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") ||
    /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(ext);

  if (isPdf) {
    return (
      <iframe
        src={url}
        title={fileName || "Document preview"}
        className="rounded-2xl bg-muted w-full h-[480px] border border-border"
      />
    );
  }
  if (isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={fileName || "Document preview"}
        className="rounded-2xl bg-muted w-full max-h-[600px] object-contain border border-border"
      />
    );
  }
  return (
    <div className="rounded-2xl bg-muted aspect-[4/3] flex items-center justify-center text-muted-foreground text-xs">
      Preview not available — open the file to view.
    </div>
  );
}
