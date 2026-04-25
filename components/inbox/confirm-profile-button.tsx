"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Inline "Confirm" button for the inbox card. Shown when the AI's profile
 * assignment is provisional (needs_review=true). One click clears the
 * needs_review flag — no file move, no profile change. The user's saying
 * "yes, this is the right profile, move on".
 *
 * Uses stopPropagation/preventDefault so clicking it doesn't navigate to
 * the document detail page (the card's Link wraps everything).
 */
export function ConfirmProfileButton({
  documentId,
  profileName,
}: {
  documentId: string;
  profileName: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function confirm(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy || done) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/documents/${documentId}/confirm-profile`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDone(true);
      router.refresh();
    } catch {
      // Silent — the user can always use the RefileWidget on the detail
      // page if the inline confirm fails.
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={confirm}
      disabled={busy || done}
      title={
        profileName
          ? `Confirm: this document belongs to ${profileName}`
          : "Confirm AI suggestion"
      }
      className="pill bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors cursor-pointer"
    >
      {busy ? (
        <Spinner className="h-3 w-3" />
      ) : done ? (
        <Check className="h-3 w-3" />
      ) : (
        <>
          <Check className="h-3 w-3" />
          Confirm{profileName ? ` ${profileName}` : ""}
        </>
      )}
    </button>
  );
}
