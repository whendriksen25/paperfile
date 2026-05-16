"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  XCircle,
  ChevronRight,
  Loader2,
  Search,
} from "lucide-react";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { DocumentPreview } from "@/components/inbox/document-preview";
import type { CompareSignals } from "@/lib/services/reconcile-compare";

// ---- Types shared with the server page ----

export interface ReviewBill {
  action_id: string;
  document_id: string;
  sender: string | null;
  amount: number | null;
  currency: string | null;
  document_date: string | null;
  due_date: string | null;
  file_name: string | null;
  file_type: string | null;
  iban: string | null;
  reference: string | null;
}

export interface ReviewItem {
  tx: {
    id: string;
    amount: number;
    currency: string | null;
    booking_date: string | null;
    value_date: string | null;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    reference: string | null;
    description: string | null;
  };
  ai_reasoning: string;
  ai_confidence: number;
  candidates: Array<{ bill: ReviewBill; signals: CompareSignals }>;
}

// ---- Signal chip ----

function SignalChip({
  label,
  status,
}: {
  label: string;
  status: "strong" | "weak" | "none";
}) {
  const cls =
    status === "strong"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "weak"
        ? "bg-amber-100 text-amber-800 border-amber-300"
        : "bg-muted text-muted-foreground border-border";
  return (
    <span
      className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}
    >
      {label}
    </span>
  );
}

// ---- Main queue ----

