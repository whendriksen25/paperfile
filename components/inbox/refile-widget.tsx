"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, FolderInput, Wand2, Loader2, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { AnalyzeProgressPanel } from "@/components/inbox/analyze-progress-panel";
import type { ProfileRow } from "@/types/document";

/**
 * The same enum the extraction prompt uses for document_type. Kept in sync
 * by hand — if you add a type to lib/ai/prompts.ts, add it here too so users
 * can pick it from the dropdown.
 */
const DOCUMENT_TYPES = [
  "medical_bill",
  "medical_declaration",
  "insurance_declaration",
  "insurance_policy",
  "bank_statement",
  "contract",
  "invoice",
  "receipt",
  "utility_bill",
  "tax_document",
  "letter",
  "id_document",
  "prescription",
  "lab_result",
  "appointment_letter",
  "payslip",
  "payment_confirmation",
  "rental_agreement",
  "warranty",
  "certificate",
  "other",
] as const;

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RefileWidget({
  documentId,
  currentProfileId,
  currentDocumentType,
  hasOriginalScan,
  isMultiDocParent,
  activeAnalyzeJobId,
}: {
  documentId: string;
  currentProfileId: number | null;
  currentDocumentType: string | null;
  /** True when this row is the parent of a multi-doc split with the
   * original full scan still stored in Dropbox — enables the second
   * "Re-analyse full scan" button that re-runs multi-doc detection. */
  hasOriginalScan?: boolean;
  /** True when this row has children (legacy splits don't have
   * _original_scan_path but their dropbox_path IS the original scan,
   * and the analyze route knows to handle that legacy fallback). */
  isMultiDocParent?: boolean;
  /** When a "Re-analyse full scan" job is already pending/processing
   * on the server (e.g. the user reloaded the page mid-job), pass its
   * id here so the panel resumes polling instead of leaving the user
   * staring at a stale UI. */
  activeAnalyzeJobId?: string | null;
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [profileId, setProfileId] = useState<number | null>(currentProfileId);
  const [docType, setDocType] = useState<string>(currentDocumentType || "");
  const [saving, setSaving] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [reanalysingFull, setReanalysingFull] = useState(false);
  // Active analyze-job id. Mirrors the activeAnalyzeJobId server-side
  // prop so a page reload mid-job resumes the panel automatically; set
  // imperatively when the user clicks "Re-analyse full scan".
  const [analyzeJobId, setAnalyzeJobId] = useState<string | null>(
    activeAnalyzeJobId || null
  );
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  // After save: if siblings exist with a different classification, show a
  // banner offering one-click "apply this correction to all of them."
  const [propagation, setPropagation] = useState<{
    sibling_count: number;
    sender: string | null;
    target_type: string | null;
  } | null>(null);
  const [propagating, setPropagating] = useState(false);
  const [propagateMessage, setPropagateMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((j) => setProfiles((j.data || []) as ProfileRow[]))
      .catch(() => {});
  }, []);

  // Has the user changed anything?
  const dirty =
    profileId !== currentProfileId || docType !== (currentDocumentType || "");

  async function save() {
    setSaving(true);
    setError(null);
    setDoneMessage(null);
    setPropagation(null);
    setPropagateMessage(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/refile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile_id: profileId,
          document_type: docType || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Refile failed");
      setDoneMessage("Saved — file moved in Dropbox.");
      router.refresh();
      // If the server tells us there are siblings out of sync, surface
      // the propagation banner so the user can apply this correction
      // to all docs from the same sender in one click.
      if (json.sibling_count && json.sibling_count > 0) {
        setPropagation({
          sibling_count: json.sibling_count,
          sender: json.sender || null,
          target_type: json.target_type || null,
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Refile failed");
    } finally {
      setSaving(false);
    }
  }

  async function propagate() {
    if (!propagation) return;
    setPropagating(true);
    setPropagateMessage(null);
    try {
      const res = await fetch(
        `/api/documents/${documentId}/propagate-refile`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Propagate failed");
      setPropagateMessage(
        `Done — ${json.updated} sibling document(s) re-filed${
          json.failed ? `, ${json.failed} failed` : ""
        }.`
      );
      setPropagation(null);
      router.refresh();
    } catch (e: unknown) {
      setPropagateMessage(
        e instanceof Error ? e.message : "Propagate failed"
      );
    } finally {
      setPropagating(false);
    }
  }

  async function reanalyse() {
    setReanalysing(true);
    setError(null);
    setDoneMessage(null);
    try {
      // force_profile=1 tells the analyze route to ignore any pre-pinned
      // primary_profile_id and let Claude re-rank profiles from scratch.
      const res = await fetch(
        `/api/analyze/${documentId}?force_profile=1`,
        { method: "POST" }
      );
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setDoneMessage("Re-analysed — refresh in a moment to see updated data.");
      router.refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Re-analyse failed");
    } finally {
      setReanalysing(false);
    }
  }

  /** "Re-analyse full scan" — only available when this row is the parent
   * of a multi-doc crop split. Kicks off a BACKGROUND analyze job
   * (mirrors the reconcile-job pattern) so per-crop AI calls fit inside
   * Vercel's 60s function ceiling. The progress panel below the button
   * renders while the job runs.
   *
   * Single-doc fallback: if detection finds only 1 document on the
   * scan, no job is created and we fall back to the synchronous inline
   * /api/analyze/[id] route — which is fine for a single doc because
   * the per-crop concurrency that exceeds the budget never kicks in. */
  async function reanalyseFullScan() {
    setReanalysingFull(true);
    setError(null);
    setDoneMessage(null);
    try {
      const res = await fetch(`/api/analyze-job/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentId,
          fromOriginal: true,
          forceProfile: true,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        jobId: string | null;
        totalCrops?: number;
        fallback?: string;
        reason?: string | null;
      };
      if (json.jobId) {
        // Multi-doc path — render the live progress panel.
        setAnalyzeJobId(json.jobId);
      } else if (json.fallback === "single_doc_synchronous") {
        // Only one document detected — fall back to the inline analyze
        // route. This path is fast enough to fit in 60s (no per-crop
        // fan-out) so we don't need the job machinery for it.
        setDoneMessage(
          "Only one document detected — running a normal re-analyse instead…"
        );
        const ires = await fetch(
          `/api/analyze/${documentId}?from_original=1&force_profile=1`,
          { method: "POST" }
        );
        if (!ires.ok) {
          const ij = await ires.json().catch(() => ({}));
          throw new Error(ij.error || `HTTP ${ires.status}`);
        }
        setDoneMessage(
          "Re-analysed — refresh in a moment to see updated data."
        );
        router.refresh();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Re-analyse full scan failed");
    } finally {
      setReanalysingFull(false);
    }
  }

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">
        Move or re-analyse
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
            Profile
          </span>
          <select
            className="input mt-1 cursor-pointer"
            value={profileId ?? ""}
            onChange={(e) =>
              setProfileId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">— Unassigned —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.is_default ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
            Document type
          </span>
          <select
            className="input mt-1 cursor-pointer"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
          >
            <option value="">— None —</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {titleCase(t)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="btn-primary text-xs !py-2"
        >
          {saving ? (
            <>
              <Spinner className="h-3.5 w-3.5" /> Moving…
            </>
          ) : (
            <>
              <FolderInput className="h-3.5 w-3.5" />
              Save & re-file
            </>
          )}
        </button>
        <button
          onClick={reanalyse}
          disabled={reanalysing || reanalysingFull}
          className="btn-secondary text-xs !py-2"
        >
          {reanalysing ? (
            <>
              <Spinner className="h-3.5 w-3.5" /> Re-analysing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              Re-analyse with AI
            </>
          )}
        </button>
      </div>

      {/* Multi-doc re-split — show on any parent of a multi-doc split,
          new format (with _original_scan_path) OR legacy (without). */}
      {(hasOriginalScan || isMultiDocParent) && (
        <button
          onClick={reanalyseFullScan}
          disabled={reanalysing || reanalysingFull || !!analyzeJobId}
          className="btn-secondary text-xs !py-2 mt-2 w-full"
          title="Re-download the original multi-receipt scan and redo the entire split — replaces all current sibling rows"
        >
          {reanalysingFull || analyzeJobId ? (
            <>
              <Spinner className="h-3.5 w-3.5" />
              {analyzeJobId
                ? "Re-analysing in background…"
                : "Starting re-analyse…"}
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              Re-analyse full scan (re-split all receipts)
            </>
          )}
        </button>
      )}

      {/* Live progress for an active background re-analyse job. Resumes
          from a server-side row when activeAnalyzeJobId was passed in
          from the page server component (page reload mid-job). */}
      {analyzeJobId && (
        <AnalyzeProgressPanel
          jobId={analyzeJobId}
          onComplete={() => {
            // Clear the local job id so the button re-enables.
            setAnalyzeJobId(null);
            setDoneMessage(
              "Full-scan re-analysed — new split is live below."
            );
            router.refresh();
          }}
          onFailed={(err) => {
            setAnalyzeJobId(null);
            setError(err || "Re-analyse job failed");
          }}
        />
      )}

      {error && (
        <p className="mt-2 text-xs text-destructive font-semibold">{error}</p>
      )}
      {doneMessage && (
        <p className="mt-2 text-xs text-brand-green font-semibold">
          {doneMessage}
        </p>
      )}

      {propagation && (
        <div className="mt-3 surface bg-brand-purple/5 border-brand-purple/30 p-3">
          <div className="flex items-start gap-3">
            <Wand2 className="h-4 w-4 text-brand-purple shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold">
                Apply this correction to {propagation.sibling_count} other doc
                {propagation.sibling_count === 1 ? "" : "s"} from{" "}
                {propagation.sender || "this sender"}?
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                They&apos;ll be moved to the same folder structure and tagged
                with the same profile / document type.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={propagate}
                  disabled={propagating}
                  className="btn-primary text-xs !py-2"
                >
                  {propagating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Applying…
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      Yes, apply to all
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setPropagation(null)}
                  disabled={propagating}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1.5"
                >
                  <X className="h-3.5 w-3.5" />
                  No, just this one
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {propagateMessage && (
        <p className="mt-2 text-xs font-semibold text-brand-green">
          {propagateMessage}
        </p>
      )}
    </div>
  );
}
