"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * Inline payment helper for `pay` actions on the /actions page.
 *
 * Surfaces the amount, beneficiary, IBAN, BIC and reference as
 * tap-to-copy fields. Open your bank app's "Manual transfer" screen and
 * paste each field into the matching input.
 *
 * Why no QR code: in the Netherlands, banks don't scan generic SEPA
 * (EPC SCT) QR codes — only Bunq supports them, and even then only
 * partially. iDEAL QR requires a merchant account, Tikkie URLs need a
 * registered request via their API. Tap-to-copy works in every Dutch
 * bank app without bank-specific integration.
 */
export function PaymentHelper({
  amount,
  currency,
  iban,
  reference,
  beneficiary,
  bic,
}: {
  amount: number | null;
  currency: string | null;
  iban: string | null;
  reference: string | null;
  beneficiary: string | null;
  bic: string | null;
}) {
  if (!iban) {
    return (
      <div className="surface p-5">
        <div className="section-label mb-2">Pay</div>
        <p className="text-xs text-muted-foreground">
          No IBAN extracted from this document. Open the source preview below
          to copy the payment details manually, or hit Re-analyse if the IBAN
          should have been picked up.
        </p>
      </div>
    );
  }

  const formattedAmount =
    amount != null
      ? `${(currency || "EUR").toUpperCase()} ${amount.toFixed(2)}`
      : "—";
  const formattedIban = iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

  return (
    <div className="surface p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="section-label">Pay</div>
        <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">
          Tap any field to copy
        </span>
      </div>

      <dl className="space-y-2 text-sm">
        <CopyRow label="Amount" value={formattedAmount} mono />
        <CopyRow label="Beneficiary" value={beneficiary || "—"} />
        <CopyRow label="IBAN" value={formattedIban} mono />
        {bic && <CopyRow label="BIC" value={bic} mono />}
        <CopyRow label="Reference" value={reference || "—"} mono />
      </dl>

      <p className="text-[11px] text-muted-foreground">
        Open your bank app&apos;s manual transfer (overschrijving) screen and
        paste each field. Most NL bank apps don&apos;t scan SEPA QR codes, so
        copy + paste is the most reliable route.
      </p>
    </div>
  );
}

function CopyRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (value === "—") return;
    navigator.clipboard.writeText(value.replace(/\s+/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
      <dt className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground min-w-[90px]">
        {label}
      </dt>
      <dd
        className={`flex-1 text-right break-all ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </dd>
      <button
        type="button"
        onClick={copy}
        disabled={value === "—"}
        className="p-1.5 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-brand-green" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
