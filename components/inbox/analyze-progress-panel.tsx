"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  AlertTriangle,
  Circle,
  ScanSearch,
  Scissors,
  Sparkles,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useAnalyzeJob, type AnalyzeJobStep } from "@/lib/hooks/use-analyze-job";

/**
 * Live progress panel for a multi-doc "re-analyse full scan" job.
 *
 * Shows phase-by-phase status with countdown timers so the user has
 * something to look at while a 4-receipt scan takes ~80s end-to-end.
 *
 * Phases displayed (in order):
 *   1. Detecting documents on scan — done by the time the job exists
 *      (the prepare route does it synchronously), so this row is
 *      always shown as ✓ once the panel mounts. Listed for context.
 *   2. Detected N documents — preparing crops — done as soon as the
 *      first step shows up, ✓.
 *   3. OCR'ing receipt X of N — {sender_hint} €{amount_hint} —
 *      the current per-crop extraction. Countdown timer counts down
 *      from ETA_PER_STEP_S to 0; recalculates whenever a step lands.
 *   4. Finalising — cleaning up old siblings — only briefly visible
 *      after the last step completes, before status flips to done.
 *   5. Done — N receipts created — terminal ✓.
 *
 * The per-step list under the phases shows every step's sender/amount/
 * status icon so the user can see at a glance which receipt is up
 * next, which are done, which (if any) failed.
 */

// Estimated seconds per phase. Sonnet's per-crop extraction is the slow
// part (~20s on a busy day); detection runs in the prepare step and
// crops upload in parallel.
const ETA_DETECT_S = 8;
const ETA_CROP_S = 2;
const ETA_PER_STEP_S = 20;
const ETA_FINALISE_S = 3;

export interface AnalyzeProgressPanelProps {
  jobId: string;
  /** Fired once when the job transitions to status='done'. Use this to
   * router.refresh() so the rest of the page picks up the new split. */
  onComplete?: () => void;
  /** Fired once when the job transitions to status='failed'. */
  onFailed?: (error: string | null) => void;
}

export function AnalyzeProgressPanel({
  jobId,
  onComplete,
  onFailed,
}: AnalyzeProgressPanelProps) {
  const { state, loading, pollError } = useAnalyzeJob(jobId);
  const onCompleteRef = useRef(onComplete);
  const onFailedRef = useRef(onFailed);
  onCompleteRef.current = onComplete;
  onFailedRef.current = onFailed;

  // Fire onComplete/onFailed exactly once when the job lands.
  const firedTerminalRef = useRef<"done" | "failed" | null>(null);
  useEffect(() => {
    if (!state) return;
    if (state.status === "done" && firedTerminalRef.current !== "done") {
      firedTerminalRef.current = "done";
      onCompleteRef.current?.();
    }
    if (state.status === "failed" && firedTerminalRef.current !== "failed") {
      firedTerminalRef.current = "failed";
      onFailedRef.current?.(state.error);
    }
  }, [state]);

  if (loading) {
    return (
      <div className="surface p-4 mt-3 bg-brand-purple/5 border-brand-purple/30">
        <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
          <Spinner className="h-4 w-4" />
          Starting up…
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="surface p-4 mt-3">
        <p className="text-xs text-destructive font-semibold inline-flex items-center gap-1">
          <AlertTriangle className="h-3.5 w-3.5" />
          Couldn&apos;t load job state{pollError ? `: ${pollError}` : ""}
        </p>
      </div>
    );
  }

  return <PanelBody state={state} pollError={pollError} />;
}

