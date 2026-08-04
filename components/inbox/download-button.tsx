"use client";

import { useState } from "react";
import { Download } from "lucide-react";

/**
 * Downloads the document's file, letting the user PICK where to save it.
 *
 * Uses the File System Access API (Chrome/Edge/Opera): a native "Save as"
 * dialog where the user chooses folder + filename. Browsers without it
 * (Firefox/Safari) fall back to a regular download into the browser's
 * default Downloads folder.
 */

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

export function DownloadButton({
  documentId,
  filename,
}: {
  documentId: string;
  filename: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/documents/${documentId}/preview?download=1`
      );
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();

      const w = window as SaveFilePickerWindow;
      if (typeof w.showSaveFilePicker === "function") {
        try {
          const handle = await w.showSaveFilePicker({
            suggestedName: filename,
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return; // saved where the user chose
        } catch (e) {
          // User cancelled the picker — not an error, just stop quietly.
          if ((e as { name?: string })?.name === "AbortError") return;
          throw e;
        }
      }

      // Fallback: classic download to the browser's Downloads folder.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="btn-secondary text-xs !py-2 shrink-0"
      >
        <Download className="h-3.5 w-3.5" />
        {busy ? "Downloading…" : "Download"}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