export function ReviewQueue({
  items,
  allBills,
}: {
  items: ReviewItem[];
  allBills: ReviewBill[];
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  const item = items[index];
  const doneCount = resolved.size;

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return allBills
      .filter(
        (b) =>
          (b.sender || "").toLowerCase().includes(q) ||
          String(b.amount ?? "").includes(q) ||
          (b.reference || "").toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [search, allBills]);

  function advance() {
    setShowSearch(false);
    setSearch("");
    // Jump to the next not-yet-resolved item.
    let next = index + 1;
    while (next < items.length && resolved.has(items[next].tx.id)) next++;
    if (next < items.length) setIndex(next);
    else {
      // All done — refresh so the panel counts update.
      router.refresh();
      setIndex(items.length); // sentinel: past the end
    }
  }

  async function act(
    action: "confirm" | "dismiss",
    possibleDocId?: string
  ) {
    if (!item) return;
    setBusy(action + (possibleDocId || ""));
    try {
      const res = await fetch(
        `/api/bank-transactions/${item.tx.id}/suspicion-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, possible_doc_id: possibleDocId }),
        }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.error || "Action failed");
        return;
      }
      setResolved((prev) => new Set(prev).add(item.tx.id));
      advance();
    } finally {
      setBusy(null);
    }
  }

  if (!item || index >= items.length) {
    return (
      <div className="surface p-6 text-center">
        <CheckCircle2 className="h-8 w-8 text-brand-green mx-auto mb-2" />
        <div className="font-bold text-sm">All suspicions reviewed</div>
        <p className="text-xs text-muted-foreground mt-1">
          {doneCount} resolved this session.
        </p>
      </div>
    );
  }

  const { tx } = item;

  return (
    <div>
      {/* Progress */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-muted-foreground">
          {doneCount} of {items.length} reviewed
        </div>
        <button
          type="button"
          onClick={advance}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          Skip <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="h-1.5 bg-muted rounded overflow-hidden mb-5">
        <div
          className="h-full bg-brand-teal transition-all"
          style={{ width: `${(doneCount / items.length) * 100}%` }}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* LEFT — the bank transaction */}
        <div className="surface p-4">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
            Bank transaction
          </div>
          <div className="text-2xl font-extrabold text-rose-700 tabular-nums">
            {formatMoney(tx.amount, tx.currency)}
          </div>
          <dl className="mt-3 space-y-1.5 text-xs">
            <Row label="Date">
              {tx.booking_date ? formatDate(tx.booking_date) : "—"}
            </Row>
            <Row label="Counterparty">
              {tx.counterparty_name || tx.description || "—"}
            </Row>
            <Row label="IBAN">
              <span className="font-mono">{tx.counterparty_iban || "—"}</span>
            </Row>
            <Row label="Reference">
              <span className="break-all">{tx.reference || "—"}</span>
            </Row>
            {tx.description && tx.description !== tx.counterparty_name && (
              <Row label="Description">
                <span className="break-all text-muted-foreground">
                  {tx.description}
                </span>
              </Row>
            )}
          </dl>
          {item.ai_reasoning && (
            <div className="mt-3 border-l-2 border-indigo-300 pl-2 py-1 bg-indigo-50/50 rounded-r">
              <div className="text-[10px] font-bold text-indigo-900 uppercase tracking-wider">
                AI flagged this — {(item.ai_confidence * 100).toFixed(0)}%
              </div>
              <p className="text-[11px] text-indigo-900 leading-snug mt-0.5">
                {item.ai_reasoning}
              </p>
            </div>
          )}
        </div>

        {/* RIGHT — candidate bills */}
        <div className="space-y-3">
          {item.candidates.length === 0 && (
            <div className="surface p-4 text-xs text-muted-foreground">
              The AI didn&apos;t name a specific bill — use the search below
              to find one, or dismiss this transaction.
            </div>
          )}
          {item.candidates.map(({ bill, signals }) => (
            <CandidateCard
              key={bill.document_id}
              bill={bill}
              signals={signals}
              busy={busy === "confirm" + bill.document_id}
              onBook={() => act("confirm", bill.document_id)}
            />
          ))}

          {/* Pick a different bill */}
          {!showSearch ? (
            <button
              type="button"
              onClick={() => setShowSearch(true)}
              className="w-full text-xs font-semibold text-brand-teal hover:opacity-80 inline-flex items-center justify-center gap-1 py-2 border border-dashed border-border rounded-lg"
            >
              <Search className="h-3.5 w-3.5" />
              Pick a different bill
            </button>
          ) : (
            <div className="surface p-3">
              <input
                autoFocus
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by sender, amount, or reference…"
                className="w-full text-xs border border-border rounded px-2 py-1.5 bg-background"
              />
              <div className="mt-2 space-y-1 max-h-64 overflow-y-auto">
                {searchResults.map((b) => (
                  <button
                    key={b.document_id}
                    type="button"
                    disabled={busy === "confirm" + b.document_id}
                    onClick={() => act("confirm", b.document_id)}
                    className="w-full text-left text-xs p-2 rounded hover:bg-muted disabled:opacity-50 flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0">
                      <span className="font-semibold block truncate">
                        {b.sender || "—"}
                      </span>
                      <span className="text-muted-foreground">
                        {b.document_date ? formatDate(b.document_date) : "—"}
                        {b.reference ? ` · ref ${b.reference}` : ""}
                      </span>
                    </span>
                    <span className="font-bold tabular-nums shrink-0">
                      {b.amount != null
                        ? formatMoney(b.amount, b.currency)
                        : "—"}
                    </span>
                  </button>
                ))}
                {search.trim() && searchResults.length === 0 && (
                  <div className="text-[11px] text-muted-foreground py-1">
                    No open bills match.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dismiss */}
          <button
            type="button"
            disabled={busy === "dismiss"}
            onClick={() => act("dismiss")}
            className="w-full text-xs font-semibold text-rose-700 hover:bg-rose-50 inline-flex items-center justify-center gap-1 py-2 border border-rose-200 rounded-lg disabled:opacity-50"
          >
            {busy === "dismiss" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            Not a bill payment — dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted-foreground w-24 shrink-0">{label}</dt>
      <dd className="font-medium min-w-0">{children}</dd>
    </div>
  );
}

function CandidateCard({
  bill,
  signals,
  busy,
  onBook,
}: {
  bill: ReviewBill;
  signals: CompareSignals;
  busy: boolean;
  onBook: () => void;
}) {
  const [showDoc, setShowDoc] = useState(false);
  return (
    <div className="surface p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-sm truncate">
            {bill.sender || "—"}
          </div>
          <div className="text-xs text-muted-foreground">
            {bill.document_date ? formatDate(bill.document_date) : "—"}
            {bill.due_date ? ` · due ${formatDate(bill.due_date)}` : ""}
          </div>
        </div>
        <div className="text-lg font-extrabold tabular-nums shrink-0">
          {bill.amount != null ? formatMoney(bill.amount, bill.currency) : "—"}
        </div>
      </div>

      {/* Comparison signals — the "why" the user asked for */}
      <div className="flex flex-wrap gap-1 mt-2">
        <SignalChip label={`amount: ${signals.amount.label}`} status={signals.amount.status} />
        <SignalChip label={`date: ${signals.date.label}`} status={signals.date.status} />
        <SignalChip label={signals.sender.label} status={signals.sender.status} />
        <SignalChip label={signals.iban.label} status={signals.iban.status} />
        <SignalChip label={signals.reference.label} status={signals.reference.status} />
      </div>

      <div className="flex items-center gap-2 mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={onBook}
          className="text-xs font-bold text-white bg-brand-teal hover:opacity-90 px-3 py-1.5 rounded-lg inline-flex items-center gap-1 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Book against this bill
        </button>
        <button
          type="button"
          onClick={() => setShowDoc((v) => !v)}
          className="text-xs font-semibold text-brand-teal hover:opacity-80"
        >
          {showDoc ? "Hide" : "View"} invoice
        </button>
        <a
          href={`/document/${bill.document_id}`}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground ml-auto"
        >
          Open ↗
        </a>
      </div>

      {showDoc && (
        <div className="mt-3">
          <DocumentPreview
            id={bill.document_id}
            fileName={bill.file_name}
            fileType={bill.file_type}
            className="rounded-lg bg-muted w-full h-[360px] border border-border"
          />
        </div>
      )}
    </div>
  );
}