function PanelBody({
  state,
  pollError,
}: {
  state: NonNullable<ReturnType<typeof useAnalyzeJob>["state"]>;
  pollError: string | null;
}) {
  const isDone = state.status === "done";
  const isFailed = state.status === "failed";
  const detectedCount =
    state.total_crops || state.payload.detected_docs?.length || 0;

  // Active step = the one currently 'processing' (claimed but not done).
  // If none is processing but pending exist, treat the next pending as
  // "about to start" so the UI doesn't blink to "finished" between steps.
  const activeStep = useMemo<AnalyzeJobStep | null>(() => {
    const proc = state.steps_state.find((s) => s.status === "processing");
    if (proc) return proc;
    const pend = state.steps_state.find((s) => s.status === "pending");
    return pend || null;
  }, [state.steps_state]);

  const remainingPendingOrProcessing = useMemo(
    () =>
      state.steps_state.filter(
        (s) => s.status === "pending" || s.status === "processing"
      ).length,
    [state.steps_state]
  );

  // Per-step ETA — prefer the median from this user's recent completed
  // jobs (server-computed in /api/analyze-job/[jobId]). Falls back to
  // the hardcoded 20s when no history exists (first run).
  const perStepEtaS =
    typeof state.historical_eta_per_step_sec === "number" &&
    state.historical_eta_per_step_sec > 0
      ? state.historical_eta_per_step_sec
      : ETA_PER_STEP_S;

  // Overall ETA in seconds = remaining steps × per-step estimate, + a
  // little finalisation overhead. Recomputed every render; the
  // useCountdown hook independently counts down per second.
  const totalEtaS =
    remainingPendingOrProcessing * perStepEtaS +
    (remainingPendingOrProcessing > 0 ? ETA_FINALISE_S : 0);

  return (
    <div className="surface p-4 mt-3 bg-brand-purple/5 border-brand-purple/30 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold inline-flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-brand-purple" />
          Re-analysing full scan
        </div>
        {!isDone && !isFailed && totalEtaS > 0 && (
          <div className="text-xs text-muted-foreground">
            ETA ~{formatEta(totalEtaS)}
          </div>
        )}
      </div>

      {/* Phase rows */}
      <div className="space-y-1.5 text-sm">
        {/* 1. Detection — always done by the time the job exists. */}
        <PhaseRow
          icon={<ScanSearch className="h-4 w-4" />}
          label="Detecting documents on scan"
          status="done"
        />
        {/* 2. Cropping — done as soon as the prepare step finished
            (we'd never have a job otherwise). */}
        <PhaseRow
          icon={<Scissors className="h-4 w-4" />}
          label={`Detected ${detectedCount} document${detectedCount === 1 ? "" : "s"} — crops prepared`}
          status="done"
        />
        {/* 3. Per-step extraction — current focus. */}
        {!isDone && activeStep && (
          <ActiveStepRow
            step={activeStep}
            total={state.total_crops}
            completed={state.completed_crops}
            perStepEtaS={perStepEtaS}
          />
        )}
        {/* 4. Finalising — only shown when last step done but job not yet
            flipped to done. */}
        {!isDone &&
          !isFailed &&
          state.completed_crops === state.total_crops &&
          state.total_crops > 0 && (
            <PhaseRow
              icon={<Spinner className="h-4 w-4" />}
              label="Finalising — cleaning up old siblings"
              status="processing"
              countdownSeconds={ETA_FINALISE_S}
            />
          )}
        {/* 5. Done. */}
        {isDone && (
          <PhaseRow
            icon={<CheckCircle2 className="h-4 w-4" />}
            label={`Done — ${state.total_crops} receipt${state.total_crops === 1 ? "" : "s"} created`}
            status="done"
            highlight
          />
        )}
        {isFailed && (
          <PhaseRow
            icon={<AlertTriangle className="h-4 w-4" />}
            label={`Failed${state.error ? `: ${state.error}` : ""}`}
            status="failed"
          />
        )}
      </div>

      {/* Per-step list */}
      {state.steps_state.length > 0 && (
        <div className="border-t border-border pt-2 mt-2">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">
            Receipts
          </div>
          <ul className="space-y-1">
            {state.steps_state.map((s) => (
              <li key={s.index} className="text-xs">
                <StepLine step={s} jobId={state.id} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {pollError && (
        <p className="text-[11px] text-amber-700 inline-flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" />
          Poll error (will retry): {pollError}
        </p>
      )}
    </div>
  );
}

function PhaseRow({
  icon,
  label,
  status,
  highlight,
  countdownSeconds,
}: {
  icon: React.ReactNode;
  label: string;
  status: "pending" | "processing" | "done" | "failed";
  highlight?: boolean;
  /** When provided AND status='processing', counts down from this many
   * seconds; clamps at 0 and shows "taking longer than expected…". */
  countdownSeconds?: number;
}) {
  const countdown = useCountdown(
    status === "processing" ? countdownSeconds ?? null : null
  );
  const colorClass =
    status === "done"
      ? "text-brand-green"
      : status === "failed"
        ? "text-destructive"
        : status === "processing"
          ? "text-brand-purple"
          : "text-muted-foreground";

  return (
    <div
      className={`flex items-center gap-2 ${highlight ? "font-bold" : ""}`}
    >
      <span className={colorClass}>{icon}</span>
      <span className={status === "pending" ? "text-muted-foreground" : ""}>
        {label}
      </span>
      {countdown !== null && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {countdown.phase === "counting"
            ? `~${countdown.remaining}s`
            : countdown.phase === "overflow_brief"
              ? "taking longer than expected…"
              : `+${countdown.over}s over estimate`}
        </span>
      )}
    </div>
  );
}

function ActiveStepRow({
  step,
  total,
  completed,
  perStepEtaS,
}: {
  step: AnalyzeJobStep;
  total: number;
  completed: number;
  perStepEtaS: number;
}) {
  const isProcessing = step.status === "processing";
  const label = `OCR'ing receipt ${completed + 1} of ${total} — ${formatHint(step)}`;
  return (
    <PhaseRow
      icon={<Spinner className="h-4 w-4" />}
      label={label}
      status={isProcessing ? "processing" : "pending"}
      countdownSeconds={perStepEtaS}
    />
  );
}

function StepLine({ step, jobId }: { step: AnalyzeJobStep; jobId: string }) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      // Pass ?retry_step=N — server resets this step to pending then
      // processes it. Without the param the worker would pick the next
      // pending step and skip the one the user clicked.
      const res = await fetch(
        `/api/analyze-step/${jobId}?retry_step=${step.index}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text.slice(0, 120) || `HTTP ${res.status}`);
      }
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetrying(false);
    }
  }

  const icon =
    step.status === "done" ? (
      <Check className="h-3.5 w-3.5 text-brand-green" />
    ) : step.status === "processing" ? (
      <Spinner className="h-3.5 w-3.5 text-brand-purple" />
    ) : step.status === "failed" ? (
      <X className="h-3.5 w-3.5 text-destructive" />
    ) : (
      <Circle className="h-3.5 w-3.5 text-muted-foreground" />
    );

  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5">{icon}</span>
      <span className="flex-1 min-w-0">
        <span
          className={
            step.status === "done"
              ? "text-foreground"
              : step.status === "failed"
                ? "text-destructive font-semibold"
                : step.status === "processing"
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground"
          }
        >
          {step.index + 1}. {formatHint(step)}
        </span>
        {step.status === "failed" && step.error && (
          <span className="block text-[10px] text-destructive/80 mt-0.5">
            {step.error}
          </span>
        )}
        {retryError && (
          <span className="block text-[10px] text-destructive/80 mt-0.5">
            Retry failed: {retryError}
          </span>
        )}
      </span>
      {step.status === "failed" && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="text-[10px] font-bold uppercase tracking-wider text-brand-purple hover:bg-brand-purple/10 px-1.5 py-0.5 rounded disabled:opacity-50"
        >
          {retrying ? "…" : "retry"}
        </button>
      )}
    </div>
  );
}

function formatHint(step: AnalyzeJobStep): string {
  const sender = (step.sender_hint || "").trim();
  const amount = step.amount_hint;
  const left = sender || "Receipt";
  if (amount != null && Number.isFinite(amount)) {
    return `${left} €${amount.toFixed(2)}`;
  }
  return left;
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m${s.toString().padStart(2, "0")}s`;
}

/**
 * Tick hook used by the step countdown. Returns a two-phase state:
 *   - phase: 'counting' while remaining > 0 (shows "~Xs left")
 *   - phase: 'overflow_brief' for ~2 seconds after remaining hits 0
 *     (shows "Taking longer than expected")
 *   - phase: 'overflow_counting' once we're past the brief flash
 *     (shows "+Xs over estimate")
 *
 * Resets whenever the initial seconds input changes (e.g. moving to a
 * new step). Returns null when input is null.
 */
type CountdownState =
  | { phase: "counting"; remaining: number }
  | { phase: "overflow_brief"; over: number }
  | { phase: "overflow_counting"; over: number };

function useCountdown(seconds: number | null): CountdownState | null {
  const [state, setState] = useState<CountdownState | null>(
    seconds === null ? null : { phase: "counting", remaining: seconds }
  );
  useEffect(() => {
    if (seconds === null) {
      setState(null);
      return;
    }
    setState({ phase: "counting", remaining: seconds });
    const interval = setInterval(() => {
      setState((s) => {
        if (s === null) return null;
        if (s.phase === "counting") {
          if (s.remaining > 1) {
            return { phase: "counting", remaining: s.remaining - 1 };
          }
          // Tipped past zero — show the brief "Taking longer" flash.
          return { phase: "overflow_brief", over: 1 };
        }
        if (s.phase === "overflow_brief") {
          // After ~2 seconds in the brief state, switch to the live
          // "+Xs over estimate" counter so the user sees something
          // useful rather than a stuck label.
          if (s.over >= 2) {
            return { phase: "overflow_counting", over: s.over + 1 };
          }
          return { phase: "overflow_brief", over: s.over + 1 };
        }
        // overflow_counting — keep climbing.
        return { phase: "overflow_counting", over: s.over + 1 };
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);
  return state;
}
