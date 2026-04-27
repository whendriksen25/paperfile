"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Trash2, Loader2 } from "lucide-react";

/**
 * Soft duplicate banner shown on the document detail page when analyze
 * flagged this doc as a likely duplicate of another (same sender + date +
 * amount + type). Doesn't block — gives the user two clear choices: keep
 * both (just dismiss) or delete this one (soft-deletes via existing API).
 */
export function DuplicateBanner({
  currentId,
  duplicate,
}: {
  currentId: string;
  duplicate: {
    id: string;
    title: string | null;
    sender: string | null;
    document_date: string | null;
  };
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label =
    duplicate.title ||
    [duplicate.sender, duplicate.document_date].filter(Boolean).join(" · ") ||
    "another document";

  async function deleteThisOne() {
    if (!confirm("Soft-delete this document? The original stays intact.")) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${currentId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || `Delete failed (HTTP ${res.status})`);
        setDeleting(false);
        return;
      }
      // After delete, jump to the original.
      router.push(`/document/${duplicate.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setDeleting(false);
    }
  }

  return (
    <div className="surface p-4 mb-5 bg-amber-50 border-amber-300">
      <div className="flex items-start gap-3">
        <Copy className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-amber-900">
            Looks like a duplicate
          </div>
          <p className="text-xs text-amber-800 mt-0.5">
            Paperfile already has a document with the same sender, date, type,
            and amount:{" "}
            <Link
              href={`/document/${duplicate.id}`}
              className="underline font-semibold hover:opacity-80"
            >
              {label}
            </Link>
            .
          </p>
          {error && (
            <p className="text-xs text-destructive mt-1 font-semibold">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2.5">
            <button
              type="button"
              onClick={deleteThisOne}
              disabled={deleting}
              className="text-xs font-bold text-amber-900 hover:opacity-80 inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Delete this one (keep the original)
            </button>
            <span className="text-xs text-amber-700">
              · or just leave both
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
