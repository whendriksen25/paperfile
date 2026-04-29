"use client";

import { useEffect, useState } from "react";
import { Copy, Check, QrCode } from "lucide-react";

/**
 * Inline payment helper for `pay` actions on the /actions page.
 *
 * Pulls IBAN, amount, currency, payment reference, and beneficiary name
 * from the source document's extracted_fields, surfaces them as
 * tap-to-copy fields, and renders a SEPA SCT (EPC) QR code that any
 * Dutch banking app can scan to pre-fill the payment form.
 *
 * Why no per-bank deep links: every Dutch bank app supports the
 * standardised EPC QR (the "scan to pay" function in ING, Rabo, ABN,
 * Bunq, ASN, Knab, etc.). One QR fits all. Falling back to copy buttons
 * for users on apps that don't scan QRs.
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
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  // Build the EPC SCT QR payload per the European Payments Council spec.
  // 12 fixed lines; some can be empty but the line breaks must be present.
  // Reference: https://www.europeanpaymentscouncil.eu/document-library/guidance-documents/quick-response-code-guidelines-enable-data-capture-initiation
  const epcPayload = (() => {
    if (!iban) return null;
    const cleanIban = iban.replace(/\s+/g, "").toUpperCase();
    const cleanBic = (bic || "").replace(/\s+/g, "").toUpperCase();
    // Amount: must be EUR, max 999999999.99, no thousand separator
    const amountStr =
      amount != null && (currency || "EUR").toUpperCase() === "EUR"
        ? `EUR${amount.toFixed(2)}`
        : "";
    return [
      "BCD",
      "002",
      "1",
      "SCT",
      cleanBic,
      (beneficiary || "Onbekend").slice(0, 70),
      cleanIban,
      amountStr,
      "", // purpose (4-char ISO code) — leave blank
      "", // structured ref — we put it in remittance instead
      (reference || "").slice(0, 140),
      "", // info to beneficiary
    ].join("\n");
  })();

  // Generate the QR client-side. Lazy-loaded so the qrcode library doesn't
  // ship in the main bundle for users who never open this component.
  useEffect(() => {
    let cancelled = false;
    if (!epcPayload) {
      setQrDataUrl(null);
      return;
    }
    (async () => {
      try {
        const mod = await import("qrcode");
        const dataUrl = await mod.toDataURL(epcPayload, {
          margin: 1,
          width: 240,
          errorCorrectionLevel: "M",
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch (e) {
        if (!cancelled)
          setQrError(e instanceof Error ? e.message : "QR generation failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [epcPayload]);

  if (!iban) {
    return (
      <div className="surface p-5">
        <div className="section-label mb-2">Pay</div>
        <p className="text-xs text-muted-foreground">
          No IBAN extracted from this document. Open the source preview below
          and copy the payment details manually, or refile after Re-analyse if
          the IBAN should have been picked up.
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
    <div className="surface p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="section-label">Pay</div>
        <span className="text-[11px] uppercase tracking-wider font-bold text-brand-purple">
          SEPA QR · scan with any bank app
        </span>
      </div>

      <div className="grid sm:grid-cols-[1fr_auto] gap-5 items-start">
        {/* Copy fields */}
        <dl className="space-y-2 text-sm">
          <CopyRow label="Amount" value={formattedAmount} mono />
          <CopyRow label="Beneficiary" value={beneficiary || "—"} />
          <CopyRow label="IBAN" value={formattedIban} mono />
          {bic && <CopyRow label="BIC" value={bic} mono />}
          <CopyRow label="Reference" value={reference || "—"} mono />
        </dl>

        {/* QR */}
        <div className="flex flex-col items-center gap-2">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt="SEPA payment QR"
              className="rounded-xl border border-border bg-white p-2"
              width={200}
              height={200}
            />
          ) : qrError ? (
            <div className="text-xs text-destructive font-semibold flex items-center gap-1">
              <QrCode className="h-3.5 w-3.5" /> QR error
            </div>
          ) : (
            <div className="w-[200px] h-[200px] rounded-xl bg-muted/50 flex items-center justify-center text-xs text-muted-foreground">
              Generating…
            </div>
          )}
          <p className="text-[11px] text-muted-foreground text-center max-w-[200px]">
            Open your bank app, tap &quot;Scan to pay&quot; (or camera), point
            at this code.
          </p>
        </div>
      </div>
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
