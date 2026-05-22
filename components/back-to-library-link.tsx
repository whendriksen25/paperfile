"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

/**
 * "Back to library" link on the document detail page.
 *
 * Prefers a history-back navigation over a fresh push to /inbox. When the
 * user reached this document by clicking a card in the inbox, going back
 * restores the inbox EXACTLY as they left it — same scroll position, the
 * infinite-scroll items already loaded, and any active search/profile/type
 * filters — because Next's App Router keeps the previous route in its client
 * cache and restores its scroll on a history pop.
 *
 * Falls back to a normal /inbox navigation when there's no in-app history to
 * go back to (e.g. the document was opened from a direct deep link or a fresh
 * tab), so the link always does something sensible.
 */
export function BackToLibraryLink() {
  const router = useRouter();

  return (
    <Link
      href="/inbox"
      onClick={(e) => {
        // Only intercept plain left-clicks — let cmd/ctrl/middle-click open a
        // new tab at /inbox as the user expects.
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        if (typeof window !== "undefined" && window.history.length > 1) {
          e.preventDefault();
          router.back();
        }
      }}
      className="text-xs font-semibold text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to library
    </Link>
  );
}
