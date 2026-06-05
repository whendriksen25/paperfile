import { parse as csvParse } from "csv-parse/sync";

/**
 * Deterministic parser for Rabobank "Boekingen exporteren → CSV"
 * exports. Mirrors the CAMT.053 fast-path: detects the format, parses
 * every row, skips Claude entirely. No token cap, no truncation.
 *
 * Why per-bank: each Dutch bank ships its own CSV layout. Rabobank's is
 * the most common one a personal user can grab from the web app, but it
 * uses Dutch column names ("Datum", "Bedrag", "Tegenrekening IBAN/BBAN",
 * "Naam tegenpartij", "Omschrijving-1/2/3"), comma-separated, with all
 * fields double-quoted.
 *
 * Sample header (one line, comma-separated):
 *   "IBAN/BBAN","Munt","BIC","Volgnr","Datum","Rentedatum","Bedrag",
 *   "Saldo na trn","Tegenrekening IBAN/BBAN","Naam tegenpartij",
 *   "Naam ultimate party","Initiating party","BIC tegenpartij","Code",
 *   "Batch ID","Transactiereferentie","Machtigingskenmerk",
 *   "Incassant ID","Betalingskenmerk","Omschrijving-1","Omschrijving-2",
 *   "Omschrijving-3","Reden retour","Oorspr bedrag","Oorspr munt","Koers"
 */

export interface ParsedTransaction {
  /** Negative for debits (outgoing), positive for credits (incoming). */
  amount: number;
  currency: string;
  booking_date: string | null;
  value_date: string | null;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  reference: string | null;
  transaction_id: string | null;
  description: string | null;
}

export interface ParsedStatement {
  account_iban: string | null;
  account_holder: string | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  currency: string;
  transactions: ParsedTransaction[];
}

/**
 * Detect whether the buffer looks like a Rabobank CSV export.
 *
 * Header signatures we match (any of these in the first ~1 KB):
 *   - "IBAN/BBAN","Munt", … "Volgnr"  (the strong signature)
 *   - "Tegenrekening IBAN/BBAN","Naam tegenpartij"
 *   - "Omschrijving-1"  (almost-unique to Rabobank)
 */
export function looksLikeRabobankCsv(buffer: Buffer): boolean {
  const head = buffer.toString("utf8", 0, Math.min(2048, buffer.length));
  if (!head.includes(",")) return false;
  const must = [
    /"IBAN\/BBAN"/i,
    /"Bedrag"/i,
    /"Datum"/i,
  ];
  const optional = [
    /"Tegenrekening IBAN\/BBAN"/i,
    /"Naam tegenpartij"/i,
    /"Omschrijving-1"/i,
  ];
  const mustHits = must.filter((re) => re.test(head)).length;
  const optHits = optional.filter((re) => re.test(head)).length;
  return mustHits === must.length && optHits >= 1;
}

/**
 * Convert "27-04-2025" / "2025-04-27" / "27/04/2025" → "YYYY-MM-DD".
 * Returns null when the input doesn't parse.
 */
function parseDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // ISO already
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(trimmed);
  if (dmy) {
    const dd = dmy[1].padStart(2, "0");
    const mm = dmy[2].padStart(2, "0");
    return `${dmy[3]}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Rabobank amounts are formatted like "+1.234,56" or "-7,50" — comma
 * as decimal separator, dot as thousand separator, optional sign.
 * Returns NaN when the input can't be coerced.
 */
function parseAmount(s: string | undefined | null): number {
  if (!s) return NaN;
  const trimmed = String(s).trim();
  if (!trimmed) return NaN;
  // Strip thousand-separator dots, normalise decimal comma → dot
  const normalised = trimmed
    .replace(/\./g, "")
    .replace(/,/g, ".");
  const n = Number(normalised);
  return Number.isFinite(n) ? n : NaN;
}

/** Find a column header by case-insensitive substring match. */
function findCol(headers: string[], needle: string): string | undefined {
  const lower = needle.toLowerCase();
  return headers.find((h) => h.toLowerCase().includes(lower));
}

/**
 * Detect whether the buffer looks like a Rabobank CREDIT CARD CSV export
 * (separate format from the checking-account one above — different columns).
 *
 * Header signature, no quotes, comma-separated:
 *   Tegenpartij IBAN,Valuta,Creditcardnummer,Productnaam,Kaartregel1,
 *   Kaartregel2,Transactiereferentie,Datum,Bedrag,Omschrijving,
 *   Instructiebedrag,Instructievaluta,Wisselkoers
 *
 * Matching on "Creditcardnummer" alone is enough — it's unique to this
 * export — plus the usual Datum/Bedrag/Omschrijving trio that proves it's
 * the transaction shape and not just metadata.
 */
export function looksLikeRabobankCreditCardCsv(buffer: Buffer): boolean {
  const head = buffer.toString("utf8", 0, Math.min(2048, buffer.length));
  if (!head.includes(",")) return false;
  return (
    /Creditcardnummer/i.test(head) &&
    /Transactiereferentie/i.test(head) &&
    /\bDatum\b/i.test(head) &&
    /\bBedrag\b/i.test(head) &&
    /Omschrijving/i.test(head)
  );
}

/**
 * Deterministic parser for the Rabobank credit-card CSV export.
 *
 * Notes vs the checking-account parser:
 *   - There is no "account IBAN" in the bank-statement sense; the card
 *     itself is the account. We expose `card_last4` (the Creditcardnummer
 *     column) and `card_product` (Productnaam, e.g. "Rabo GoldCard Visa")
 *     via the parsed statement's `account_iban` slot is left null and the
 *     card data is returned alongside so the caller can put it into
 *     extracted_fields.
 *   - Each transaction has one Datum, no separate value date — we mirror
 *     it into both booking_date and value_date so downstream code that
 *     prefers value_date still gets something.
 *   - The merchant lives in Omschrijving; we use it as the description AND
 *     as a synthetic counterparty_name so the reconciliation panel has
 *     something to display.
 */
export interface ParsedCreditCardStatement extends ParsedStatement {
  card_last4: string | null;
  card_product: string | null;
}

export function parseRabobankCreditCardCsv(
  text: string
): ParsedCreditCardStatement {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semiCount > commaCount ? ";" : ",";

  const rows = csvParse(text, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Record<string, string>[];

  if (rows.length === 0) {
    return {
      account_iban: null,
      account_holder: null,
      period_start: null,
      period_end: null,
      opening_balance: null,
      closing_balance: null,
      currency: "EUR",
      transactions: [],
      card_last4: null,
      card_product: null,
    };
  }

  const headers = Object.keys(rows[0]);
  const colSettleIban = findCol(headers, "Tegenpartij IBAN");
  const colCurrency = findCol(headers, "Valuta");
  const colCardNum = findCol(headers, "Creditcardnummer");
  const colProduct = findCol(headers, "Productnaam");
  const colCardHolder = findCol(headers, "Kaartregel1");
  const colTransRef = findCol(headers, "Transactiereferentie");
  const colDate = findCol(headers, "Datum");
  const colAmount = findCol(headers, "Bedrag");
  const colDesc = findCol(headers, "Omschrijving");
  // Foreign-currency original amount, currency, exchange rate — captured
  // into the description if present so the user still sees "USD 2.99".
  const colOrigAmt = findCol(headers, "Instructiebedrag");
  const colOrigCur = findCol(headers, "Instructievaluta");

  // Card-level metadata (same across all rows of one export).
  const cardLast4 = colCardNum ? (rows[0][colCardNum] || "").trim() || null : null;
  const cardProduct = colProduct ? (rows[0][colProduct] || "").trim() || null : null;
  const cardHolder = colCardHolder ? (rows[0][colCardHolder] || "").trim() || null : null;
  const settleIban = colSettleIban
    ? (rows[0][colSettleIban] || "").replace(/\s+/g, "").toUpperCase() || null
    : null;
  const currency = (colCurrency ? rows[0][colCurrency] : null) || "EUR";

  // Pull the merchant city/country off the end of an Omschrijving like
  // "EV CHARGE SESSION  ROTTERDAM  NLD  Token: 4xxxx5670". Trim out the
  // token marker — that's the masked card number, not the merchant name.
  function cleanMerchant(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const tokenless = raw.replace(/\bToken:\s*\S+/i, "").trim();
    return tokenless.replace(/\s{2,}/g, " ") || null;
  }

  const transactions: ParsedTransaction[] = [];
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const row of rows) {
    const amt = colAmount ? parseAmount(row[colAmount]) : NaN;
    if (!Number.isFinite(amt)) continue;
    const date = colDate ? parseDate(row[colDate]) : null;
    const desc = colDesc ? (row[colDesc] || "").trim() : "";
    const origAmt = colOrigAmt ? (row[colOrigAmt] || "").trim() : "";
    const origCur = colOrigCur ? (row[colOrigCur] || "").trim() : "";
    const transRef = colTransRef ? (row[colTransRef] || "").trim() : "";
    const merchant = cleanMerchant(desc);
    const fx = origAmt && origCur && origCur !== currency
      ? ` (${origCur} ${origAmt})`
      : "";
    const description = desc ? `${desc}${fx}` : null;

    transactions.push({
      amount: amt,
      currency,
      booking_date: date,
      value_date: date,
      counterparty_name: merchant,
      counterparty_iban: null,
      reference: transRef || merchant,
      transaction_id: transRef || null,
      description,
    });

    if (date) {
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }
  }

  return {
    // No statement IBAN — credit cards don't have one. settleIban (the
    // bank account that pays the card) goes into the doc's extracted
    // fields as account_iban so reconciliation can still match by it.
    account_iban: settleIban,
    account_holder: cardHolder,
    period_start: minDate,
    period_end: maxDate,
    opening_balance: null,
    closing_balance: null,
    currency,
    transactions,
    card_last4: cardLast4,
    card_product: cardProduct,
  };
}

export function parseRabobankCsv(text: string): ParsedStatement {
  // Auto-detect separator: Rabobank uses comma, but some exports semicolon.
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semiCount > commaCount ? ";" : ",";

  // Parse with the csv-parse synchronous API. Auto-detects quoting,
  // handles embedded delimiters via the quoting protocol.
  const rows = csvParse(text, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
  }) as Record<string, string>[];

  if (rows.length === 0) {
    return {
      account_iban: null,
      account_holder: null,
      period_start: null,
      period_end: null,
      opening_balance: null,
      closing_balance: null,
      currency: "EUR",
      transactions: [],
    };
  }

  const headers = Object.keys(rows[0]);
  const colIban = findCol(headers, "IBAN/BBAN") || findCol(headers, "IBAN");
  const colCurrency = findCol(headers, "Munt");
  const colDate = findCol(headers, "Datum");
  const colValueDate = findCol(headers, "Rentedatum");
  const colAmount = findCol(headers, "Bedrag");
  const colCounterIban =
    findCol(headers, "Tegenrekening IBAN") ||
    findCol(headers, "Tegenrekening");
  const colCounterName = findCol(headers, "Naam tegenpartij");
  const colCode = findCol(headers, "Code");
  const colPayRef = findCol(headers, "Betalingskenmerk");
  const colTransRef = findCol(headers, "Transactiereferentie");
  // Up to three concatenated description columns
  const descCols = headers.filter((h) => /^Omschrijving/i.test(h));

  // The account IBAN of THE STATEMENT itself is the same across rows.
  // We pull it from row 0 since exports are scoped per account.
  const ownIban = colIban ? (rows[0][colIban] || "").trim() : null;
  const ownCurrency =
    (colCurrency ? rows[0][colCurrency] : null) || "EUR";

  const transactions: ParsedTransaction[] = [];
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const row of rows) {
    const amt = colAmount ? parseAmount(row[colAmount]) : NaN;
    if (!Number.isFinite(amt)) continue;
    const bookingDate = colDate ? parseDate(row[colDate]) : null;
    const valueDate = colValueDate ? parseDate(row[colValueDate]) : null;
    const counterIban = colCounterIban
      ? (row[colCounterIban] || "").replace(/\s+/g, "").toUpperCase() || null
      : null;
    const counterName = colCounterName
      ? (row[colCounterName] || "").trim() || null
      : null;
    const descBits = descCols
      .map((c) => (row[c] || "").trim())
      .filter(Boolean);
    const description = descBits.length ? descBits.join(" ") : null;
    const payRef = colPayRef ? (row[colPayRef] || "").trim() : "";
    const transRef = colTransRef ? (row[colTransRef] || "").trim() : "";
    // Prefer the payment reference (Betalingskenmerk) — most often the
    // structured payment ref — and fall back to description.
    const reference = payRef || description || null;
    const code = colCode ? (row[colCode] || "").trim() : "";

    transactions.push({
      amount: amt,
      currency: ownCurrency,
      booking_date: bookingDate,
      value_date: valueDate,
      counterparty_name: counterName,
      counterparty_iban: counterIban,
      reference,
      transaction_id: transRef || null,
      description: description || (code ? `${code} payment` : null),
    });

    // Track period
    if (bookingDate) {
      if (!minDate || bookingDate < minDate) minDate = bookingDate;
      if (!maxDate || bookingDate > maxDate) maxDate = bookingDate;
    }
  }

  return {
    account_iban: ownIban,
    account_holder: null,
    period_start: minDate,
    period_end: maxDate,
    opening_balance: null,
    closing_balance: null,
    currency: ownCurrency,
    transactions,
  };
}
