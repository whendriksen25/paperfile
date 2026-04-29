"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

/**
 * Live search input for the inbox.
 *
 * Controlled local state for instant feedback while typing; URL update is
 * debounced (250ms) to avoid one navigation per keystroke. Pressing Enter
 * commits immediately. The X button clears the query.
 *
 * Reads/writes the `q` query param. The inbox page applies it to its initial
 * query and InboxInfiniteList forwards it to /api/documents for paginated
 * loads, so the same search filter applies consistently as the user scrolls.
 */
export function SearchInput() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initialQ = params.get("q") || "";
  const [value, setValue] = useState(initialQ);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state when the URL changes externally (e.g. via clear button
  // on a different render path or back-button navigation).
  useEffect(() => {
    setValue(params.get("q") || "");
  }, [params]);

  function commit(q: string) {
    const next = new URLSearchParams(params.toString());
    if (q.trim()) {
      next.set("q", q.trim());
    } else {
      next.delete("q");
    }
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function onChange(v: string) {
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commit(v), 250);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      commit(value);
    }
    if (e.key === "Escape") {
      setValue("");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      commit("");
    }
  }

  return (
    <div className="relative">
      <Search className="h-4 w-4 text-muted-foreground absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search documents…"
        className="input-pill pl-11 pr-10"
        aria-label="Search documents"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setValue("");
            if (debounceRef.current) clearTimeout(debounceRef.current);
            commit("");
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
