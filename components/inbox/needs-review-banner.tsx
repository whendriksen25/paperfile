"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight } from "lucide-react";

/**
 * Top-of-inbox banner that appears whenever there are documents the AI
 * couldn't confidently match to a profile (or that the user explicitly
 * flagged for review). Always visible regardless of active profile filter,
 * so iPhone scans that came in unassigned don't get hidden behind a Father /
 * LLC / Wife filter.
 *
 * Click-through goes to /inbox?needs_review=1 which the inbox page treats as
 * "show ONLY unassigned-or-flagged docs" so the user can triage in one pass.
 */
export function NeedsReviewBanner({ intervalMs = 5000 }: { intervalMs?: number }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/documents/needs-review-count", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        setCount(typeof json.count === "number" ? json.count : 0);
      } catch {
        /* silent */
      }
    }
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  if (!count || count <= 0) return null;

  return (
    <Link
      href="/inbox?needs_review=1"
      className="surface mb-5 px-4 py-3 flex items-center gap-3 border-amber-200 bg-amber-50 hover:bg-amber-100 transition-colors group"
    >
      <div className="h-9 w-9 rounded-full bg-amber-200/70 flex items-center justify-center shrink-0">
        <AlertCircle className="h-4 w-4 text-amber-800" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-amber-900">
          {count} {count === 1 ? "document needs" : "documents need"} review
        </p>
        <p className="text-xs text-amber-800/80 mt-0.5">
          The AI couldn&apos;t confidently pick a profile. Click to triage.
        </p>
      </div>
      <ArrowRight className="h-4 w-4 text-amber-800 group-hover:translate-x-0.5 transition-transform" />
    </Link>
  );
}
