"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Loader2, Zap } from "lucide-react";

/**
 * Shown when Claude's extraction stopped at the max_tokens boundary on
 * this doc, meaning part of the data was almost certainly cut off.
 * Offers a one-click "Retry full" that re-analyses with the extended
 * 128k output cap (Sonnet 4 beta header) — the only docs reaching this
 * banner are large PDFs / unstructured exports where 64k wasn't enough.
 *
 * Honest cost note: the extended retry costs whatever the doc actually
 * needs (typically €0.40-1.20). The banner shows an estimate so the
 * user can decide before hitting the button.
 */
export function TruncationBanner({
  documentId,
  estimatedExtraCostEur,
}: {
  documentId: string;
  estimatedExtraCostEur: number;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    if (
      !confirm(
        `Re-analyse this document with the full 128k-token output cap?\n\nEstimated extra cost: €${estimatedExtraCostEur.toFixed(2)}.`
      )
    )
      return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/analyze/${documentId}?force_profile=0&max_cap=extended`,
        { method: "POST" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="surface p-4 mb-5 bg-amber-50 border-amber-300">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-amber-900">
            Extraction was truncated
          </div>
          <p className="text-xs text-amber-800 mt-0.5">
            Claude hit the 64k output cap on this document — some content
            past that point is missing. Retry with the full 128k cap to
            capture everything.
          </p>
          {error && (
            <p className="text-xs text-destructive font-semibold mt-1">
              {error}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={retry}
              disabled={running}
              className="text-xs font-bold text-amber-900 hover:opacity-80 inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              Retry with full capacity (~€{estimatedExtraCostEur.toFixed(2)} extra)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
