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
import {
  BankTransactionsTable,
  type BankTx,
} from "@/components/inbox/bank-transactions-table";
import { RefileWidget } from "@/components/inbox/refile-widget";
import { RenameFilenameButton } from "@/components/inbox/rename-filename-button";
import { DuplicateBanner } from "@/components/inbox/duplicate-banner";
import { DocumentPreview } from "@/components/inbox/document-preview";
import { ReconciliationPanel } from "@/components/inbox/reconciliation-panel";
import { TruncationBanner } from "@/components/inbox/truncation-banner";
import { ParentScanBanner } from "@/components/inbox/parent-scan-banner";
import { estimateAiCostEur, formatAiCostEur } from "@/lib/ai/pricing";
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

  // For bank statements, load the rows from the first-class
  // bank_transactions table (migration 012). Source of truth, with proper
  // indexes; the JSON line_items kept on the row is just a backup of
  // what extraction originally returned.
  // Extended to also carry the reconciliation columns (match_status,
  // match_reason, matched_*) so the ReconciliationPanel can drill-down
  // into matched / ambiguous / unmatched lists from the same dataset
  // the BankTransactionsTable already renders.
  let bankTransactions: Array<{
    id: string;
    amount: number;
    currency: string;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    description: string | null;
    reference: string | null;
    booking_date: string | null;
    value_date: string | null;
    match_status: string | null;
    match_reason: string | null;
    matched_action_id: string | null;
    matched_document_id: string | null;
    match_method: string | null;
    match_confidence: number | null;
    suspicions:
      | Array<{
          possible_action_ids?: string[];
          possible_doc_ids?: string[];
          reasoning: string;
          confidence: number;
        }>
      | null;
  }> = [];
  if (doc.document_type === "bank_statement") {
    // Supabase enforces a server-side 1000-row cap. `.range()` can't
    // override it from the client — only manual pagination works. Loop
    // in pages of 1000 until a short page comes back.
    const PAGE = 1000;
    let offset = 0;
    for (let i = 0; i < 50; i++) {
      const { data: pageData } = await supabase
        .from("bank_transactions")
        .select(
          "id, amount, currency, counterparty_name, counterparty_iban, description, reference, booking_date, value_date, position, match_status, match_reason, matched_action_id, matched_document_id, match_method, match_confidence, suspicions"
        )
        .eq("statement_id", id)
        .order("position", { ascending: true })
        .range(offset, offset + PAGE - 1);
      const rows = (pageData || []) as typeof bankTransactions;
      bankTransactions.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }

  // Multi-doc sibling lookup. A "sibling group" is:
  //   - the parent (parent_document_id IS NULL)
  //   - all its children (parent_document_id = parent.id)
  // If THIS doc has parent_document_id set → look up siblings via the
  // parent. If THIS doc is itself a parent with children → look up
  // children directly. Either way, build a sorted list with this doc
  // marked so the badge can render "X of Y in this scan".
  type SiblingRow = {
    id: string;
    sender: string | null;
    title: string | null;
    amount: number | null;
    currency: string | null;
    document_date: string | null;
    parent_document_id: string | null;
    dropbox_path: string | null;
  };
  let siblings: SiblingRow[] = [];
  const parentId =
    (doc as DocumentRow & { parent_document_id?: string | null })
      .parent_document_id || null;
  const scanRootId = parentId || doc.id;
  // Always do the query — if scanRootId has no children AND isn't a
  // child itself, the result is just this one row, and we render no
  // badge. Cheap query. dropbox_path is fetched so we can derive a
  // stable left-to-right ordering for the parent-scan banner's
  // "Part N of M" position (matches the _part1/_part2 naming pattern).
  {
    const { data: siblingData } = await supabase
      .from("documents")
      .select(
        "id, sender, title, amount, currency, document_date, parent_document_id, dropbox_path"
      )
      .or(`id.eq.${scanRootId},parent_document_id.eq.${scanRootId}`)
      .order("created_at", { ascending: true });
    siblings = (siblingData || []) as SiblingRow[];
  }

  // Parent-scan banner data — only relevant for child rows (rows with
  // a parent_document_id set). We fetch the parent's fields once;
  // sibling ordering uses the dropbox_path column already on the
  // siblings array, so no extra query is needed for that.
  let parentScanInfo: {
    parentDocId: string;
    parentSender: string | null;
    parentDate: string | null;
    parentDropboxPath: string | null;
    siblingPosition: number;
    siblingTotal: number;
    position:
      | "top-left"
      | "top-right"
      | "bottom-left"
      | "bottom-right"
      | "middle"
      | null;
  } | null = null;
  if (parentId) {
    const { data: parentRow } = await supabase
      .from("documents")
      .select("id, sender, document_date, dropbox_path, extracted_fields")
      .eq("id", parentId)
      .maybeSingle();
    if (parentRow) {
      const pRow = parentRow as {
        id: string;
        sender: string | null;
        document_date: string | null;
        dropbox_path: string | null;
        extracted_fields: Record<string, unknown> | null;
      };
      // Order siblings by dropbox_path (matches the _part1/_part2/...
      // naming convention used when crops are written to storage).
      // Fall back to created_at order for any row without a path.
      const sorted = [...siblings].sort((a, b) => {
        const ap = a.dropbox_path || "";
        const bp = b.dropbox_path || "";
        if (ap === bp) return 0;
        return ap < bp ? -1 : 1;
      });
      const myPath = doc.dropbox_path || "";
      // 1-based position: count of siblings whose path is <= mine.
      let siblingPosition = 0;
      for (const s of sorted) {
        const sp = s.dropbox_path || "";
        if (sp <= myPath) siblingPosition += 1;
      }
      // Defensive: position must be ≥ 1 so the banner reads correctly
      // even if dropbox_path comparison goes weird.
      if (siblingPosition === 0) siblingPosition = 1;
      const siblingTotal = sorted.length;

      // Spatial position. The parent persists polygons on
      // extracted_fields._multidoc.polygons; polygons[0] is the parent
      // (which after split = the first receipt), [1..] are children.
      // We classify by centroid quadrant: x<0.5 = left; y<0.5 = top;
      // a tight middle band (0.4..0.6 on BOTH axes) maps to "middle".
      let position:
        | "top-left"
        | "top-right"
        | "bottom-left"
        | "bottom-right"
        | "middle"
        | null = null;
      const mdRaw = pRow.extracted_fields?.["_multidoc"];
      if (mdRaw && typeof mdRaw === "object") {
        const md = mdRaw as {
          polygons?: Array<{ vertices?: Array<{ x: number; y: number }> }>;
        };
        const polys = Array.isArray(md.polygons) ? md.polygons : [];
        // The polygons array is index-aligned with the per-crop split:
        // index 0 = parent's portion (which after the split is the
        // first receipt). Children appear at indices 1..N in the same
        // order they were inserted, which mirrors the sorted dropbox
        // path order ({stem}_part1, _part2, ...). So the child's polygon
        // index is the same as siblingPosition - 1 (because the parent
        // sits at position 1, child[0] sits at position 2, etc.).
        const polyIdx = siblingPosition - 1;
        const poly = polys[polyIdx];
        if (poly && Array.isArray(poly.vertices) && poly.vertices.length > 0) {
          let cx = 0,
            cy = 0;
          for (const v of poly.vertices) {
            cx += Number(v.x) || 0;
            cy += Number(v.y) || 0;
          }
          cx /= poly.vertices.length;
          cy /= poly.vertices.length;
          const inMidX = cx >= 0.4 && cx <= 0.6;
          const inMidY = cy >= 0.4 && cy <= 0.6;
          if (inMidX && inMidY) {
            position = "middle";
          } else {
            const top = cy < 0.5;
            const left = cx < 0.5;
            position = top
              ? left
                ? "top-left"
                : "top-right"
              : left
                ? "bottom-left"
                : "bottom-right";
          }
        }
      }

      parentScanInfo = {
        parentDocId: pRow.id,
        parentSender: pRow.sender,
        parentDate: pRow.document_date,
        parentDropboxPath: pRow.dropbox_path,
        siblingPosition,
        siblingTotal,
        position,
      };
    }
  }

  // Look up an active multi-doc "re-analyse full scan" job so the
  // RefileWidget's progress panel can auto-resume after a page reload.
  // Cheap query — one row at most per (document, in-flight status).
  let activeAnalyzeJobId: string | null = null;
  {
    const { data: ajRow } = await supabase
      .from("analyze_jobs")
      .select("id")
      .eq("document_id", id)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ajRow) {
      activeAnalyzeJobId = (ajRow as { id: string }).id;
    }
  }

  // Look up an active AI reconcile job for this statement so the panel
  // can auto-resume polling if a previous session was interrupted
  // (tab refresh, navigation, network blip).
  let activeAiJob: { job_id: string; total_chunks: number } | null = null;
  if (doc.document_type === "bank_statement") {
    const { data: jobRow } = await supabase
      .from("reconciliation_jobs")
      .select("id, total_chunks, status")
      .eq("statement_id", id)
      .in("status", ["pending", "processing"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobRow) {
      activeAiJob = {
        job_id: (jobRow as { id: string }).id,
        total_chunks: (jobRow as { total_chunks: number }).total_chunks,
      };
    }
  }

  // Layer 2 dedup: if analyze flagged this as a possible duplicate of
  // another doc, fetch a tiny summary of that doc so the banner can
  // describe it ("Looks like a duplicate of X from Y on Z").
  let duplicateOf: {
    id: string;
    title: string | null;
    sender: string | null;
    document_date: string | null;
  } | null = null;
  if (doc.possible_duplicate_of) {
    const { data: dup } = await supabase
      .from("documents")
      .select("id, title, sender, document_date")
      .eq("id", doc.possible_duplicate_of)
      .maybeSingle();
    duplicateOf = (dup as typeof duplicateOf) || null;
  }

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

        {/* Multi-doc sibling badge — shown when this scan was split into
           multiple docs. Lets the user jump between siblings without
           hunting in the inbox. */}
        {siblings.length > 1 && (
          <div className="mt-3 surface p-3 bg-brand-purple/5 border-brand-purple/30">
            <div className="text-[10px] uppercase tracking-wider font-bold text-brand-purple mb-1.5">
              Part of a {siblings.length}-document scan
            </div>
            <div className="flex flex-wrap gap-1.5">
              {siblings.map((s, i) => {
                const isCurrent = s.id === doc.id;
                const label = `${i + 1} of ${siblings.length}`;
                const summary = [
                  s.sender || "—",
                  s.amount != null
                    ? formatMoney(s.amount, s.currency)
                    : null,
                  s.document_date ? formatDate(s.document_date) : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return isCurrent ? (
                  <span
                    key={s.id}
                    className="text-[11px] font-semibold inline-flex items-center gap-1.5 px-2 py-1 rounded bg-brand-purple text-white"
                  >
                    {label} — {summary || "this doc"}
                  </span>
                ) : (
                  <Link
                    key={s.id}
                    href={`/document/${s.id}`}
                    className="text-[11px] font-semibold inline-flex items-center gap-1.5 px-2 py-1 rounded border border-brand-purple/30 text-brand-purple hover:bg-brand-purple/10"
                  >
                    {label} — {summary || "view"}
                  </Link>
                );
              })}
            </div>
          </div>
        )}
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

      {/* Parent-scan banner — only rendered on child docs that came
         from a multi-receipt scan. Self-suppresses when parentDocId
         is missing, so unconditional placement is safe. */}
      {parentScanInfo && (
        <ParentScanBanner
          parentDocId={parentScanInfo.parentDocId}
          parentSender={parentScanInfo.parentSender}
          parentDate={parentScanInfo.parentDate}
          parentDropboxPath={parentScanInfo.parentDropboxPath}
          siblingPosition={parentScanInfo.siblingPosition}
          siblingTotal={parentScanInfo.siblingTotal}
          position={parentScanInfo.position}
        />
      )}

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

      {duplicateOf && (
        <DuplicateBanner
          currentId={doc.id}
          duplicate={duplicateOf}
        />
      )}

      {doc.ai_truncated && (
        <TruncationBanner
          documentId={doc.id}
          estimatedExtraCostEur={
            // Rough extra cost: the additional output tokens needed
            // beyond the 64k cap, at the output rate. Assume ~30k more.
            estimateAiCostEur(0, 30_000)
          }
        />
      )}

      {doc.document_type === "bank_statement" && (
        <ReconciliationPanel
          documentId={doc.id}
          transactions={bankTransactions}
          activeAiJob={activeAiJob}
          initial={(() => {
            const r = (doc.extracted_fields as Record<string, unknown> | null)?.[
              "_reconciliation"
            ] as
              | {
                  ran_at?: string;
                  matched?: number;
                  ambiguous?: number;
                  unmatched?: number;
                  considered?: number;
                }
              | null
              | undefined;
            if (!r) return null;
            return {
              ran_at: r.ran_at || null,
              matched: r.matched ?? 0,
              ambiguous: r.ambiguous ?? 0,
              unmatched: r.unmatched ?? 0,
              considered: r.considered ?? 0,
            };
          })()}
        />
      )}

      {(() => {
        // First-seen-sender prompt: nudges the user to verify profile +
        // type on the very first doc from a new sender. Their correction
        // (if any) seeds the sender-history pattern that all future docs
        // from this sender will benefit from.
        const ef = doc.extracted_fields as Record<string, unknown> | null;
        const isFirstSeen = ef?.["_first_seen_sender"] === true;
        if (!isFirstSeen) return null;
        return (
          <div className="surface p-4 mb-5 bg-amber-50 border-amber-300">
            <div className="flex items-start gap-3">
              <Sparkles className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-bold text-amber-900">
                  First document from {doc.sender || "this sender"}
                </div>
                <p className="text-xs text-amber-800 mt-0.5">
                  Quickly check the profile and category below — your
                  correction (if any) sets the pattern Paperfile will use
                  for every future document from{" "}
                  {doc.sender || "this sender"}.
                </p>
              </div>
            </div>
          </div>
        );
      })()}

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

          {/* Per-doc AI cost — only shown when we actually called Claude.
             Deterministic parsers (CAMT, Rabobank CSV) have 0 tokens. */}
          {(doc.ai_input_tokens || doc.ai_output_tokens) ? (
            <div className="text-[11px] text-muted-foreground mb-3">
              AI cost:{" "}
              <span className="font-bold">
                {formatAiCostEur(
                  estimateAiCostEur(
                    doc.ai_input_tokens,
                    doc.ai_output_tokens
                  )
                )}
              </span>{" "}
              · {doc.ai_input_tokens?.toLocaleString() || 0} in /{" "}
              {doc.ai_output_tokens?.toLocaleString() || 0} out tokens
            </div>
          ) : null}

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

          {/* Refile widget — placed right under the AI suggestions so the
              user can correct profile / document type without scrolling
              past the rest of the page. The widget renders its own
              "Move or re-analyse" header + top border. */}
          <RefileWidget
            documentId={doc.id}
            currentProfileId={doc.primary_profile_id}
            currentDocumentType={doc.document_type}
            hasOriginalScan={
              !!(doc.extracted_fields as Record<string, unknown> | null)?.[
                "_original_scan_path"
              ]
            }
            isMultiDocParent={
              // Has children pointing at me. Siblings list includes self,
              // so > 1 means at least one other row in the split set AND
              // this row is the parent (parent_document_id is null).
              !(doc as DocumentRow & {
                parent_document_id?: string | null;
              }).parent_document_id && siblings.length > 1
            }
            activeAnalyzeJobId={activeAnalyzeJobId}
          />
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

      {/* Line items — bank statements pull from the bank_transactions
          table (first-class rows, indexed). Receipts / invoices still
          pull from the JSON line_items array on the doc. */}
      {doc.document_type === "bank_statement" ? (
        <BankTransactionsTable
          transactions={bankTransactions as unknown as BankTx[]}
          currency={doc.currency}
        />
      ) : (
        (() => {
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
        })()
      )}

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

