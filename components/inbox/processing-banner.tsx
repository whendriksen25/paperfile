"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/spinner";

/**
 * Top-of-inbox banner + auto-refresh:
 *  - When there's at least one doc in "pending" / "processing", the banner shows
 *    an animated progress strip + "AI is working on N document(s)".
 *  - Polls the API every `intervalMs` and calls router.refresh() so the server
 *    component (inbox/page.tsx) re-fetches and the card states update in place.
 *  - When no docs are processing, the component renders nothing.
 */
export function ProcessingBanner({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [inProgress, setInProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch("/api/documents/processing-count", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const count = typeof json.count === "number" ? json.count : 0;
        setInProgress((prev) => {
          // If we moved from >0 to 0 (or vice versa), or the number changed,
          // trigger a server refetch so the cards update their final state.
          if (prev !== count) {
            router.refresh();
          }
          return count;
        });
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
          </p>
        </div>
      </div>
    </div>
  );
}
