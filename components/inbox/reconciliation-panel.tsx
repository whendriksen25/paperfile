"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * Bank-statement reconciliation summary panel.
 *
 * Shown only on docs with document_type === "bank_statement". Displays the
 * counts from the last reconciliation run (matched / ambiguous / unmatched
 * / considered) and offers a "Re-reconcile" button.
 *
 * Clicking any of the three stat cards (Matched, Ambiguous, Unmatched)
 * toggles an inline list showing every transaction in that bucket — so
 * you can see exactly which debits the matcher decided what about, not
 * just a count.
 */

export interface PanelSuspicion {
  possible_action_ids?: string[];
  possible_doc_ids?: string[];
  reasoning: string;
  confidence: number;
}

export interface PanelTransaction {
  id: string;
  amount: number;
  booking_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  description: string | null;
  match_status: string | null;
  match_reason: string | null;
  matched_action_id: string | null;
  matched_document_id: string | null;
  match_method?: string | null;
  match_confidence?: number | null;
  suspicions?: PanelSuspicion[] | null;
  currency: string | null;
}

type Bucket = "matched" | "ambiguous" | "unmatched" | "suspicions";

export function ReconciliationPanel({
  documentId,
  initial,
  transactions = [],
}: {
  documentId: string;
  initial: {
    ran_at: string | null;
    matched: number;
    ambiguous: number;
    unmatched: number;
    considered: number;
  } | null;
  transactions?: PanelTransaction[];
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openBucket, setOpenBucket] = useState<Bucket | null>(null);

  const buckets = useMemo(() => {
    const m: PanelTransaction[] = [];
    const a: PanelTransaction[] = [];
    const u: PanelTransaction[] = [];
    const s: PanelTransaction[] = [];
    for (const t of transactions) {
      if (t.amount >= 0) continue;
      if (t.match_status === "matched") m.push(t);
      else if (t.match_status === "ambiguous") a.push(t);
      else u.push(t); // null or 'unmatched' → unmatched bucket
      // Suspicions can appear on any row that hasn't been matched —
      // typically unmatched, occasionally ambiguous.
      if (
        t.match_status !== "matched" &&
        t.suspicions &&
        t.suspicions.length > 0
      ) {
        s.push(t);
      }
    }
    return { matched: m, ambiguous: a, unmatched: u, suspicions: s };
  }, [transactions]);

  async function reconcile() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/reconcile`, {
        method: "POST",
      });
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

  function toggle(b: Bucket) {
    setOpenBucket((cur) => (cur === b ? null : b));
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
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            <Stat label="Considered" value={data.considered} />
            <Stat
              label="Matched"
              value={buckets.matched.length}
              green
              onClick={() => toggle("matched")}
              active={openBucket === "matched"}
            />
            <Stat
              label="Ambiguous"
              value={data.ambiguous}
              amber
              onClick={() => toggle("ambiguous")}
              active={openBucket === "ambiguous"}
            />
            <Stat
              label="Unmatched"
              value={data.unmatched}
              muted
              onClick={() => toggle("unmatched")}
              active={openBucket === "unmatched"}
            />
            <Stat
              label="Suspicions"
              value={buckets.suspicions.length}
              indigo
              onClick={() => toggle("suspicions")}
              active={openBucket === "suspicions"}
            />
          </div>

          {openBucket && (
            <TransactionList
              bucket={openBucket}
              transactions={buckets[openBucket]}
            />
          )}

          <p className="text-[11px] text-muted-foreground mt-3">
            Tap a stat to expand. Matched debits auto-closed their pay
            actions and marked the source bills as paid. Ambiguous =
            multiple possible bills for one transaction (review manually).
            Unmatched = transactions with no corresponding open bill —
            likely subscription, transfer, or paid outside Paperfile.
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
  indigo,
  onClick,
  active,
}: {
  label: string;
  value: number;
  green?: boolean;
  amber?: boolean;
  muted?: boolean;
  indigo?: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  const tone = green
    ? "text-brand-green"
    : amber
      ? "text-amber-600"
      : indigo
        ? "text-indigo-600"
        : muted
          ? "text-muted-foreground"
          : "text-foreground";
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={`p-2 rounded-md transition-colors ${
        clickable
          ? "hover:bg-foreground/5 cursor-pointer"
          : "cursor-default"
      } ${active ? "bg-foreground/5 ring-1 ring-brand-teal/40" : ""}`}
    >
      <div className={`text-2xl font-extrabold ${tone} inline-flex items-center gap-1`}>
        {value}
        {clickable && (
          <span className="text-[10px] text-muted-foreground">
            {active ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </span>
        )}
      </div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
        {label}
      </div>
    </button>
  );
}

function TransactionList({
  bucket,
  transactions,
}: {
  bucket: Bucket;
  transactions: PanelTransaction[];
}) {
  const [showAll, setShowAll] = useState(false);
  const limit = 25;
  const shown = showAll ? transactions : transactions.slice(0, limit);
  const more = transactions.length - shown.length;

  if (transactions.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground italic">
        (No {bucket} transactions.)
      </p>
    );
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
        {bucket} — {transactions.length}
      </div>
      <div className="space-y-1 max-h-96 overflow-y-auto -mx-2 px-2">
        {shown.map((t) => (
          <TransactionRow key={t.id} t={t} bucket={bucket} />
        ))}
      </div>
      {more > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs font-semibold text-brand-teal hover:opacity-80 mt-2"
        >
          Show {more} more
        </button>
      )}
    </div>
  );
}

function TransactionRow({
  t,
  bucket,
}: {
  t: PanelTransaction;
  bucket: Bucket;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const isMatched = bucket === "matched" && t.matched_document_id;
  const showSuspicions =
    bucket === "suspicions" && t.suspicions && t.suspicions.length > 0;
  const aiTag =
    t.match_method === "ai_high"
      ? "AI"
      : t.match_method === "ai_review"
        ? "AI · verify"
        : t.match_method === "manual"
          ? "manual"
          : null;

  async function suspicionAction(
    action: "confirm" | "dismiss",
    docId?: string
  ) {
    setBusy(action + (docId || ""));
    try {
      const res = await fetch(
        `/api/bank-transactions/${t.id}/suspicion-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            possible_doc_id: docId,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || "Failed");
      } else {
        setHidden(true);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  if (hidden) return null;

  return (
    <div className="py-1.5 text-xs border-b border-border/40 last:border-0">
      <div className="flex items-start gap-2">
        <span className="text-muted-foreground tabular-nums w-20 shrink-0">
          {t.booking_date ? formatDate(t.booking_date) : "—"}
        </span>
        <span className="flex-1 min-w-0">
          <span className="font-semibold block truncate">
            {t.counterparty_name || t.description || "—"}
            {aiTag && (
              <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-indigo-600 align-middle">
                {aiTag}
                {t.match_confidence != null
                  ? ` ${(t.match_confidence * 100).toFixed(0)}%`
                  : ""}
              </span>
            )}
          </span>
          {t.match_reason && (
            <span className="text-[10px] text-muted-foreground block truncate">
              {t.match_reason}
            </span>
          )}
          {!t.match_reason && t.reference && (
            <span className="text-[10px] text-muted-foreground block truncate">
              ref: {t.reference}
            </span>
          )}
        </span>
        <span className="font-bold tabular-nums text-rose-700 shrink-0">
          {formatMoney(t.amount, t.currency)}
        </span>
        {isMatched && (
          <a
            href={`/document/${t.matched_document_id}`}
            className="text-brand-teal text-[10px] font-bold uppercase tracking-wide hover:underline shrink-0"
          >
            bill →
          </a>
        )}
      </div>

      {showSuspicions && t.suspicions && (
        <div className="mt-1.5 ml-22 space-y-1">
          {t.suspicions.map((s, i) => (
            <div
              key={i}
              className="border-l-2 border-indigo-300 pl-2 py-1 bg-indigo-50/40 rounded-r"
            >
              <div className="text-[10px] text-indigo-900 leading-snug">
                <span className="font-bold">
                  Suspicion ({(s.confidence * 100).toFixed(0)}%):{" "}
                </span>
                {s.reasoning}
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {(s.possible_doc_ids || []).map((docId) => (
                  <span
                    key={docId}
                    className="inline-flex items-center gap-1"
                  >
                    <a
                      href={`/document/${docId}`}
                      className="text-[10px] text-brand-teal font-bold underline"
                    >
                      view bill
                    </a>
                    <button
                      type="button"
                      disabled={busy === "confirm" + docId}
                      onClick={() => suspicionAction("confirm", docId)}
                      className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 hover:bg-emerald-100 px-1.5 py-0.5 rounded disabled:opacity-50"
                    >
                      {busy === "confirm" + docId ? "…" : "confirm match"}
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  disabled={busy === "dismiss"}
                  onClick={() => suspicionAction("dismiss")}
                  className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:bg-muted px-1.5 py-0.5 rounded disabled:opacity-50"
                >
                  {busy === "dismiss" ? "…" : "dismiss"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
