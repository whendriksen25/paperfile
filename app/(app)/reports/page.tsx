import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney, titleCase } from "@/lib/utils/format";
import { Download } from "lucide-react";
import type { DocumentRow, ProfileRow } from "@/types/document";

export const dynamic = "force-dynamic";

/**
 * Document types we treat as "medical" by default. The Reports view ships
 * with a Medical preset because that's the most common use case (tax /
 * insurance prep), but the user can override with arbitrary types via the
 * ?type=foo&type=bar query params.
 */
const MEDICAL_TYPES = [
  "medical_bill",
  "prescription",
  "lab_result",
  "appointment_letter",
];

/**
 * Date-range presets. ?period=this_year | last_year | this_quarter | all
 * Defaults to this_year.
 */
function periodRange(period: string): { from: string | null; to: string | null; label: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
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

interface ReportRow {
  id: string;
  document_date: string | null;
  sender: string | null;
  title: string | null;
  document_type: string | null;
  amount: number | null;
  currency: string | null;
  primary_profile_id: number | null;
  extracted_fields: Record<string, unknown> | null;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    profile_id?: string;
    type?: string | string[];
    period?: string;
  }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  // Profile picker — defaults to "all" if not specified
  const profileId = sp.profile_id ? Number(sp.profile_id) : null;

  // Type multi-select (medical preset by default). Accepts ?type=a&type=b.
  const types = Array.isArray(sp.type)
    ? sp.type
    : sp.type
      ? [sp.type]
      : MEDICAL_TYPES;

  // Period preset
  const period = sp.period || "this_year";
  const { from, to, label: periodLabel } = periodRange(period);

  // Pull all matching documents (capped at 1000 — should comfortably hold a
  // year of personal expenses).
  let q = supabase
    .from("documents")
    .select(
      "id, document_date, sender, title, document_type, amount, currency, primary_profile_id, extracted_fields"
    )
    .neq("status", "deleted")
    .in("document_type", types)
    .order("document_date", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (profileId) q = q.eq("primary_profile_id", profileId);
  if (from) q = q.gte("document_date", from);
  if (to) q = q.lte("document_date", to);

  const [{ data, error }, { data: profileData }] = await Promise.all([
    q,
    supabase.from("profiles").select("*"),
  ]);

  const docs = ((data || []) as ReportRow[]).filter((d) => d.amount != null);
  const profiles = (profileData || []) as ProfileRow[];
  const activeProfile = profileId
    ? profiles.find((p) => p.id === profileId) || null
    : null;

  // Aggregations
  const total = docs.reduce((s, d) => s + Number(d.amount || 0), 0);
  const currency = docs[0]?.currency || "EUR";

  const byType = new Map<string, { count: number; total: number }>();
  for (const d of docs) {
    const t = d.document_type || "other";
    const cur = byType.get(t) || { count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(d.amount || 0);
    byType.set(t, cur);
  }
  const typeBreakdown = Array.from(byType.entries())
    .map(([type, v]) => ({ type, ...v }))
    .sort((a, b) => b.total - a.total);

  // Monthly buckets (YYYY-MM)
  const byMonth = new Map<string, { count: number; total: number }>();
  for (const d of docs) {
    const date = d.document_date || "";
    const key = date.slice(0, 7) || "unknown";
    const cur = byMonth.get(key) || { count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(d.amount || 0);
    byMonth.set(key, cur);
  }
  const monthlyBreakdown = Array.from(byMonth.entries())
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const maxMonthlyTotal = Math.max(1, ...monthlyBreakdown.map((m) => m.total));

  // Quick-pay status counts
  const paidCount = docs.filter(
    (d) =>
      String(
        (d.extracted_fields as Record<string, unknown> | null)?.[
          "payment_status"
        ] || ""
      ).toLowerCase() === "paid"
  ).length;

  // Build CSV download URL preserving filters
  const csvParams = new URLSearchParams();
  if (profileId) csvParams.set("profile_id", String(profileId));
  for (const t of types) csvParams.append("type", t);
  csvParams.set("period", period);
  const csvHref = `/api/reports/export?${csvParams.toString()}`;

  // Helper to build link URLs preserving everything except the field being changed
  function withParam(key: string, value: string | null): string {
    const p = new URLSearchParams();
    if (profileId && key !== "profile_id") p.set("profile_id", String(profileId));
    if (key === "profile_id" && value) p.set("profile_id", value);
    for (const t of types) {
      if (key === "type") continue;
      p.append("type", t);
    }
    if (key === "period" && value) p.set("period", value);
    else p.set("period", period);
    return `/reports?${p.toString()}`;
  }

  // Toggle a type chip on/off
  function withTypeToggle(type: string): string {
    const next = types.includes(type)
      ? types.filter((t) => t !== type)
      : [...types, type];
    const p = new URLSearchParams();
    if (profileId) p.set("profile_id", String(profileId));
    for (const t of next) p.append("type", t);
    p.set("period", period);
    return `/reports?${p.toString()}`;
  }

  if (error) {
    return (
      <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
        <div className="surface p-6 text-sm text-destructive">
          Could not load report: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Watch it</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Total spend by profile and category, over a chosen period.
        </p>
      </header>

      {/* Filters */}
      <div className="surface p-5 mb-5 space-y-4">
        {/* Profile */}
        <div>
          <div className="section-label mb-2">Profile</div>
          <div className="flex flex-wrap gap-2">
            <FilterPill
              href={withParam("profile_id", null)}
              active={!profileId}
            >
              All profiles
            </FilterPill>
            {profiles.map((p) => (
              <FilterPill
                key={p.id}
                href={withParam("profile_id", String(p.id))}
                active={profileId === p.id}
              >
                {p.name}
              </FilterPill>
            ))}
          </div>
        </div>

        {/* Categories */}
        <div>
          <div className="section-label mb-2 flex items-center justify-between">
            <span>Document types</span>
            <span className="text-[10px] text-muted-foreground">
              Click to toggle
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              "medical_bill",
              "prescription",
              "lab_result",
              "appointment_letter",
              "invoice",
              "receipt",
              "utility_bill",
              "payslip",
            ].map((t) => (
              <FilterPill
                key={t}
                href={withTypeToggle(t)}
                active={types.includes(t)}
              >
                {titleCase(t)}
              </FilterPill>
            ))}
          </div>
        </div>

        {/* Period */}
        <div>
          <div className="section-label mb-2">Period</div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["this_year", "This year"],
                ["last_year", "Last year"],
                ["this_quarter", "This quarter"],
                ["all", "All time"],
              ] as [string, string][]
            ).map(([k, label]) => (
              <FilterPill
                key={k}
                href={withParam("period", k)}
                active={period === k}
              >
                {label}
              </FilterPill>
            ))}
          </div>
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid sm:grid-cols-3 gap-3 mb-5">
        <SummaryCard
          label="Total"
          value={formatMoney(total, currency)}
          sub={`${docs.length} ${docs.length === 1 ? "document" : "documents"} · ${periodLabel}${activeProfile ? " · " + activeProfile.name : ""}`}
          highlight
        />
        <SummaryCard
          label="Average per doc"
          value={
            docs.length > 0
              ? formatMoney(total / docs.length, currency)
              : formatMoney(0, currency)
          }
          sub="Across all matching documents"
        />
        <SummaryCard
          label="Marked paid"
          value={`${paidCount} / ${docs.length}`}
          sub="Documents the AI saw a paid stamp on"
        />
      </div>

      {/* Per-type breakdown */}
      {typeBreakdown.length > 0 && (
        <div className="surface p-5 mb-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-sm">By document type</h2>
            <a
              href={csvHref}
              className="btn-secondary text-xs !py-2"
            >
              <Download className="h-3.5 w-3.5" /> Download CSV
            </a>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-bold py-2">Type</th>
                <th className="text-right font-bold py-2">Count</th>
                <th className="text-right font-bold py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {typeBreakdown.map((b) => (
                <tr key={b.type} className="border-t border-border">
                  <td className="py-2 font-semibold">{titleCase(b.type)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {b.count}
                  </td>
                  <td className="py-2 text-right tabular-nums font-bold">
                    {formatMoney(b.total, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Monthly trend */}
      {monthlyBreakdown.length > 0 && (
        <div className="surface p-5 mb-5">
          <h2 className="font-bold text-sm mb-3">By month</h2>
          <div className="space-y-2">
            {monthlyBreakdown.map((m) => {
              const pct = (m.total / maxMonthlyTotal) * 100;
              return (
                <div key={m.month} className="flex items-center gap-3 text-xs">
                  <div className="w-20 tabular-nums text-muted-foreground">
                    {m.month}
                  </div>
                  <div className="flex-1 h-5 bg-muted rounded-full relative overflow-hidden">
                    <div
                      className="h-full bg-brand-purple/70 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="w-20 text-right tabular-nums font-semibold">
                    {formatMoney(m.total, currency)}
                  </div>
                  <div className="w-10 text-right tabular-nums text-muted-foreground">
                    {m.count}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Document list */}
      <div className="surface p-5">
        <h2 className="font-bold text-sm mb-3">
          Documents in this report ({docs.length})
        </h2>
        {docs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No documents match this filter. Try a different period or add more
            categories.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 md:mx-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-bold py-2 px-2 md:px-0">Date</th>
                  <th className="text-left font-bold py-2 px-2">Sender</th>
                  <th className="text-left font-bold py-2 px-2 hidden sm:table-cell">
                    Type
                  </th>
                  <th className="text-right font-bold py-2 px-2">Amount</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="py-2 px-2 md:px-0 tabular-nums">
                      {d.document_date ? formatDate(d.document_date) : "—"}
                    </td>
                    <td className="py-2 px-2 max-w-xs truncate">
                      <Link
                        href={`/document/${d.id}`}
                        className="font-semibold hover:text-brand-purple"
                      >
                        {d.sender || d.title || "Unknown"}
                      </Link>
                    </td>
                    <td className="py-2 px-2 hidden sm:table-cell text-muted-foreground">
                      {titleCase(d.document_type || "—")}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums font-bold">
                      {formatMoney(d.amount, d.currency || currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`pill border transition-colors ${
        active
          ? "bg-brand-purple text-white border-brand-purple"
          : "bg-white text-foreground border-border hover:bg-muted"
      }`}
    >
      {children}
    </Link>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`surface p-5 ${
        highlight
          ? "bg-brand-gradient-soft border-brand-purple/30"
          : ""
      }`}
    >
      <div className="section-label">{label}</div>
      <div
        className={`mt-1 text-2xl font-extrabold tabular-nums ${
          highlight ? "text-brand-gradient" : "text-foreground"
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
