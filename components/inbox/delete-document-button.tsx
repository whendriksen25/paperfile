"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

/**
 * Soft-deletes a document from the detail / preview pane.
 *
 * Two-step confirm (no browser popup): first click flips into an inline
 * "Remove from library?" confirm, second click actually deletes. Calls
 * DELETE /api/documents/:id which sets status='deleted' — the file itself
 * stays untouched in Dropbox, so nothing is irreversibly lost.
 */
export function DeleteDocumentButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error || `Delete failed (HTTP ${res.status})`);
      }
      router.push("/inbox");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="btn-secondary text-xs !py-2 !text-red-600 !border-red-200 hover:!bg-red-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
        {error && <span className="text-[11px] text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground text-right leading-tight">
        Remove from library?
        <br />
        The file stays in Dropbox.
      </span>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="btn-secondary text-xs !py-2 !bg-red-600 !text-white !border-red-600 hover:!bg-red-700 disabled:opacity-60"
      >
        {busy ? "Deleting…" : "Yes, delete"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="btn-secondary text-xs !py-2"
      >
        Cancel
      </button>
    </div>
  );
}
