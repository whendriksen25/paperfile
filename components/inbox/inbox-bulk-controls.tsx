"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare, Square, Loader2, X } from "lucide-react";
import { useSelectMode } from "./select-mode-context";
import type { ProfileRow } from "@/types/document";

/**
 * Toolbar widget for inbox multi-select.
 *
 *  - Idle state: a "Select" button toggles select mode on.
 *  - Select mode: shows "Cancel" + "N selected" + a target-profile picker
 *    + "Move N docs" button. All sits inline in the inbox toolbar, to
 *    the LEFT of the existing ProfileSelector (per UX preference).
 *
 * Posts to /api/documents/bulk-reassign and router.refresh() on success.
 */
export function InboxBulkControls({
  profiles,
}: {
  profiles: ProfileRow[];
}) {
  const router = useRouter();
  const { selectMode, setSelectMode, selected, clear } = useSelectMode();
  const [targetProfileId, setTargetProfileId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move() {
    if (!targetProfileId || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/documents/bulk-reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_ids: Array.from(selected),
          to_profile_id: targetProfileId,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`);
        return;
      }
      // Report quickly, then refresh the inbox.
      const moved = json.moved ?? 0;
      const failed = json.failed ?? 0;
      const skipped = json.skipped ?? 0;
      if (failed > 0)
        setError(
          `Moved ${moved}, skipped ${skipped}, ${failed} failed — check the console.`
        );
      clear();
      setSelectMode(false);
      setTargetProfileId(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  if (!selectMode) {
    return (
      <button
        type="button"
        onClick={() => setSelectMode(true)}
        title="Enter select mode to move documents to a different profile"
        className="text-xs font-bold inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted"
      >
        <Square className="h-3.5 w-3.5" />
        Select
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setSelectMode(false)}
        className="text-xs font-bold inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
        title="Exit select mode"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <span className="text-xs font-bold inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-brand-purple/10 text-brand-purple">
        <CheckSquare className="h-3.5 w-3.5" />
        {selected.size} selected
      </span>
      {selected.size > 0 && (
        <>
          <select
            value={targetProfileId ?? ""}
            onChange={(e) =>
              setTargetProfileId(
                e.target.value ? Number(e.target.value) : null
              )
            }
            disabled={busy}
            className="text-xs font-semibold border border-border rounded-lg px-2 py-1.5 bg-white"
          >
            <option value="">Move to profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={move}
            disabled={busy || !targetProfileId}
            className="text-xs font-bold inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-purple text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>Move {selected.size} doc{selected.size === 1 ? "" : "s"}</>
            )}
          </button>
        </>
      )}
      {error && (
        <span className="text-[11px] font-semibold text-destructive max-w-xs truncate">
          {error}
        </span>
      )}
    </div>
  );
}
