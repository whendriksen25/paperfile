/**
 * Deterministic comparison signals between one bank transaction and one
 * bill (pay-action source doc). Used by the suspicion review queue to
 * show the user *why* a pairing is or isn't plausible — concrete chips
 * (amount Δ, date Δ, sender/IBAN/reference match) next to the AI's prose.
 *
 * This is intentionally display-only. It does NOT decide matches — the
 * deterministic matcher (bank-reconciliation.ts) and the AI pass
 * (ai-reconcile.ts) do that. This just makes their reasoning legible.
 */

export interface CompareInputTx {
  amount: number;
  booking_date: string | null;
  value_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  description: string | null;
}

export interface CompareInputBill {
  sender: string | null;
  amount: number | null;
  document_date: string | null;
  due_date: string | null;
  /** Pre-extracted IBAN + reference from the bill's extracted_fields. */
  iban: string | null;
  reference: string | null;
}

export type SignalStatus = "strong" | "weak" | "none";

export interface CompareSignals {
  amount: { status: SignalStatus; label: string; deltaEur: number | null };
  date: { status: SignalStatus; label: string; daysApart: number | null };
  sender: { status: SignalStatus; label: string };
  iban: { status: SignalStatus; label: string };
  reference: { status: SignalStatus; label: string };
  /** 0–5 — count of strong signals. A quick at-a-glance plausibility score. */
  score: number;
}

function nameNorm(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function ibanNorm(s: string | null | undefined): string {
  return (s || "").toUpperCase().replace(/\s+/g, "");
}

function refNorm(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function compareTxToBill(
  tx: CompareInputTx,
  bill: CompareInputBill
): CompareSignals {
  // --- Amount ---
  const txAbs = Math.abs(tx.amount);
  const billAbs = bill.amount != null ? Math.abs(Number(bill.amount)) : null;
  let amount: CompareSignals["amount"];
  if (billAbs == null || !Number.isFinite(billAbs)) {
    amount = { status: "none", label: "bill has no amount", deltaEur: null };
  } else {
    const delta = txAbs - billAbs;
    const absDelta = Math.abs(delta);
    const tolerance = Math.max(0.5, billAbs * 0.005);
    if (absDelta <= tolerance) {
      amount = {
        status: "strong",
        label: `exact (€${billAbs.toFixed(2)})`,
        deltaEur: delta,
      };
    } else if (absDelta <= billAbs * 0.2 + 5) {
      // within 20% — could be a late fee, partial payment, FX surcharge
      amount = {
        status: "weak",
        label: `${delta > 0 ? "+" : "−"}€${absDelta.toFixed(2)} vs bill`,
        deltaEur: delta,
      };
    } else {
      amount = {
        status: "none",
        label: `off by €${absDelta.toFixed(2)}`,
        deltaEur: delta,
      };
    }
  }

  // --- Date ---
  const txDate = tx.booking_date || tx.value_date;
  const billDate = bill.document_date || bill.due_date;
  let date: CompareSignals["date"];
  if (!txDate || !billDate) {
    date = { status: "none", label: "missing date", daysApart: null };
  } else {
    const days =
      Math.abs(new Date(txDate).getTime() - new Date(billDate).getTime()) /
      86400000;
    const d = Math.round(days);
    if (d <= 14) {
      date = { status: "strong", label: `${d}d apart`, daysApart: d };
    } else if (d <= 45) {
      date = { status: "weak", label: `${d}d apart`, daysApart: d };
    } else {
      date = { status: "none", label: `${d}d apart`, daysApart: d };
    }
  }

  // --- Sender / counterparty ---
  const senderN = nameNorm(bill.sender);
  const counterN = nameNorm(tx.counterparty_name || tx.description);
  let sender: CompareSignals["sender"];
  if (!senderN || !counterN) {
    sender = { status: "none", label: "no name to compare" };
  } else if (counterN === senderN) {
    sender = { status: "strong", label: "exact name match" };
  } else if (counterN.includes(senderN) || senderN.includes(counterN)) {
    sender = { status: "strong", label: "name match" };
  } else {
    sender = { status: "none", label: "names differ" };
  }

  // --- IBAN ---
  const billIban = ibanNorm(bill.iban);
  const txIban = ibanNorm(tx.counterparty_iban);
  let iban: CompareSignals["iban"];
  if (!billIban || !txIban) {
    iban = { status: "none", label: "no IBAN to compare" };
  } else if (billIban === txIban) {
    iban = { status: "strong", label: "IBAN match" };
  } else {
    iban = { status: "none", label: "IBAN differs" };
  }

  // --- Reference ---
  const billRef = refNorm(bill.reference);
  const txRefBlob = refNorm(tx.reference) + " " + refNorm(tx.description);
  let reference: CompareSignals["reference"];
  if (!billRef || billRef.length < 4) {
    reference = { status: "none", label: "bill has no reference" };
  } else if (txRefBlob.includes(billRef)) {
    reference = { status: "strong", label: `reference match` };
  } else {
    reference = { status: "none", label: "reference not found in tx" };
  }

  const score = [amount, date, sender, iban, reference].filter(
    (s) => s.status === "strong"
  ).length;

  return { amount, date, sender, iban, reference, score };
}
