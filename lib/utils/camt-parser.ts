import { XMLParser } from "fast-xml-parser";

/**
 * Lightweight CAMT.053 ("BkToCstmrStmt") parser.
 *
 * CAMT.053 is the ISO 20022 standard every Dutch bank exports under
 * "Download account statement" / "Periodieke afschriften" — XML, machine
 * readable, much more reliable than PDFs.
 *
 * Spec reference (overview):
 *   https://www.iso20022.org/iso-20022-message-definitions
 *   https://www.betaalvereniging.nl/giraal-betalingsverkeer/sepa-credit-transfer/
 *
 * We extract only the fields we need for reconciliation against `pay`
 * actions: signed amount, dates, counterparty name + IBAN, payment
 * reference, transaction id.
 */

export interface CamtTransaction {
  /** Negative for debit (outgoing), positive for credit (incoming). */
  amount: number;
  currency: string;
  /** ISO YYYY-MM-DD — the booking date (date the bank applied it). */
  booking_date: string | null;
  /** ISO YYYY-MM-DD — the value date if different from booking. */
  value_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  /** Free-text or structured reference, whichever is populated. */
  reference: string | null;
  /** Bank-side unique id (AcctSvcrRef). */
  transaction_id: string | null;
  /** "DBIT" | "CRDT" — the original CAMT indicator, kept for clarity. */
  cdt_dbt: "DBIT" | "CRDT" | null;
}

export interface CamtStatement {
  account_iban: string | null;
  account_holder: string | null;
  /** ISO. */
  period_start: string | null;
  /** ISO. */
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  currency: string | null;
  transactions: CamtTransaction[];
}

/**
 * Sniff whether a buffer LOOKS like a CAMT.053 XML statement. Caller uses
 * this to decide whether to skip the Claude extraction path entirely.
 */
export function looksLikeCamt053(buffer: Buffer): boolean {
  // Sample the first 4KB — XML documents declare their root early
  const head = buffer.toString("utf8", 0, Math.min(4096, buffer.length));
  if (!head.includes("<?xml")) return false;
  return /BkToCstmrStmt|camt\.053|Document\b/i.test(head);
}

/** Coerce an XML scalar that fast-xml-parser might give as string|number. */
function asString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    // fast-xml-parser surfaces text content under "#text" when there are
    // also attributes on the element.
    const t = (v as Record<string, unknown>)["#text"];
    if (t != null) return asString(t);
  }
  return null;
}

