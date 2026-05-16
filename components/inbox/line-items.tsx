import { formatMoney, titleCase } from "@/lib/utils/format";
import { LINE_ITEM_CATEGORY_MAP } from "@/lib/categories";

/** Canonical English label from the shared categories file (falls back to titleCase). */
function categoryLabel(key: string | null | undefined): string {
  if (!key) return "";
  return LINE_ITEM_CATEGORY_MAP[key]?.en_label || titleCase(key);
}

/**
 * Each item Claude extracts may carry:
 *   description, category, quantity, unit_price, vat_rate, vat_amount,
 *   total, currency, reference
 *
 * Only `description` is required by the prompt — everything else may be null.
 */
export interface LineItem {
  description?: string | null;
  category?: string | null;
  quantity?: number | null;
  /** Unit the quantity is in: kg, g, L, ml, m, pack, each, ... */
  unit?: string | null;
  unit_price?: number | null;
  vat_rate?: number | null;
  vat_amount?: number | null;
  total?: number | null;
  currency?: string | null;
  reference?: string | null;
  /** Per-line discount printed on the receipt (positive number). */
  discount_amount?: number | null;
  /** Verbatim raw line as printed (e.g. "0,428 kg × €4,99 €2,14"). */
  printed_raw?: string | null;
  /** Hierarchical category path: [top_key, sub, more_specific, ...].
   * Index 0 == `category` (top-level key). Drill-down reports use this. */
  category_path?: string[] | null;
}

/** Pick a brand chip color per category — keeps the table scannable. */
function categoryChipClass(cat: string | null | undefined): string {
  if (!cat) return "bg-muted text-muted-foreground";
  switch (cat) {
    case "groceries":
    case "beverages":
    case "restaurant":
      return "bg-brand-green/12 text-brand-green";
    case "alcohol":
      return "bg-amber-100 text-amber-700";
    case "household":
    case "toiletries":
    case "appliances":
      return "bg-brand-blue/12 text-brand-blue";
    case "pharmacy":
    case "health_service":
      return "bg-rose-100 text-rose-700";
    case "clothing":
    case "baby_kids":
    case "pet":
      return "bg-fuchsia-100 text-fuchsia-700";
    case "electronics":
    case "subscription":
      return "bg-brand-purple/12 text-brand-purple";
    case "fuel":
    case "transport":
    case "travel":
      return "bg-cyan-100 text-cyan-700";
    case "entertainment":
    case "gift":
      return "bg-violet-100 text-violet-700";
    case "utilities":
    case "housing":
    case "insurance":
      return "bg-slate-100 text-slate-700";
    case "diy_garden":
    case "office_supplies":
    case "professional_service":
      return "bg-stone-100 text-stone-700";
    case "tax_fee":
    case "shipping":
      return "bg-zinc-100 text-zinc-700";
    case "discount":
    case "deposit_return":
      return "bg-emerald-50 text-emerald-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/** Roll up line totals by category. */
function rollup(items: LineItem[]): { category: string; total: number; count: number }[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const it of items) {
    const cat = it.category || "other";
    const total = typeof it.total === "number" ? it.total : 0;
    const cur = map.get(cat) || { total: 0, count: 0 };
    cur.total += total;
    cur.count += 1;
    map.set(cat, cur);
  }
  return Array.from(map.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

export function LineItemsSection({
  items,
  currency,
}: {
  items: LineItem[];
  currency?: string | null;
}) {
  if (!items || items.length === 0) return null;

  const buckets = rollup(items);

  return (
    <div className="surface p-5 mb-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-sm">Line items</h2>
        <span className="text-xs text-muted-foreground">
          {items.length} {items.length === 1 ? "line" : "lines"}
        </span>
      </div>

      {/* Category roll-up chips */}
      {buckets.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {buckets.map((b) => (
            <span
              key={b.category}
              className={`pill ${categoryChipClass(b.category)}`}
            >
              {categoryLabel(b.category)}
              <span className="opacity-70 font-bold">
                {formatMoney(b.total, currency || null)}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* Items table */}
      <div className="overflow-x-auto -mx-5 md:mx-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-bold py-2 px-2 md:px-0">Item</th>
              <th className="text-left font-bold py-2 px-2 hidden sm:table-cell">
                Category
              </th>
              <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                Qty
              </th>
              <th className="text-right font-bold py-2 px-2 hidden md:table-cell">
                Unit
              </th>
              <th className="text-right font-bold py-2 px-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const isNeg = typeof it.total === "number" && it.total < 0;
              return (
                <tr
                  key={i}
                  className="border-t border-border align-top"
                >
                  <td className="py-2 px-2 md:px-0">
                    <div className="font-semibold leading-tight">
                      {it.description || "—"}
                    </div>
                    {it.reference && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {it.reference}
                      </div>
                    )}
                    {/* On mobile, show category inline */}
                    {it.category && (
                      <span
                        className={`pill mt-1 sm:hidden ${categoryChipClass(
                          it.category
                        )}`}
                      >
                        {categoryLabel(it.category)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2 hidden sm:table-cell">
                    {it.category && (
                      <span className={`pill ${categoryChipClass(it.category)}`}>
                        {categoryLabel(it.category)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums hidden md:table-cell text-muted-foreground">
                    {it.quantity != null
                      ? `${it.quantity}${it.unit ? " " + it.unit : ""}`
                      : ""}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums hidden md:table-cell text-muted-foreground">
                    {it.unit_price != null
                      ? formatMoney(it.unit_price, it.currency || currency || null)
                      : ""}
                  </td>
                  <td
                    className={`py-2 px-2 text-right tabular-nums font-bold ${
                      isNeg ? "text-emerald-700" : "text-foreground"
                    }`}
                  >
                    {it.total != null
                      ? formatMoney(it.total, it.currency || currency || null)
                      : ""}
                    {it.discount_amount != null && it.discount_amount !== 0 && (
                      <div className="text-[10px] text-rose-700 font-semibold mt-0.5">
                        −{formatMoney(it.discount_amount, it.currency || currency || null)} discount
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
