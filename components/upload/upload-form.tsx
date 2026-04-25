"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Upload as UploadIcon, X, Sparkles, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils/cn";
import { formatBytes } from "@/lib/utils/format";
import { useProfiles } from "@/hooks/useProfiles";

interface PendingFile {
  id: string;
  file: File;
  progress: "queued" | "uploading" | "done" | "failed";
  error?: string;
  documentId?: string;
}

export function UploadForm() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const { profiles, active } = useProfiles();
  const [profileId, setProfileId] = useState<number | "">("");
  const [batch, setBatch] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // When on, the server stitches all picked files into ONE multi-page PDF
  // and treats them as a single Paperfile document.
  const [combineMode, setCombineMode] = useState(false);
  const [combinedName, setCombinedName] = useState("");

  // NOTE: deliberately NOT pre-filling profileId from `active`. If we did,
  // every upload would be locked to the currently-selected profile and the AI
  // would never get to match it (analyze route honours pre-set profile_id as
  // "user choice"). Empty default = "Auto-detect with AI".
  // The user can still override by picking a profile in the dropdown.

  function addFiles(files: FileList | null) {
    if (!files) return;
    const next: PendingFile[] = Array.from(files).map((f) => ({
      id: crypto.randomUUID(),
      file: f,
      progress: "queued",
    }));
    setPending((p) => [...p, ...next]);
  }

  function removeFile(id: string) {
    setPending((p) => p.filter((f) => f.id !== id));
  }

  async function submit() {
    if (pending.length === 0) return;
    setSubmitting(true);
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    let lastDocId: string | null = null;

    if (combineMode) {
      // Single POST with all files; server stitches into one PDF.
      setPending((p) =>
        p.map((f) => ({ ...f, progress: "uploading" as const }))
      );
      const fd = new FormData();
      fd.append("combine", "1");
      if (combinedName.trim()) fd.append("combinedName", combinedName.trim());
      for (const it of pending) fd.append("files", it.file);
      if (batch) fd.append("batch", batch);
      if (profileId) fd.append("profile_id", String(profileId));
      if (tags.length) fd.append("tags", tags.join(","));
      try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        lastDocId = json.data?.id || null;
        setPending((p) =>
          p.map((f) => ({
            ...f,
            progress: "done" as const,
            documentId: lastDocId || undefined,
          }))
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        setPending((p) =>
          p.map((f) => ({ ...f, progress: "failed" as const, error: msg }))
        );
      }
    } else {
      for (const item of pending) {
        if (item.progress === "done") continue;
        setPending((p) =>
          p.map((f) => (f.id === item.id ? { ...f, progress: "uploading" } : f))
        );
        const fd = new FormData();
        fd.append("file", item.file);
        if (batch) fd.append("batch", batch);
        if (profileId) fd.append("profile_id", String(profileId));
        if (tags.length) fd.append("tags", tags.join(","));
        try {
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          if (!res.ok) throw new Error(await res.text());
          const json = await res.json();
          lastDocId = json.data?.id || null;
          setPending((p) =>
            p.map((f) =>
              f.id === item.id
                ? { ...f, progress: "done", documentId: lastDocId || undefined }
                : f
            )
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Upload failed";
          setPending((p) =>
            p.map((f) =>
              f.id === item.id ? { ...f, progress: "failed", error: msg } : f
            )
          );
        }
      }
    }

    setSubmitting(false);
    // Always land at /inbox after a scan — fire-and-forget. Don't push the
    // user to the document detail page (which has profile dropdowns and feels
    // like "you must assign this before continuing"). Triage happens on the
    // laptop via the inbox's "Needs review" banner.
    router.push("/inbox");
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <button
          type="button"
          onClick={() => cameraInput.current?.click()}
          className="surface flex flex-col items-center justify-center py-10 gap-3 hover:shadow-card transition-all"
        >
          <div className="h-12 w-12 rounded-full bg-brand-purple/10 flex items-center justify-center">
            <Camera className="h-6 w-6 text-brand-purple" />
          </div>
          <div className="text-center">
            <div className="text-sm font-bold">Take photo</div>
            <div className="text-xs text-muted-foreground">Use camera</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="surface flex flex-col items-center justify-center py-10 gap-3 hover:shadow-card transition-all"
        >
          <div className="h-12 w-12 rounded-full bg-brand-teal/10 flex items-center justify-center">
            <UploadIcon className="h-6 w-6 text-brand-teal" />
          </div>
          <div className="text-center">
            <div className="text-sm font-bold">Pick files</div>
            <div className="text-xs text-muted-foreground">PDFs or images</div>
          </div>
        </button>
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,image/*"
          multiple
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {/* Combine-pages toggle — when on, all picked files become ONE multi-page PDF */}
      <div className="surface p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={combineMode}
            onChange={(e) => setCombineMode(e.target.checked)}
            className="mt-1 h-4 w-4 accent-brand-purple cursor-pointer"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 text-sm font-bold">
              <Layers className="h-3.5 w-3.5 text-brand-purple" />
              Combine into one document
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Treat the picked photos as pages of a single multi-page document.
              The server stitches them into one PDF before AI analysis.
              {pending.length > 1 && (
                <>
                  {" "}
                  <span className="font-bold text-foreground">
                    {pending.length} pages will be combined.
                  </span>
                </>
              )}
            </p>
            {combineMode && (
              <div className="mt-3 space-y-1.5">
                <label className="section-label">Combined document name</label>
                <Input
                  placeholder="medical_bill_dec_2025"
                  value={combinedName}
                  onChange={(e) => setCombinedName(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  Optional. Becomes the filename of the stitched PDF; the AI still
                  extracts the real title from the document content.
                </p>
              </div>
            )}
          </div>
        </label>
      </div>

      <div className="surface p-5 space-y-4">
        <div className="flex items-center gap-2 text-xs text-brand-purple font-bold">
          <Sparkles className="h-3.5 w-3.5" />
          Paperfile AI will categorise and extract actions
        </div>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label className="section-label">Profile</label>
            <select
              className="input"
              value={profileId}
              onChange={(e) =>
                setProfileId(e.target.value ? Number(e.target.value) : "")
              }
            >
              <option value="">Auto (AI decides from doc)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_default ? " · default" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="section-label">Batch (optional)</label>
              <Input
                placeholder="healthcare_dad_2026"
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="section-label">Tags (comma-separated)</label>
              <Input
                placeholder="medical, reimbursable"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="surface p-4 space-y-2">
          {pending.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">
                  {item.file.name}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {formatBytes(item.file.size)} · {item.progress}
                  {item.error ? ` — ${item.error}` : ""}
                </div>
              </div>
              <button
                className={cn(
                  "p-1.5 rounded-full text-muted-foreground hover:bg-muted hover:text-destructive",
                  item.progress === "uploading" && "opacity-50 cursor-not-allowed"
                )}
                disabled={item.progress === "uploading"}
                onClick={() => removeFile(item.id)}
                aria-label="Remove"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={submitting || pending.length === 0}
        onClick={submit}
      >
        {submitting ? (
          <Spinner />
        ) : combineMode ? (
          `Combine ${pending.length} ${
            pending.length === 1 ? "page" : "pages"
          } into one document`
        ) : (
          `Scan it · ${pending.length || 0} ${
            pending.length === 1 ? "file" : "files"
          }`
        )}
      </Button>
    </div>
  );
}
