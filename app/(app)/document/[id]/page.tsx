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
import type { DocumentRow, ProfileRow, ActionRow } from "@/types/document";
import {
  ArrowLeft,
  ExternalLink,
  Sparkles,
  CircleDot,
  Building2,
  User,
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
          {doc.title || doc.file_name || "Untitled document"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {doc.sender || titleCase(doc.document_type) || "Unknown sender"}
          {doc.document_date ? ` · ${formatDate(doc.document_date)}` : ""}
        </p>
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
            fileName={doc.file_name}
            fileType={doc.file_type}
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs">
              <div className="font-semibold">{doc.file_name}</div>
              <div className="text-muted-foreground">
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
            <span className="pill bg-brand-purple/10 text-brand-purple">
              Auto-processed
            </span>
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
            <Row label="Name" value={doc.file_name} />
            <Row label="Type" value={doc.file_type} />
            <Row label="Size" value={formatBytes(doc.file_size_bytes)} />
            <Row label="Storage" value={titleCase(doc.storage_provider)} />
            <Row label="Path" value={doc.dropbox_path} mono />
          </dl>
        </div>
      </div>

      {doc.extracted_fields &&
        Object.keys(doc.extracted_fields).filter((k) => k !== "line_items")
          .length > 0 && (
          <div className="surface p-5 mb-5">
            <h2 className="section-label mb-3">Fields</h2>
            <dl className="space-y-2 text-sm">
              {Object.entries(doc.extracted_fields)
                .filter(([k]) => k !== "line_items")
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
