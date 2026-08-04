"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ScanText } from "lucide-react";

/**
 * Kicks off (or retries) the chunked full-text transcription for a PDF.
 * The chunks self-chain server-side; this button only fires chunk 0 and
 * then lets the user refresh to watch progress fill in.
 */
export function TranscribeButton({
  documentId,
  retry,
}: {
  documentId: string;
  retry?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "started" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch(`/api/transcribe/${documentId}?chunk=0`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error || `Failed (HTTP ${res.status})`);
      }
      setState("started");
      // Give the first chunk a moment, then refresh so the progress
      // note appears.
      setTimeout(() => router.refresh(), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
      setState("error");
    }
  }

  if (state === "started") {
    return (
      <span className="text-[11px] text-muted-foreground">
        Transcription running — it fills in over a few minutes. Refresh to
        see progress.
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={state === "busy"}
        className="btn-secondary text-xs !py-1.5"
      >
        <ScanText className="h-3.5 w-3.5" />
        {state === "busy"
          ? "Starting…"
          : retry
            ? "Retry transcription"
            : "Transcribe full text"}
      </button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
