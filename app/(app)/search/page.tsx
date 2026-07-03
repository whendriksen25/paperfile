"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { DocumentCard } from "@/components/inbox/document-card";
import type { DocumentRow } from "@/types/document";
import { Spinner } from "@/components/ui/spinner";
import { Search as SearchIcon, CalendarClock } from "lucide-react";

export default function SearchPage() {
  const [q, setQ] = useState("");
  // Scan-date range — filters on created_at (when the doc was scanned),
  // not the date printed on the document. Works with or without text.
  const [scannedFrom, setScannedFrom] = useState("");
  const [scannedTo, setScannedTo] = useState("");
  const [results, setResults] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      const hasText = !!q.trim();
      const hasDates = !!scannedFrom || !!scannedTo;
      if (!hasText && !hasDates) {
        setResults([]);
        return;
      }
      setLoading(true);
      const params = new URLSearchParams();
      if (hasText) params.set("q", q);
      if (scannedFrom) params.set("scanned_from", scannedFrom);
      if (scannedTo) params.set("scanned_to", scannedTo);
      params.set("limit", "50");
      const res = await fetch(`/api/documents?${params.toString()}`);
      const json = await res.json();
      setResults(json.data || []);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, scannedFrom, scannedTo]);

  const active = !!q.trim() || !!scannedFrom || !!scannedTo;

  return (
    <div className="max-w-3xl mx-auto px-5 py-6 md:py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold mb-4">Search</h1>
        <div className="relative">
          <SearchIcon className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            placeholder="Search titles, senders, OCR text..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <CalendarClock className="h-3.5 w-3.5" />
            Scanned between
          </span>
          <Input
            type="date"
            value={scannedFrom}
            onChange={(e) => setScannedFrom(e.target.value)}
            className="w-auto text-xs"
            aria-label="Scanned from"
          />
          <span>and</span>
          <Input
            type="date"
            value={scannedTo}
            onChange={(e) => setScannedTo(e.target.value)}
            className="w-auto text-xs"
            aria-label="Scanned to"
          />
          {(scannedFrom || scannedTo) && (
            <button
              type="button"
              onClick={() => {
                setScannedFrom("");
                setScannedTo("");
              }}
              className="underline hover:text-foreground"
            >
              Clear dates
            </button>
          )}
        </div>
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Searching…
        </div>
      )}

      {!loading && active && results.length === 0 && (
        <div className="surface p-6 text-center text-sm text-muted-foreground">
          No matches{q.trim() ? ` for "${q}"` : ""}
          {scannedFrom || scannedTo ? " in that scan-date range" : ""}.
        </div>
      )}

      <div className="space-y-3 mt-4">
        {results.map((doc) => (
          <DocumentCard key={doc.id} doc={doc} />
        ))}
      </div>
    </div>
  );
}
