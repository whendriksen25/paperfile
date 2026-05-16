import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { ArrowLeft, ChevronRight, FileText } from "lucide-react";
import { LINE_ITEM_CATEGORY_MAP } from "@/lib/categories";
import type { ProfileRow } from "@/types/document";

export const dynamic = "force-dynamic";

/**
 * Hierarchical drill-down for spending by line-item category_path.
 *
 * Routes:
 *   /reports/categories/groceries
 *     → group by category_path[1] (produce, dairy, bakery, ...)
 *   /reports/categories/groceries/produce
 *     → group by category_path[2] (fruit, vegetables, ...)
 *   /reports/categories/groceries/produce/fruit
 *     → group by category_path[3] (apple, banana, ...)
 *   /reports/categories/groceries/produce/fruit/apple
 *     → leaf: show every line item printed as "apple" across all docs
 *
 * Backward-compat: line items with only the flat `category` field (no
 * category_path) are still matched at depth 0 — they appear under their
 * top category as "uncategorised deeper" items at the leaf.
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
  description?: string | null;
  category?: string | null;
  category_path?: string[] | null;
  quantity?: number | null;
  unit?: string | null;
  total?: number | null;
  currency?: string | null;
}

interface DocReportRow {
  id: string;
  sender: string | null;
  document_date: string | null;
  document_type: string | null;
  primary_profile_id: number | null;
  currency: string | null;
  extracted_fields: Record<string, unknown> | null;
}

function labelFor(key: string, depth: number): string {
  if (depth === 0) {
    return LINE_ITEM_CATEGORY_MAP[key]?.en_label || titleish(key);
  }
  return titleish(key);
}
function titleish(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function CategoryDrillDown({
  params,
  searchParams,
}: {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ period?: string; profile_id?: string }>;
}) {
  const { path: rawPath } = await params;
  const sp = await searchParams;
  const period = sp.period || "this_year";
  const range = periodRange(period);
  const profileId = sp.profile_id ? Number(sp.profile_id) : null;

  // Decode each segment (Next.js auto-decodes once, but path segments
  // with funky characters may need a second pass).
  const path = (rawPath || []).map((s) => decodeURIComponent(s));
  if (path.length === 0) notFound();
  const depth = path.length; // 1 means we're at the top key, drilling to subcat

  const supabase = await createClient();
  let q = supabase
    .from("documents")
    .select(
      "id, sender, document_date, document_type, primary_profile_id, currency, extracted_fields"
    )
    .neq("status", "deleted");
  if (range.from) q = q.gte("document_date", range.from);
  if (range.to) q = q.lte("document_date", range.to);
  if (profileId != null) q = q.eq("primary_profile_id", profileId);
  q = q.limit(5000);

  const [{ data: docsData, error }, { data: profilesData }] = await Promise.all([
    q,
    supabase.from("profiles").select("*"),
  ]);
  const docs = (docsData || []) as DocReportRow[];
  const profiles = (profilesData || []) as ProfileRow[];

  // Normalise each line item's path. Use category_path when present;
  // fall back to [category] for legacy data.
  function pathOf(li: LineItemForReport): string[] {
    if (Array.isArray(li.category_path) && li.category_path.length > 0) {
      return li.category_path
        .map((s) => String(s || "").toLowerCase().trim())
        .filter(Boolean);
    }
    return li.category ? [String(li.category).toLowerCase().trim()] : [];
  }

  // Filter line items whose path STARTS WITH our request path.
  type LineWithDoc = {
    li: LineItemForReport;
    docId: string;
    sender: string | null;
    docDate: string | null;
    path: string[];
  };
  const matched: LineWithDoc[] = [];
  for (const d of docs) {
    const items = ((d.extracted_fields || {})["line_items"] ||
      []) as LineItemForReport[];
    if (!Array.isArray(items)) continue;
    for (const li of items) {
      const p = pathOf(li);
      const matches = path.every(
        (seg, i) => p[i] && p[i] === seg.toLowerCase()
      );
      if (matches)
        matched.push({
          li,
          docId: d.id,
          sender: d.sender,
          docDate: d.document_date,
          path: p,
        });
    }
  }

  // Decide whether we're at a leaf (no further levels) or aggregating
  // by the next path segment.
  const hasDeeper = matched.some((m) => m.path.length > depth);

  // Build current breadcrumb hrefs.
  function hrefForLevel(upToDepth: number): string {
    const params = new URLSearchParams();
    if (period !== "this_year") params.set("period", period);
    if (profileId != null) params.set("profile_id", String(profileId));
    const qs = params.toString();
    return (
      "/reports/categories/" +
      path
        .slice(0, upToDepth)
        .map((s) => encodeURIComponent(s))
        .join("/") +
      (qs ? `?${qs}` : "")
    );
  }
  function hrefForChild(childSeg: string): string {
    const params = new URLSearchParams();
    if (period !== "this_year") params.set("period", period);
    if (profileId != null) params.set("profile_id", String(profileId));
    const qs = params.toString();
    return (
      "/reports/categories/" +
      [...path, childSeg].map((s) => encodeURIComponent(s)).join("/") +
      (qs ? `?${qs}` : "")
    );
  }

  // Aggregate.
  let nextBuckets: Map<
    string,
    { total: number; count: number; docs: Set<string>; currency: string | null }
  > | null = null;
  if (hasDeeper) {
    nextBuckets = new Map();
    for (const m of matched) {
      const nextSeg = m.path[depth] || "(uncategorised)";
      const total =
        typeof m.li.total === "number" && Number.isFinite(m.li.total)
          ? m.li.total
          : 0;
      const cur =
        nextBuckets.get(nextSeg) ||
        {
          total: 0,
          count: 0,
          docs: new Set<string>(),
          currency: m.li.currency || null,
        };
      cur.total += total;
      cur.count += 1;
      cur.docs.add(m.docId);
      if (!cur.currency && m.li.currency) cur.currency = m.li.currency;
      nextBuckets.set(nextSeg, cur);
    }
  }

  const totalAll = matched.reduce(
    (sum, m) =>
      sum +
      (typeof m.li.total === "number" && Number.isFinite(m.li.total)
        ? m.li.total
        : 0),
    0
  );
  const primaryCurrency =
    matched.find((m) => m.li.currency)?.li.currency || "EUR";

  // Breadcrumb labels.
  const crumbs = path.map((seg, i) => ({
    label: labelFor(seg, i),
    href: hrefForLevel(i + 1),
  }));

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <Link
        href={`/reports/categories${
          period !== "this_year" || profileId != null
            ? `?period=${period}${profileId != null ? `&profile_id=${profileId}` : ""}`
            : ""
        }`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to all categories
      </Link>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-xs mb-3">
        <Link
          href={`/reports/categories${
            period !== "this_year" || profileId != null
              ? `?period=${period}${profileId != null ? `&profile_id=${profileId}` : ""}`
              : ""
          }`}
          className="font-semibold text-muted-foreground hover:text-foreground"
        >
          Categories
        </Link>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            {i === crumbs.length - 1 ? (
              <span className="font-bold">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="font-semibold text-brand-purple hover:underline"
              >
                {c.label}
              </Link>
            )}
          </span>
        ))}
      </div>

      <h1 className="text-2xl font-extrabold tracking-tight">
        {crumbs[crumbs.length - 1].label}
      </h1>
      <p className="text-sm text-muted-foreground mt-1 mb-5">
        {matched.length} line item{matched.length === 1 ? "" : "s"} ·{" "}
        {formatMoney(totalAll, primaryCurrency)} · period: {range.label}
        {profileId != null && profiles.find((p) => p.id === profileId) ? (
          <> · profile: {profiles.find((p) => p.id === profileId)?.name}</>
        ) : null}
      </p>

      {error && (
        <div className="surface p-4 text-sm text-destructive">
          Could not load documents: {error.message}
        </div>
      )}

      {matched.length === 0 ? (
        <div className="surface p-8 text-center text-sm text-muted-foreground">
          No line items found at this category path for the current filters.
        </div>
      ) : nextBuckets && nextBuckets.size > 0 ? (
        <div className="surface p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">
            Drill down further
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-bold py-2">Subcategory</th>
                <th className="text-right font-bold py-2 px-2">Items</th>
                <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                  Docs
                </th>
                <th className="text-right font-bold py-2 px-2 whitespace-nowrap">
                  Total
                </th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {Array.from(nextBuckets.entries())
                .sort(
                  ([, a], [, b]) => Math.abs(b.total) - Math.abs(a.total)
                )
                .map(([seg, b]) => (
                  <tr key={seg} className="border-t border-border align-top">
                    <td className="py-2">
                      <Link
                        href={hrefForChild(seg)}
                        className="font-semibold hover:underline"
                      >
                        {titleish(seg)}
                      </Link>
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                      {b.count}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground hidden md:table-cell">
                      {b.docs.size}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums font-bold whitespace-nowrap">
                      {formatMoney(b.total, b.currency)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <Link
                        href={hrefForChild(seg)}
                        className="text-brand-purple inline-flex"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        // Leaf — show individual line items.
        <div className="surface p-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">
            Individual items
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-bold py-2">Description</th>
                <th className="text-left font-bold py-2 px-2 hidden sm:table-cell">
                  Doc / sender
                </th>
                <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                  Date
                </th>
                <th className="text-right font-bold py-2 px-2">Qty</th>
                <th className="text-right font-bold py-2 px-2 whitespace-nowrap">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {matched
                .sort((a, b) => {
                  const da = a.docDate || "";
                  const db = b.docDate || "";
                  return db.localeCompare(da);
                })
                .map((m, i) => {
                  const t = typeof m.li.total === "number" ? m.li.total : null;
                  const qty =
                    typeof m.li.quantity === "number" ? m.li.quantity : null;
                  return (
                    <tr
                      key={`${m.docId}-${i}`}
                      className="border-t border-border align-top"
                    >
                      <td className="py-2">
                        <div className="font-semibold leading-tight">
                          {m.li.description || "—"}
                        </div>
                      </td>
                      <td className="py-2 px-2 text-xs text-muted-foreground hidden sm:table-cell">
                        <Link
                          href={`/document/${m.docId}`}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          <FileText className="h-3 w-3" />
                          {m.sender || m.docId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 px-2 text-xs text-right text-muted-foreground tabular-nums hidden md:table-cell whitespace-nowrap">
                        {m.docDate ? formatDate(m.docDate) : "—"}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                        {qty != null
                          ? `${qty}${m.li.unit ? " " + m.li.unit : ""}`
                          : ""}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums font-bold whitespace-nowrap">
                        {t != null
                          ? formatMoney(t, m.li.currency || primaryCurrency)
                          : ""}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
