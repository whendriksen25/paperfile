"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shape of the JSON returned by GET /api/analyze-job/[jobId]. Kept in
 * sync by hand with the route's response — both files are touched
 * together when the schema changes.
 */
export interface AnalyzeJobStep {
  index: number;
  status: "pending" | "processing" | "done" | "failed";
  started_at?: string | null;
  completed_at?: string | null;
  child_doc_id?: string | null;
  error?: string | null;
  sender_hint?: string | null;
  amount_hint?: number | null;
}

export interface AnalyzeJobState {
  id: string;
  document_id: string;
  status: "pending" | "processing" | "done" | "failed" | "cancelled";
  phase: string | null;
  total_crops: number;
  completed_crops: number;
  steps_state: AnalyzeJobStep[];
  error: string | null;
  payload: {
    detected_docs: Array<{
      sender: string | null;
      amount: number | null;
      document_date: string | null;
      summary: string | null;
    }>;
    crop_paths: string[];
  };
  child_doc_ids?: string[];
  /** Median per-step duration (seconds) from this user's recent
   * completed analyze_jobs. The progress panel uses this for its
   * countdown estimate when present; falls back to a hardcoded default
   * when null (first-time user, no history yet). */
  historical_eta_per_step_sec?: number | null;
  created_at: string;
  updated_at: string;
}

interface UseAnalyzeJobReturn {
  state: AnalyzeJobState | null;
  /** Loading flag — true between mount and first successful poll. */
  loading: boolean;
  /** Network error from the most recent poll, cleared on next success. */
  pollError: string | null;
  /** Force a refresh outside the poll cycle. */
  refresh: () => Promise<void>;
}

/**
 * Polls /api/analyze-job/[jobId] every POLL_INTERVAL_MS until the job
 * finishes (status='done' or 'failed') or the component unmounts.
 *
 * The server's GET endpoint piggy-backs the worker advance on each
 * poll (auto-kick when a step is pending), so the client doesn't need
 * its own driver loop the way the reconciliation panel does for
 * reconcile-step. Polling alone is enough to drive a job to completion.
 *
 * Pattern mirrors driveAiJob in components/inbox/reconciliation-panel.tsx
 * but as a reusable hook with proper unmount cleanup.
 */
const POLL_INTERVAL_MS = 1500;

export function useAnalyzeJob(jobId: string | null): UseAnalyzeJobReturn {
  const [state, setState] = useState<AnalyzeJobState | null>(null);
  const [loading, setLoading] = useState<boolean>(!!jobId);
  const [pollError, setPollError] = useState<string | null>(null);
  // Track the active interval timer so we can cancel it cleanly. Stored
  // in a ref so successive renders don't clobber the live timer.
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mounted flag — guard against setState calls after the component
  // unmounts mid-fetch (would otherwise log a React warning).
  const mountedRef = useRef(true);

  const fetchOnce = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/analyze-job/${id}`, {
        // Prevent the browser/CDN from short-circuiting subsequent polls
        // with a cached response — fresh state matters every tick.
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      }
      const json = (await res.json()) as AnalyzeJobState;
      if (!mountedRef.current) return json;
      setState(json);
      setPollError(null);
      setLoading(false);
      return json;
    } catch (e) {
      if (!mountedRef.current) return null;
      setPollError(e instanceof Error ? e.message : String(e));
      setLoading(false);
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (jobId) await fetchOnce(jobId);
  }, [jobId, fetchOnce]);

  useEffect(() => {
    mountedRef.current = true;
    if (!jobId) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Immediate first poll so the UI shows real state without a 1.5s
    // gap of "loading…".
    const isTerminal = (s: string) =>
      s === "done" || s === "failed" || s === "cancelled";
    fetchOnce(jobId).then((res) => {
      // If the job is already terminal on first poll, don't start the
      // interval — nothing to drive.
      if (res && isTerminal(res.status)) return;
      if (!mountedRef.current) return;
      timerRef.current = setInterval(() => {
        fetchOnce(jobId).then((latest) => {
          if (latest && isTerminal(latest.status) && timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        });
      }, POLL_INTERVAL_MS);
    });

    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [jobId, fetchOnce]);

  return { state, loading, pollError, refresh };
}