/** Walk a possibly-nested key path; return the first scalar found. */
function pick(node: unknown, path: string[]): unknown {
  let cur: unknown = node;
  for (const key of path) {
    if (cur == null) return null;
    if (typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Normalise a single Ntry (entry / transaction) into our shape. */
function parseEntry(ntry: Record<string, unknown>): CamtTransaction | null {
  // Amount with Ccy attribute
  const amtNode = ntry["Amt"];
  let amount = 0;
  let currency = "EUR";
  if (typeof amtNode === "object" && amtNode != null) {
    const text = (amtNode as Record<string, unknown>)["#text"];
    const ccy = (amtNode as Record<string, unknown>)["@_Ccy"];
    amount = Number(text);
    if (typeof ccy === "string") currency = ccy;
  } else {
    amount = Number(amtNode);
  }
  if (!Number.isFinite(amount)) return null;

  const cdtDbtRaw = asString(ntry["CdtDbtInd"]);
  const cdtDbt =
    cdtDbtRaw === "DBIT" || cdtDbtRaw === "CRDT"
      ? (cdtDbtRaw as "DBIT" | "CRDT")
      : null;
  const signed = cdtDbt === "DBIT" ? -Math.abs(amount) : Math.abs(amount);

  const bookingDate =
    asString(pick(ntry, ["BookgDt", "Dt"])) ||
    asString(pick(ntry, ["BookgDt", "DtTm"]));
  const valueDate =
    asString(pick(ntry, ["ValDt", "Dt"])) ||
    asString(pick(ntry, ["ValDt", "DtTm"]));

  // Transaction details: NtryDtls.TxDtls (sometimes an array, sometimes one)
  const ntryDtls = ntry["NtryDtls"] as Record<string, unknown> | undefined;
  const txDtlsRaw = ntryDtls?.["TxDtls"];
  const txDtls = (
    Array.isArray(txDtlsRaw) ? txDtlsRaw[0] : txDtlsRaw
  ) as Record<string, unknown> | undefined;

  // Counterparty: when CdtDbtInd === DBIT, we (the account holder) are the
  // debtor and the counterparty is the creditor. Conversely for CRDT.
  let counterpartyName: string | null = null;
  let counterpartyIban: string | null = null;
  if (txDtls) {
    const rltdPties = txDtls["RltdPties"] as
      | Record<string, unknown>
      | undefined;
    const rltdAgts = txDtls["RltdAgts"] as
      | Record<string, unknown>
      | undefined;
    if (cdtDbt === "DBIT") {
      counterpartyName =
        asString(pick(rltdPties, ["Cdtr", "Nm"])) ||
        asString(pick(rltdPties, ["UltmtCdtr", "Nm"])) ||
        null;
      counterpartyIban =
        asString(pick(rltdPties, ["CdtrAcct", "Id", "IBAN"])) ||
        asString(pick(rltdAgts, ["CdtrAgt", "FinInstnId", "BICFI"])) ||
        null;
    } else if (cdtDbt === "CRDT") {
      counterpartyName =
        asString(pick(rltdPties, ["Dbtr", "Nm"])) ||
        asString(pick(rltdPties, ["UltmtDbtr", "Nm"])) ||
        null;
      counterpartyIban =
        asString(pick(rltdPties, ["DbtrAcct", "Id", "IBAN"])) || null;
    }
  }

  // Reference / remittance info — Strd preferred (structured), Ustrd fallback.
  const rmtInf =
    (txDtls && (txDtls["RmtInf"] as Record<string, unknown>)) || undefined;
  let reference: string | null = null;
  if (rmtInf) {
    // Structured creditor reference (CdtrRefInf.Ref)
    const strdRaw = rmtInf["Strd"];
    const strd = (Array.isArray(strdRaw) ? strdRaw[0] : strdRaw) as
      | Record<string, unknown>
      | undefined;
    reference =
      asString(pick(strd, ["CdtrRefInf", "Ref"])) ||
      asString(rmtInf["Ustrd"]) ||
      null;
  }
  // Fallback to AddtlNtryInf when there's no RmtInf.
  if (!reference) {
    reference = asString(ntry["AddtlNtryInf"]) || null;
  }

  const transactionId =
    asString(pick(txDtls, ["Refs", "AcctSvcrRef"])) ||
    asString(ntry["AcctSvcrRef"]) ||
    null;

  return {
    amount: signed,
    currency,
    booking_date: bookingDate ? bookingDate.slice(0, 10) : null,
    value_date: valueDate ? valueDate.slice(0, 10) : null,
    counterparty_name: counterpartyName,
    counterparty_iban: counterpartyIban,
    reference,
    transaction_id: transactionId,
    cdt_dbt: cdtDbt,
  };
}

/**
 * Parse a CAMT.053 XML document into a normalised statement structure.
 * Throws if the document isn't a recognisable CAMT.053.
 */
export function parseCamt053(xmlText: string): CamtStatement {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    parseTagValue: false, // keep as strings, we coerce explicitly
    trimValues: true,
  });
  const doc = parser.parse(xmlText) as Record<string, unknown>;

  // Some banks wrap as <Document><BkToCstmrStmt>...; some directly.
  const root =
    (doc["Document"] as Record<string, unknown>) ||
    (doc["BkToCstmrStmt"] as Record<string, unknown>) ||
    doc;
  const bkToCstmrStmt =
    (root["BkToCstmrStmt"] as Record<string, unknown>) || root;
  const stmtRaw = bkToCstmrStmt["Stmt"];
  if (!stmtRaw) {
    throw new Error("Not a CAMT.053 document — missing BkToCstmrStmt/Stmt");
  }
  const stmt = (Array.isArray(stmtRaw) ? stmtRaw[0] : stmtRaw) as Record<
    string,
    unknown
  >;

  const accountIban = asString(pick(stmt, ["Acct", "Id", "IBAN"]));
  const accountHolder = asString(pick(stmt, ["Acct", "Ownr", "Nm"]));
  const ccy = asString(pick(stmt, ["Acct", "Ccy"])) || "EUR";

  const fromDate = asString(pick(stmt, ["FrToDt", "FrDtTm"]));
  const toDate = asString(pick(stmt, ["FrToDt", "ToDtTm"]));

  // Balances — pull OPBD/CLBD codes
  let opening: number | null = null;
  let closing: number | null = null;
  const balRaw = stmt["Bal"];
  const balances = (
    Array.isArray(balRaw) ? balRaw : balRaw ? [balRaw] : []
  ) as Record<string, unknown>[];
  for (const b of balances) {
    const code = asString(pick(b, ["Tp", "CdOrPrtry", "Cd"]));
    const amtNode = b["Amt"];
    let v: number | null = null;
    if (typeof amtNode === "object" && amtNode != null) {
      const text = (amtNode as Record<string, unknown>)["#text"];
      v = Number(text);
    } else {
      v = Number(amtNode);
    }
    const ind = asString(b["CdtDbtInd"]);
    if (v != null && Number.isFinite(v) && ind === "DBIT") v = -v;
    if (code === "OPBD" || code === "PRCD") opening = v;
    if (code === "CLBD") closing = v;
  }

  const ntryRaw = stmt["Ntry"];
  const entries = (
    Array.isArray(ntryRaw) ? ntryRaw : ntryRaw ? [ntryRaw] : []
  ) as Record<string, unknown>[];
  const transactions: CamtTransaction[] = [];
  for (const e of entries) {
    const t = parseEntry(e);
    if (t) transactions.push(t);
  }

  return {
    account_iban: accountIban,
    account_holder: accountHolder,
    period_start: fromDate ? fromDate.slice(0, 10) : null,
    period_end: toDate ? toDate.slice(0, 10) : null,
    opening_balance: opening,
    closing_balance: closing,
    currency: ccy,
    transactions,
  };
}
