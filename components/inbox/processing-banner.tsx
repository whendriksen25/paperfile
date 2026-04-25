"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";

interface StuckDoc {
  id: string;
  status: string;
  stuck_seconds: number;
}

/**
 * Top-of-inbox banner + auto-refresh + safety net for fire-and-forget loss:
 *
 *  1. When any doc is mid-processing, shows an animated progress strip +
 *     "AI is working on N document(s)" and polls every `intervalMs`.
 *  2. router.refresh() is fired whenever the count changes, so the inbox
 *     server-renders with the latest card state.
 *  3. SAFETY NET: when the poll reports `stuck` docs (analyze never fired or
 *     hung mid-stream), the banner auto-POSTs to /api/analyze/[id] for each.
 *     A client-side ref tracks recently-retried IDs so we don't double-fire
 *     while a retry is in flight.
 *
 * Renders nothing when there's no active work AND no stuck docs.
 */
export function ProcessingBanner({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [inProgress, setInProgress] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(0);
  // Tracks doc IDs we've fired analyze for, with the timestamp of the last
  // attempt. Prevents back-to-back retries — wait at least 60s before retrying
  // the same doc again so we don't pile up duplicate Claude calls.
  const recentlyRetried = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function retry(stuck: StuckDoc[]) {
      const now = Date.now();
      const toFire = stuck.filter((d) => {
        const last = recentlyRetried.current.get(d.id) || 0;
        return now - last > 60_000;
      });
      if (toFire.length === 0) return;

      setRetrying((n) => n + toFire.length);
      for (const d of toFire) recentlyRetried.current.set(d.id, now);

      // Fire all retries in parallel — analyze's first SQL is to set status
      // to 'processing', so the next poll will see the change.
      await Promise.all(
        toFire.map((d) =>
          fetch(`/api/analyze/${d.id}`, { method: "POST" }).catch(() => {})
        )
      );
      if (!cancelled) setRetrying((n) => Math.max(0, n - toFire.length));
    }

    async function tick() {
      try {
        const res = await fetch("/api/documents/processing-count", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;

        const count = typeof json.count === "number" ? json.count : 0;
        const stuck: StuckDoc[] = Array.isArray(json.stuck) ? json.stuck : [];

        setInProgress((prev) => {
          if (prev !== count) router.refresh();
          return count;
        });

        if (stuck.length > 0) retry(stuck);
      } catch {
        // Silent — polling should never surface errors.
      }
    }

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [router, intervalMs]);

  if (!inProgress || inProgress <= 0) return null;

  return (
    <div className="surface p-4 mb-5 border-brand-purple/30 bg-brand-purple/5 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5 overflow-hidden">
        <div className="h-full w-1/3 bg-brand-purple animate-progress-slide" />
      </div>
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-full bg-brand-purple/15 flex items-center justify-center">
          <Spinner className="h-4 w-4 text-brand-purple" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">
            AI is working on {inProgress}{" "}
            {inProgress === 1 ? "document" : "documents"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Reading, classifying, extracting line items, and filing them away.
            This usually takes 10–30 seconds per page.
            {retrying > 0 && (
              <>
                {" "}
                <span className="text-brand-purple font-semibold">
                  Re-kicking {retrying} stalled{" "}
                  {retrying === 1 ? "doc" : "docs"}…
                </span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
