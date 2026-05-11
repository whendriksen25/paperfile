import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmProfileButton } from "@/components/inbox/confirm-profile-button";
import { formatDate, formatMoney, titleCase } from "@/lib/utils/format";
import { storagePathLabel, parseStoragePath } from "@/lib/utils/storage-path";
import {
  FileText,
  Image as ImageIcon,
  Mail,
  Receipt,
  CircleDot,
  AlertTriangle,
  FolderOpen,
  CheckCircle2,
  Send,
} from "lucide-react";
import type { DocumentRow, ProfileRow } from "@/types/document";

/** Pull the payment_status helper out of extracted_fields if Claude set it. */
function paymentStatus(doc: DocumentRow): "paid" | "unpaid" | null {
  const ef = doc.extracted_fields as Record<string, unknown> | null;
  const v = String(ef?.["payment_status"] || "").toLowerCase();
  if (v === "paid") return "paid";
  if (v === "unpaid" || v === "partial") return "unpaid";
  return null;
}

function iconFor(type: string | null) {
  if (!type) return FileText;
  if (type.includes("receipt") || type.includes("invoice")) return Receipt;
  if (type.includes("letter") || type.includes("declaration")) return Mail;
  if (type.includes("image") || type.includes("photo")) return ImageIcon;
  return FileText;
}

function categoryVariant(type: string | null): "purple" | "teal" | "blue" | "green" | "default" {
  if (!type) return "default";
  if (type.includes("medical") || type.includes("prescription") || type.includes("lab"))
    return "purple";
  if (type.includes("invoice") || type.includes("receipt") || type.includes("bill"))
    return "teal";
  if (type.includes("contract") || type.includes("certificate") || type.includes("rental"))
    return "blue";
  if (type.includes("payment") || type.includes("payslip")) return "green";
  return "default";
}

function progressLabel(status: string): string {
  if (status === "pending") return "Queued for AI";
  if (status === "processing") return "Reading & extracting…";
  if (status === "failed") return "Something went wrong";
  return "";
}

