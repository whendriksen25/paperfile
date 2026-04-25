import { Sparkles, CheckCircle2, AlertCircle } from "lucide-react";

/**
 * The shape of `extracted_fields._profile_match` that the analyze route writes
 * back. All fields are optional — older documents may have only some of them.
 */
export interface ProfileMatchInfo {
  reason?: string | null;
  confidence?: number | null;
  ai_ranked?: { profileId: number; name: string; probability: number; reason: string }[] | null;
  ai_best_id?: number | null;
  ai_best_confidence?: number | null;
  ai_best_reason?: string | null;
}

/**
 * Renders a debug-friendly panel showing how the current profile assignment
 * came to be: who chose it, how confident, and (if Claude was consulted) the
 * full ranking with per-profile reasoning.
 */
export function ProfileMatchPanel({
  match,
  currentProfileName,
}: {
  match: ProfileMatchInfo;
  currentProfileName: string | null;
}) {
  const reason = match.reason || "—";
  const confidence = match.confidence;
  const aiPicked = match.ai_best_id ?? null;
  const aiConfidence = match.ai_best_confidence ?? null;
  const aiReason = match.ai_best_reason || null;
  const ranked = match.ai_ranked || [];

  // Did the saved choice differ from what Claude would have picked?
  const aiDisagreed =
    aiPicked != null &&
    ranked.length > 0 &&
    ranked[0].name !== currentProfileName;

  return (
    <div className="surface p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="section-label flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5" />
          Why this profile?
        </h2>
        {confidence != null && (
          <span className="text-[11px] font-bold text-muted-foreground">
            {Math.round(confidence * 100)}% confidence
          </span>
        )}
      </div>

      <div className="rounded-2xl bg-muted/40 px-4 py-3 text-sm flex items-start gap-2">
        {aiDisagreed ? (
          <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-brand-green shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <div className="font-bold">{currentProfileName || "Unassigned"}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{reason}</div>
        </div>
      </div>

      {ranked.length > 0 && (
        <>
          <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Claude&apos;s ranking
          </div>
          <ol className="mt-2 space-y-2 text-sm">
            {ranked.map((r) => {
              const isCurrent = r.name === currentProfileName;
              const isAiBest = r.profileId === aiPicked;
              return (
                <li
                  key={r.profileId}
                  className={`rounded-xl border px-3 py-2 ${
                    isCurrent
                      ? "border-brand-purple/40 bg-brand-purple/5"
                      : "border-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold truncate">{r.name}</span>
                      {isCurrent && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-brand-purple">
                          Current
                        </span>
                      )}
                      {isAiBest && !isCurrent && (
                        <span className="text-[10px] font-bold uppercase tracking-wider text-brand-teal">
                          AI&apos;s pick
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                      {Math.round(r.probability * 100)}%
                    </span>
                  </div>
                  {r.reason && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {r.reason}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {aiDisagreed && aiReason && (
            <p className="mt-3 text-xs text-amber-700">
              <strong>Heads up:</strong> Claude&apos;s top pick was different
              ({aiReason}). Re-analyse with AI or change the profile manually
              if Claude is right.
            </p>
          )}
        </>
      )}
    </div>
  );
}
