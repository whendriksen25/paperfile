import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, titleCase } from "@/lib/utils/format";
import {
  FileText,
  Image as ImageIcon,
  Mail,
  Receipt,
  CircleDot,
} from "lucide-react";
import type { DocumentRow, ProfileRow } from "@/types/document";

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

export function DocumentCard({
  doc,
  profile,
}: {
  doc: DocumentRow;
  profile?: ProfileRow | null;
}) {
  const Icon = iconFor(doc.document_type);
  return (
    <Link
      href={`/document/${doc.id}`}
      className="surface block p-5 hover:shadow-card transition-all animate-fade-in"
    >
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 shrink-0 rounded-2xl bg-brand-gradient-soft flex items-center justify-center">
          <Icon className="h-5 w-5 text-brand-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-foreground truncate">
                {doc.title || doc.file_name || "Untitled document"}
              </h3>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {doc.sender || titleCase(doc.document_type) || "Unknown sender"}
                {doc.document_date ? ` · ${formatDate(doc.document_date)}` : ""}
              </p>
            </div>
            {doc.amount != null && (
              <span className="text-sm font-bold text-foreground shrink-0">
                {formatMoney(doc.amount, doc.currency)}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {doc.document_type && (
              <Badge variant={categoryVariant(doc.document_type)}>
                {titleCase(doc.document_type)}
              </Badge>
            )}
            {profile && <Badge variant="purple">{profile.name}</Badge>}
            {doc.purchase_category && (
              <Badge variant="teal">{titleCase(doc.purchase_category)}</Badge>
            )}
            {doc.needs_action && (
              <Badge variant="green">
                <CircleDot className="h-3 w-3" /> Action
              </Badge>
            )}
            {doc.batch && <Badge>{doc.batch}</Badge>}
            {(doc.tags || []).slice(0, 2).map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            {doc.status !== "processed" && (
              <Badge
                variant={doc.status === "failed" ? "destructive" : "warning"}
              >
                {doc.status}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