export function DocumentCard({
  doc,
  profile,
}: {
  doc: DocumentRow;
  profile?: ProfileRow | null;
}) {
  const Icon = iconFor(doc.document_type);
  const isWorking = doc.status === "pending" || doc.status === "processing";
  const isFailed = doc.status === "failed";

  return (
    <Link
      href={`/document/${doc.id}`}
      className={`surface block p-5 hover:shadow-card transition-all animate-fade-in relative overflow-hidden ${
        isWorking ? "ring-1 ring-brand-purple/30" : ""
      }`}
    >
      {/* Top progress bar shown while AI is working */}
      {isWorking && (
        <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 bg-brand-purple animate-progress-slide" />
        </div>
      )}
      <div className="flex items-start gap-4">
        <div
          className={`h-12 w-12 shrink-0 rounded-2xl flex items-center justify-center ${
            isWorking
              ? "bg-brand-purple/10"
              : isFailed
                ? "bg-destructive/10"
                : "bg-brand-gradient-soft"
          }`}
        >
          {isWorking ? (
            <Spinner className="h-5 w-5 text-brand-purple" />
          ) : isFailed ? (
            <AlertTriangle className="h-5 w-5 text-destructive" />
          ) : (
            <Icon className="h-5 w-5 text-brand-purple" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground truncate flex items-center gap-2">
                <span className="truncate">
                  {doc.title ||
                    parseStoragePath(doc.dropbox_path).filename ||
                    doc.file_name ||
                    "Untitled document"}
                </span>
                {/* "New sender" pill — surfaces when this is the very first
                   doc from a previously-unseen sender. The detail page also
                   shows a fuller verification banner; the pill is the
                   at-a-glance signal in the inbox. */}
                {(doc.extracted_fields as Record<string, unknown> | null)?.[
                  "_first_seen_sender"
                ] === true && (
                  <span className="pill bg-amber-100 text-amber-800 shrink-0 text-[10px] font-bold uppercase tracking-wider">
                    New sender
                  </span>
                )}
              </h3>
              <p
                className={`text-xs truncate mt-0.5 ${
                  isWorking
                    ? "text-brand-purple font-semibold"
                    : isFailed
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {isWorking
                  ? progressLabel(doc.status)
                  : isFailed
                    ? doc.review_notes || progressLabel(doc.status)
                    : (doc.sender ||
                        titleCase(doc.document_type) ||
                        "Unknown sender") +
                      (doc.document_date
                        ? ` · ${formatDate(doc.document_date)}`
                        : "")}
              </p>

              {/* Bank-statement summary line — tells the user at a glance
                 what's inside the statement (txn count + flows + reconcile
                 status) so they don't need to open it to know. */}
              {!isWorking &&
                !isFailed &&
                doc.document_type === "bank_statement" &&
                (() => {
                  const ef =
                    doc.extracted_fields as
                      | Record<string, unknown>
                      | null;
                  const summary = ef?.["_bank_summary"] as
                    | {
                        txn_count?: number;
                        debit_total?: number;
                        credit_total?: number;
                        currency?: string;
                      }
                    | undefined;
                  const reconciliation = ef?.["_reconciliation"] as
                    | {
                        matched?: number;
                        considered?: number;
                      }
                    | undefined;
                  if (!summary && !reconciliation) return null;
                  const cur = summary?.currency || "EUR";
                  const bits: string[] = [];
                  if (summary?.txn_count != null) {
                    bits.push(
                      `${summary.txn_count} ${summary.txn_count === 1 ? "transaction" : "transactions"}`
                    );
                  }
                  if (summary?.debit_total) {
                    bits.push(`${formatMoney(summary.debit_total, cur)} out`);
                  }
                  if (summary?.credit_total) {
                    bits.push(`${formatMoney(summary.credit_total, cur)} in`);
                  }
                  if (
                    reconciliation?.considered != null &&
                    reconciliation?.matched != null
                  ) {
                    bits.push(
                      `${reconciliation.matched}/${reconciliation.considered} reconciled`
                    );
                  }
                  if (bits.length === 0) return null;
                  return (
                    <p className="text-xs text-brand-teal font-semibold truncate mt-0.5">
                      {bits.join(" · ")}
                    </p>
                  );
                })()}
            </div>
            {doc.amount != null && !isWorking && (
              <span className="text-sm font-bold text-foreground shrink-0">
                {formatMoney(doc.amount, doc.currency)}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {isWorking ? (
              <Badge variant="purple">
                <Spinner className="h-3 w-3" /> AI working
              </Badge>
            ) : (
              <>
                {doc.document_type && (
                  <Badge variant={categoryVariant(doc.document_type)}>
                    {titleCase(doc.document_type)}
                  </Badge>
                )}
                {profile && (
                  <Badge
                    variant={doc.needs_review ? "warning" : "purple"}
                  >
                    {profile.name}
                    {doc.needs_review ? " · suggested" : ""}
                  </Badge>
                )}
                {/* Inline confirm — only when AI's pick is provisional */}
                {doc.needs_review && profile && (
                  <ConfirmProfileButton
                    documentId={doc.id}
                    profileName={profile.name}
                  />
                )}
                {doc.purchase_category && (
                  <Badge variant="teal">
                    {titleCase(doc.purchase_category)}
                  </Badge>
                )}
                {paymentStatus(doc) === "paid" && (
                  <Badge variant="green">
                    <CheckCircle2 className="h-3 w-3" /> Paid
                  </Badge>
                )}
                {paymentStatus(doc) === "unpaid" && (
                  <Badge variant="warning">
                    <CircleDot className="h-3 w-3" /> Unpaid
                  </Badge>
                )}
                {doc.needs_action && paymentStatus(doc) !== "paid" && (
                  <Badge variant="green">
                    <CircleDot className="h-3 w-3" /> Action
                  </Badge>
                )}
                {doc.sent_to_bookkeeping_at ? (
                  <Badge variant="teal">
                    <CheckCircle2 className="h-3 w-3" /> Sent to bookkeeping
                  </Badge>
                ) : (
                  ["invoice", "receipt", "bill", "utility_bill"].includes(
                    doc.document_type || ""
                  ) && (
                    <Badge variant="warning">
                      <Send className="h-3 w-3" /> Send to bookkeeping
                    </Badge>
                  )
                )}
                {doc.batch && <Badge>{doc.batch}</Badge>}
                {(doc.tags || []).slice(0, 2).map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
                {isFailed && <Badge variant="destructive">failed</Badge>}
              </>
            )}
          </div>
          {/* Storage location breadcrumb — where this file lives in Dropbox */}
          {!isWorking && doc.dropbox_path && (
            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <FolderOpen className="h-3 w-3" />
              <span className="truncate">
                {parseStoragePath(doc.dropbox_path).inInbox
                  ? "Awaiting filing"
                  : storagePathLabel(doc.dropbox_path)}
              </span>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
