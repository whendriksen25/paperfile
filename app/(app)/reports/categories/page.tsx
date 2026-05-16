import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/utils/format";
import { ArrowLeft, ChevronRight } from "lucide-react";
import {
  LINE_ITEM_CATEGORIES,
  LINE_ITEM_CATEGORY_MAP,
} from "@/lib/categories";
import type { ProfileRow } from "@/types/document";

export const dynamic = "force-dynamic";

/**
 * Spending breakdown BY LINE-ITEM CATEGORY.
 *
 * Different from /reports (which buckets whole documents by document_type).
 * This page unrolls every doc's extracted_fields.line_items, groups by
 * the per-line `category`, and sums the totals. Lets you answer questions
 * like "how much did I spend on medical things" — capturing both
 * standalone medical_bill docs AND pharmacy line items hidden inside
 * supermarket receipts.
 *
 * Period + profile filters are independent of /reports — set per page.
 */

function periodRange(period: string): {
  from: string | null;
  to: string | null;
  label: string;
} {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case "all":
      return { from: null, to: null, label: "All time" };
    case "last_year":
      return {
        from: `${y - 1}-01-01`,
        to: `${y - 1}-12-31`,
        label: `${y - 1}`,
      };
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      const from = new Date(y, qStart, 1).toISOString().slice(0, 10);
      const to = new Date(y, qStart + 3, 0).toISOString().slice(0, 10);
      return { from, to, label: `Q${qStart / 3 + 1} ${y}` };
    }
    case "this_year":
    default:
      return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` };
  }
}

interface LineItemForReport {
  category?: string | null;
  total?: number | null;
  currency?: string | null;
  quantity?: number | null;
  unit?: string | null;
  description?: string | null;
}

interface DocReportRow {
  id: string;
  sender: string | null;
  document_date: string | null;
  document_type: string | null;
  primary_profile_id: number | null;
  amount: number | null;
  currency: string | null;
  extracted_fields: Record<string, unknown> | null;
}

export default async function CategorySpendingReport({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; profile_id?: string }>;
}) {
  const sp = await searchParams;
  const period = sp.period || "this_year";
  const range = periodRange(period);
  const profileId = sp.profile_id ? Number(sp.profile_id) : null;
  const supabase = await createClient();

  // Pull every doc in the period (with optional profile filter). We only
  // need a handful of columns; extracted_fields is JSONB so size is the
  // limiting factor — for now, accept the cost. Could later push the
  // jsonb_array_elements aggregation to SQL for bigger-than-personal scale.
  let q = supabase
    .from("documents")
    .select(
      "id, sender, document_date, document_type, primary_profile_id, amount, currency, extracted_fields"
    )
    .neq("status", "deleted");
  if (range.from) q = q.gte("document_date", range.from);
  if (range.to) q = q.lte("document_date", range.to);
  if (profileId != null) q = q.eq("primary_profile_id", profileId);
  q = q.limit(5000);

  const [{ data: docsData, error }, { data: profilesData }] = await Promise.all(
    [q, supabase.from("profiles").select("*")]
  );
  const docs = (docsData || []) as DocReportRow[];
  const profiles = (profilesData || []) as ProfileRow[];

  // Aggregate. Each line item → bucket by category.
  interface Bucket {
    total: number;
    item_count: number;
    doc_ids: Set<string>;
    currency: string | null;
  }
  const buckets = new Map<string, Bucket>();
  /** Add a single line item's total to its bucket. */
  function record(catKey: string, total: number, currency: string | null, docId: string) {
    const b =
      buckets.get(catKey) ||
      { total: 0, item_count: 0, doc_ids: new Set<string>(), currency };
    b.total += total;
    b.item_count += 1;
    b.doc_ids.add(docId);
    if (!b.currency && currency) b.currency = currency;
    buckets.set(catKey, b);
  }

  for (const d of docs) {
    const ef = d.extracted_fields || {};
    const lineItems = ((ef as Record<string, unknown>)["line_items"] ||
      []) as LineItemForReport[];
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      // No line items — fall back to the document-level amount + a best
      // guess at category from document_type. This way a medical_bill
      // without per-line items still contributes to the medical total.
      const docTotal =
        typeof d.amount === "number" && Number.isFinite(d.amount)
          ? d.amount
          : 0;
      if (docTotal === 0) continue;
      const fallbackCat = docTypeToCategory(d.document_type);
      record(fallbackCat, docTotal, d.currency || null, d.id);
      continue;
    }
    for (const li of lineItems) {
      const total =
        typeof li.total === "number" && Number.isFinite(li.total)
          ? li.total
          : 0;
      if (total === 0) continue;
      const cat = li.category || "other";
      record(cat, total, li.currency || d.currency || null, d.id);
    }
  }

  // Sort by absolute total descending so the biggest spend rows surface first.
  const rows = Array.from(buckets.entries())
    .map(([cat, b]) => ({
      category: cat,
      label: LINE_ITEM_CATEGORY_MAP[cat]?.en_label || cat,
      total: b.total,
      item_count: b.item_count,
      doc_count: b.doc_ids.size,
      currency: b.currency,
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const primaryCurrency = rows.find((r) => r.currency)?.currency || "EUR";

  // Sticky filter bar
  function periodHref(p: string) {
    const params = new URLSearchParams();
    params.set("period", p);
    if (profileId != null) params.set("profile_id", String(profileId));
    return `?${params.toString()}`;
  }
  function profileHref(pid: number | null) {
    const params = new URLSearchParams();
    params.set("period", period);
    if (pid != null) params.set("profile_id", String(pid));
    return `?${params.toString()}`;
  }

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <Link
        href="/reports"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to reports
      </Link>
      <h1 className="text-3xl font-extrabold tracking-tight">
        Spending by category
      </h1>
      <p className="text-sm text-muted-foreground mt-1 mb-5">
        {docs.length} document{docs.length === 1 ? "" : "s"} ·{" "}
        {rows.reduce((s, r) => s + r.item_count, 0)} line item
        {rows.reduce((s, r) => s + r.item_count, 0) === 1 ? "" : "s"} · period:{" "}
        {range.label}
      </p>

      {/* Filters */}
      <div className="surface p-3 mb-5 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-muted-foreground mr-1">Period:</span>
        {(
          [
            { k: "this_year", l: "This year" },
            { k: "last_year", l: "Last year" },
            { k: "this_quarter", l: "This quarter" },
            { k: "all", l: "All time" },
          ] as const
        ).map((p) => (
          <Link
            key={p.k}
            href={periodHref(p.k)}
            className={`pill border ${
              period === p.k
                ? "bg-brand-charcoal text-white border-brand-charcoal"
                : "bg-white border-border hover:bg-muted"
            }`}
          >
            {p.l}
          </Link>
        ))}
        <span className="mx-2 h-3 w-px bg-border" />
        <span className="font-bold text-muted-foreground mr-1">Profile:</span>
        <Link
          href={profileHref(null)}
          className={`pill border ${
            profileId == null
              ? "bg-brand-charcoal text-white border-brand-charcoal"
              : "bg-white border-border hover:bg-muted"
          }`}
        >
          All
        </Link>
        {profiles.map((p) => (
          <Link
            key={p.id}
            href={profileHref(p.id)}
            className={`pill border ${
              profileId === p.id
                ? "bg-brand-purple text-white border-brand-purple"
                : "bg-white border-border hover:bg-muted"
            }`}
          >
            {p.name}
          </Link>
        ))}
      </div>

      {error && (
        <div className="surface p-4 text-sm text-destructive">
          Could not load documents: {error.message}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-muted-foreground">
          No spending data found for this period.
        </div>
      ) : (
        <>
          <div className="surface p-5 mb-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                Total
              </h2>
              <span className="text-2xl font-extrabold tabular-nums">
                {formatMoney(grandTotal, primaryCurrency)}
              </span>
            </div>
            {/* Stacked bar — visual proportion of categories. */}
            <StackedBar rows={rows} total={grandTotal} />
          </div>

          <div className="surface p-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-bold py-2 px-2 md:px-0">
                    Category
                  </th>
                  <th className="text-right font-bold py-2 px-2">Items</th>
                  <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                    Docs
                  </th>
                  <th className="text-right font-bold py-2 px-2 whitespace-nowrap">
                    Total
                  </th>
                  <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                    Share
                  </th>
                  <th className="py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const drillHref = `/reports/categories/${encodeURIComponent(r.category)}?period=${period}${profileId != null ? `&profile_id=${profileId}` : ""}`;
                  const share =
                    grandTotal !== 0
                      ? Math.round((r.total / grandTotal) * 100)
                      : 0;
                  return (
                    <tr
                      key={r.category}
                      className="border-t border-border align-top"
                    >
                      <td className="py-2 px-2 md:px-0">
                        <Link
                          href={drillHref}
                          className="font-semibold hover:underline"
                        >
                          {r.label}
                        </Link>
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                        {r.item_count}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                        {r.doc_count}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums font-bold whitespace-nowrap">
                        {formatMoney(r.total, r.currency)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                        {share}%
                      </td>
                      <td className="py-2 px-2 text-right">
                        <Link
                          href={drillHref}
                          className="text-brand-purple inline-flex"
                          title="See every line item in this category"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Fallback for docs without line_items: bucket by document_type into the
 * closest matching line-item category. Keeps a doc-level total visible
 * in the report even when no items were extracted (single-amount bills,
 * legacy docs).
 */
function docTypeToCategory(t: string | null): string {
  switch (t) {
    case "medical_bill":
    case "prescription":
    case "lab_result":
      return "pharmacy";
    case "appointment_letter":
      return "health_service";
    case "utility_bill":
      return "utilities";
    case "tax_document":
      return "tax_fee";
    case "rental_agreement":
      return "housing";
    case "invoice":
    case "receipt":
      return "other";
    case "payslip":
      return "other";
    default:
      return "other";
  }
}

function StackedBar({
  rows,
  total,
}: {
  rows: { category: string; label: string; total: number }[];
  total: number;
}) {
  const positive = rows.filter((r) => r.total > 0);
  const denom = positive.reduce((s, r) => s + r.total, 0) || 1;
  // Distinct colours for the 25 keys — cycle through a stable palette.
  const PALETTE = [
    "bg-brand-purple",
    "bg-brand-green",
    "bg-brand-teal",
    "bg-amber-500",
    "bg-rose-500",
    "bg-indigo-500",
    "bg-blue-500",
    "bg-fuchsia-500",
    "bg-emerald-500",
    "bg-orange-500",
    "bg-cyan-500",
    "bg-pink-500",
  ];
  const colorFor = (cat: string) => {
    const idx = LINE_ITEM_CATEGORIES.findIndex((c) => c.key === cat);
    return PALETTE[(idx >= 0 ? idx : 0) % PALETTE.length];
  };
  return (
    <div className="flex h-3 rounded-full overflow-hidden bg-muted">
      {positive.map((r) => {
        const pct = (r.total / denom) * 100;
        if (pct < 0.5) return null;
        return (
          <div
            key={r.category}
            className={colorFor(r.category)}
            style={{ width: `${pct}%` }}
            title={`${r.label}: ${Math.round(pct)}%`}
          />
        );
      })}
    </div>
  );
}
