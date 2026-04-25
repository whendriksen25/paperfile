"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentCard } from "./document-card";
import { Spinner } from "@/components/ui/spinner";
import type { DocumentRow, ProfileRow } from "@/types/document";

/**
 * Infinite-scroll list for the inbox.
 *
 *  - Server pre-renders the initial page (props.initialDocs) so the user
 *    sees content instantly with no client roundtrip.
 *  - An IntersectionObserver on the bottom sentinel fetches the next page
 *    when it scrolls into view. Page size matches the server's first page.
 *  - Filters that the server applied are passed through (type, profile_id,
 *    batch) so subsequent pages obey the same WHERE clause.
 *  - Stops cleanly when the API returns next_cursor=null.
 */
export function InboxInfiniteList({
  initialDocs,
  initialNextCursor,
  pageSize,
  filters,
  profilesById,
}: {
  initialDocs: DocumentRow[];
  initialNextCursor: string | null;
  pageSize: number;
  filters: { type?: string | null; profile_id?: string | null; batch?: string | null };
  /** Map keyed by profile id; serialised as a plain object across the boundary. */
  profilesById: Record<number, ProfileRow>;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>(initialDocs);
  const [cursor, setCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(initialNextCursor === null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Tracks the in-flight cursor so React strict-mode / quick re-observes
  // don't double-fire the same page.
  const fetchingFor = useRef<string | null>(null);

  const loadMore = useCallback(async () => {
    if (loading || done || !cursor) return;
    if (fetchingFor.current === cursor) return;
    fetchingFor.current = cursor;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("after", cursor);
      params.set("limit", String(pageSize));
      if (filters.type) params.set("type", filters.type);
      if (filters.profile_id) params.set("profile_id", filters.profile_id);
      if (filters.batch) params.set("batch", filters.batch);

      const res = await fetch(`/api/documents?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const next = (json.data || []) as DocumentRow[];
      setDocs((prev) => [...prev, ...next]);
      const nc = (json.next_cursor as string | null) || null;
      setCursor(nc);
      if (!nc) setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      fetchingFor.current = null;
      setLoading(false);
    }
  }, [loading, done, cursor, pageSize, filters]);

  // Watch the sentinel; trigger loadMore as soon as it scrolls into view.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || done) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      // Pre-fetch the next page slightly before the user actually hits the
      // bottom — feels seamless.
      { rootMargin: "300px 0px" }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore, done]);

  return (
    <div className="grid gap-3">
      {docs.map((doc) => (
        <DocumentCard
          key={doc.id}
          doc={doc}
          profile={
            doc.primary_profile_id
              ? profilesById[doc.primary_profile_id] || null
              : null
          }
        />
      ))}

      {/* Sentinel + status footer */}
      <div ref={sentinelRef} />
      {loading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-4">
          <Spinner className="h-3.5 w-3.5" />
          Loading more documents…
        </div>
      )}
      {error && (
        <div className="text-center text-xs text-destructive font-semibold py-3">
          {error}{" "}
          <button onClick={loadMore} className="underline">
            Retry
          </button>
        </div>
      )}
      {done && docs.length > pageSize && (
        <div className="text-center text-[11px] text-muted-foreground py-4">
          End of list · {docs.length} documents
        </div>
      )}
    </div>
  );
}
