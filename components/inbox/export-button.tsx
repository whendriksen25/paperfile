"use client";

import { useState } from "react";
import { Download, Check } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

interface ExportToDropboxButtonProps {
  type?: string | null;
  profileId?: number | null;
  batch?: string | null;
}

export function ExportToDropboxButton({
  type,
  profileId,
  batch,
}: ExportToDropboxButtonProps) {
  const [state, setState] = useState<"idle" | "exporting" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<{ path: string; count: number; shareLink: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportNow() {
    setState("exporting");
    setError(null);
    try {
      const res = await fetch("/api/exports/dropbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: type || undefined,
          profile_id: profileId || undefined,
          batch: batch || undefined,
          label: type || batch || (profileId ? `profile-${profileId}` : "all"),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Export failed");
      setResult(json);
      setState("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Export failed");
      setState("error");
    }
  }

  if (state === "done" && result) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="pill bg-brand-green/10 text-brand-green">
          <Check className="h-3 w-3" />
          Exported {result.count} doc{result.count === 1 ? "" : "s"}
        </span>
        {result.shareLink && (
          <a
            href={result.shareLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-purple font-bold underline"
          >
            Open CSV
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={exportNow}
        disabled={state === "exporting"}
        className="btn-secondary text-xs"
      >
        {state === "exporting" ? (
          <Spinner />
        ) : (
          <>
            <Download className="h-3.5 w-3.5" /> Export to Dropbox
          </>
        )}
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
