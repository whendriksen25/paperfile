"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { DocumentCard } from "@/components/inbox/document-card";
import type { DocumentRow } from "@/types/document";
import { Spinner } from "@/components/ui/spinner";
import { Search as SearchIcon } from "lucide-react";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) {
        setResults([]);
        return;
      }
      setLoading(true);
      const res = await fetch(`/api/documents?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      setResults(json.data || []);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

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
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Searching…
        </div>
      )}

      {!loading && q && results.length === 0 && (
        <div className="surface p-6 text-center text-sm text-muted-foreground">
          No matches for "{q}".
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
