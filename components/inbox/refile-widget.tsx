"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, FolderInput } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
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
}: {
  documentId: string;
  currentProfileId: number | null;
  currentDocumentType: string | null;
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [profileId, setProfileId] = useState<number | null>(currentProfileId);
  const [docType, setDocType] = useState<string>(currentDocumentType || "");
  const [saving, setSaving] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Refile failed");
    } finally {
      setSaving(false);
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
          disabled={reanalysing}
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

      {error && (
        <p className="mt-2 text-xs text-destructive font-semibold">{error}</p>
      )}
      {doneMessage && (
        <p className="mt-2 text-xs text-brand-green font-semibold">
          {doneMessage}
        </p>
      )}
    </div>
  );
}
