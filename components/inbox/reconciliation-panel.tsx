"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";

/**
 * Bank-statement reconciliation summary panel.
 *
 * Shown only on docs with document_type === "bank_statement". Displays the
 * counts from the last auto-reconciliation run (matched / ambiguous /
 * unmatched / considered) and offers a "Re-reconcile" button that runs
 * the matcher again — useful when new pay actions have been created
 * since the statement was first analysed.
 */
export function ReconciliationPanel({
  documentId,
  initial,
}: {
  documentId: string;
  initial: {
    ran_at: string | null;
    matched: number;
    ambiguous: number;
    unmatched: number;
    considered: number;
  } | null;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reconcile() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/documents/${documentId}/reconcile`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Reconcile failed");
      setData({ ran_at: new Date().toISOString(), ...json.result });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="surface p-5 mb-5 bg-brand-teal/5 border-brand-teal/30">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-brand-teal" />
          <div className="text-sm font-bold">Reconciliation</div>
        </div>
        <button
          type="button"
          onClick={reconcile}
          disabled={running}
          className="text-xs font-semibold text-brand-teal hover:opacity-80 inline-flex items-center gap-1 disabled:opacity-50"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Re-reconcile
        </button>
      </div>

      {data ? (
        <>
          <div className="grid grid-cols-4 gap-3 text-center text-xs">
            <Stat label="Considered" value={data.considered} />
            <Stat label="Matched" value={data.matched} green />
            <Stat label="Ambiguous" value={data.ambiguous} amber />
            <Stat label="Unmatched" value={data.unmatched} muted />
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            Matched debits auto-closed their pay actions and marked the
            source bills as paid. Ambiguous = multiple possible bills for one
            transaction (review manually). Unmatched = transactions with no
            corresponding open bill — likely subscription, transfer, or paid
            outside Paperfile.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No reconciliation run yet. Click Re-reconcile to match debit
          transactions against your open pay actions.
        </p>
      )}

      {error && (
        <p className="text-xs text-destructive font-semibold mt-2 inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  green,
  amber,
  muted,
}: {
  label: string;
  value: number;
  green?: boolean;
  amber?: boolean;
  muted?: boolean;
}) {
  const tone = green
    ? "text-brand-green"
    : amber
      ? "text-amber-600"
      : muted
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div>
      <div className={`text-2xl font-extrabold ${tone}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {label}
      </div>
    </div>
  );
}
