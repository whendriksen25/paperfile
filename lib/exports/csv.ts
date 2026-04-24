/**
 * Tiny CSV builder. Quotes any cell containing comma/quote/newline; doubles
 * embedded quotes per RFC 4180.
 */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const row of rows) lines.push(row.map(esc).join(","));
  // BOM so Excel + Trello import open it as UTF-8
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}
