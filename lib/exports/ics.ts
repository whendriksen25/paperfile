/**
 * Minimal RFC 5545 .ics builder for action items so the user can subscribe
 * from Apple Calendar / Google Calendar / Outlook.
 *
 * Each action becomes an all-day VEVENT on its due_date (or today if none).
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  date: string; // YYYY-MM-DD
}

function escape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function fmtDate(iso: string): string {
  return iso.replace(/-/g, "");
}

function fmtDateTimeNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

export function buildIcs(
  events: IcsEvent[],
  calendarName = "Paperfile Actions"
): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Paperfile//Actions//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escape(calendarName)}`,
    `X-WR-CALDESC:${escape("Action items extracted from Paperfile documents")}`,
  ];
  const dtstamp = fmtDateTimeNow();
  for (const ev of events) {
    const d = fmtDate(ev.date);
    const dPlus1 = fmtDate(addDays(ev.date, 1));
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}@paperfile`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${d}`);
    lines.push(`DTEND;VALUE=DATE:${dPlus1}`);
    lines.push(`SUMMARY:${escape(ev.summary)}`);
    if (ev.description)
      lines.push(`DESCRIPTION:${escape(ev.description)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // CRLF per spec
  return lines.join("\r\n") + "\r\n";
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
