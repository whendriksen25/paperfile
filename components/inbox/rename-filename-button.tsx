"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X, Loader2 } from "lucide-react";

/**
 * Inline filename editor — small pencil next to the displayed filename.
 * Clicking the pencil swaps the label for an input. Save (Enter or check)
 * POSTs to /api/documents/[id]/rename, which moves the file in storage
 * and updates the DB. Cancel (Esc or X) reverts.
 *
 * The current filename is shown without its extension; the server keeps
 * the original extension automatically.
 */
export function RenameFilenameButton({
  documentId,
  currentFilename,
}: {
  documentId: string;
  currentFilename: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Strip extension for display in the input — server reapplies it.
  const stripExt = (name: string) => name.replace(/\.[a-zA-Z0-9]{1,8}$/, "");

  function startEdit() {
    setValue(stripExt(currentFilename));
    setError(null);
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setError(null);
  }

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Pick a name");
      return;
    }
    if (trimmed === stripExt(currentFilename)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: trimmed }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error || `Failed (HTTP ${res.status})`);
        setSaving(false);
        return;
      }
      setEditing(false);
      setSaving(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={startEdit}
        className="group inline-flex items-center gap-1.5 text-left"
        title="Rename file"
      >
        <span className="font-semibold">{currentFilename}</span>
        <Pencil className="h-3 w-3 opacity-50 group-hover:opacity-100 transition-opacity" />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          disabled={saving}
          className="text-xs font-semibold bg-background border border-border rounded px-2 py-1 min-w-0 flex-1 max-w-[280px]"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="text-brand-purple hover:opacity-80 disabled:opacity-50"
          title="Save"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
