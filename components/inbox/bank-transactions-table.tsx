import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * Renders the per-transaction breakdown of a bank statement document.
 * Different shape than receipt/invoice line items — bank lines have
 * date / counterparty / reference / amount instead of qty / unit / total.
 *
 * Transactions come from the bank_transactions table (canonical column
 * name: `amount`). Older callers that pass `total` (e.g. when transactions
 * are pulled from extracted_fields.line_items in legacy code paths) are
 * still supported via the alias.
 */
export interface BankTx {
  description?: string | null;
  /** Canonical signed amount column from bank_transactions. */
  amount?: number | null;
  /** Backward-compat alias for older callers passing line_items shape. */
  total?: number | null;
  currency?: string | null;
  counterparty_name?: string | null;
  counterparty_iban?: string | null;
  reference?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_id?: string | null;
  cdt_dbt?: string | null;
}

/** Pull the signed amount from a transaction regardless of which field carries it. */
function amountOf(t: BankTx): number {
  const v = t.amount ?? t.total;
  return typeof v === "number" ? v : Number(v);
}

export function BankTransactionsTable({
  transactions,
  currency,
}: {
  transactions: BankTx[];
  currency?: string | null;
}) {
  if (!transactions || transactions.length === 0) {
    return (
      <div className="surface p-5 mb-5">
        <h2 className="font-bold text-sm mb-2">Transactions</h2>
        <p className="text-sm text-muted-foreground">
          No transactions were extracted from this statement.
        </p>
      </div>
    );
  }

  const totals = transactions.reduce(
    (acc, t) => {
      const amt = amountOf(t);
      if (!Number.isFinite(amt)) return acc;
      if (amt < 0) acc.debit += Math.abs(amt);
      else if (amt > 0) acc.credit += amt;
      return acc;
    },
    { debit: 0, credit: 0 }
  );

  return (
    <div className="surface p-5 mb-5">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="font-bold text-sm">
          Transactions{" "}
          <span className="font-normal text-muted-foreground">
            ({transactions.length})
          </span>
        </h2>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-700 font-semibold">
            + {formatMoney(totals.credit, currency || null)}
          </span>
          <span className="text-rose-700 font-semibold">
            − {formatMoney(totals.debit, currency || null)}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto -mx-5 md:mx-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left font-bold py-2 px-2 md:px-0 whitespace-nowrap">
                Date
              </th>
              <th className="text-left font-bold py-2 px-2">Counterparty</th>
              <th className="text-left font-bold py-2 px-2 hidden md:table-cell">
                Reference
              </th>
              <th className="text-right font-bold py-2 px-2 whitespace-nowrap">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t, i) => {
              const amt = amountOf(t);
              const isDebit = Number.isFinite(amt) && amt < 0;
              const dateStr =
                t.booking_date || t.value_date || null;
              return (
                <tr
                  key={i}
                  className="border-t border-border align-top"
                >
                  <td className="py-2 px-2 md:px-0 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    {dateStr ? formatDate(dateStr) : "—"}
                  </td>
                  <td className="py-2 px-2">
                    <div className="font-semibold leading-tight">
                      {t.counterparty_name || t.description || "—"}
                    </div>
                    {t.counterparty_iban && (
                      <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                        {t.counterparty_iban}
                      </div>
                    )}
                    {/* On mobile, show the reference inline under the
                       counterparty since the Reference column is hidden. */}
                    {t.reference && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 md:hidden break-all">
                        {t.reference}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 hidden md:table-cell text-xs text-muted-foreground break-all max-w-[280px]">
                    {t.reference || ""}
                  </td>
                  <td
                    className={`py-2 px-2 text-right tabular-nums font-bold whitespace-nowrap ${
                      isDebit
                        ? "text-rose-700"
                        : amt > 0
                          ? "text-emerald-700"
                          : "text-foreground"
                    }`}
                  >
                    {Number.isFinite(amt)
                      ? formatMoney(amt, t.currency || currency || null)
                      : "—"}
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
