"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, Loader2 } from "lucide-react";

/**
 * Small "Run sanity check" button + last-run indicator.
 *
 * On mount: fetches GET /api/maintenance/sanity-check to find when the
 * last automated maintenance run happened (uses the most-recent
 * maintenance_log row). On click: triggers POST and shows a brief result
 * summary inline.
 */
export function SanityCheckButton() {
  const router = useRouter();
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    repointed: number;
    flagged: number;
    reclassified: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/maintenance/sanity-check?limit=1")
      .then((r) => r.json())
      .then((j) => {
        if (j.last_run) setLastRun(j.last_run);
      })
      .catch(() => {});
  }, []);

  function relative(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return "just now";
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/maintenance/sanity-check", {
        method: "POST",
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || `Failed (HTTP ${res.status})`);
        setRunning(false);
        return;
      }
      const r = json.result;
      setResult({
        repointed: r.orphans?.repointed ?? 0,
        flagged: r.orphans?.flagged_for_review ?? 0,
        reclassified: r.reclassifications?.applied ?? 0,
      });
      setLastRun(new Date().toISOString());
      // Refresh the inbox so any reclassified/repointed docs appear
      // in their new locations.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-2xl border border-border bg-background hover:bg-muted disabled:opacity-50 font-semibold"
        title="Run the self-healing maintenance pass: detect orphans, apply sender-history reclassification."
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 text-brand-purple" />
        )}
        {running ? "Running…" : "Run sanity check"}
      </button>
      {lastRun && !result && (
        <span className="text-muted-foreground text-[11px]">
          last activity {relative(lastRun)}
        </span>
      )}
      {result && (
        <span className="text-[11px]">
          <span className="text-brand-green font-semibold">
            {result.reclassified} reclassified
          </span>
          {" · "}
          <span className="text-brand-green font-semibold">
            {result.repointed} repointed
          </span>
          {result.flagged > 0 && (
            <>
              {" · "}
              <span className="text-amber-600 font-semibold">
                {result.flagged} need review
              </span>
            </>
          )}
        </span>
      )}
      {error && (
        <span className="text-[11px] text-destructive">{error}</span>
      )}
    </div>
  );
}
