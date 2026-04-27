"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  Camera,
  Upload as UploadIcon,
  X,
  Sparkles,
  Layers,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils/cn";
import { formatBytes } from "@/lib/utils/format";
import { useProfiles } from "@/hooks/useProfiles";
import {
  compressImageInBrowser,
  shouldCompress,
} from "@/lib/utils/compress-image-client";

interface PendingFile {
  id: string;
  file: File;
  progress: "queued" | "compressing" | "uploading" | "done" | "failed";
  error?: string;
  documentId?: string;
}

export function UploadForm() {
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const { profiles, active } = useProfiles();
  const [profileId, setProfileId] = useState<number | "">("");
  const [batch, setBatch] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Running tally of docs successfully sent off in this /upload session.
  // We use it for the "X uploaded · processing in inbox" banner that lets
  // the user keep scanning without leaving the page.
  const [sessionUploaded, setSessionUploaded] = useState(0);
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
    // Tracked locally because reading `pending` after the loop returns stale
    // state (React batches setPending calls; the closure's `pending` is the
    // pre-loop snapshot). Without this, navigation-on-success masks failures.
    let anyFailed = false;

    // ----- Step 1: client-side compression -----
    // Shrink + HEIC-convert images in the browser BEFORE upload. Avoids
    // Vercel's 4.5 MB body limit AND fixes iPhone HEIC docs that the server's
    // sharp can't always decode. PDFs and small JPEGs are skipped.
    //
    // We replace each PendingFile's `.file` with the compressed version,
    // then proceed to upload as before.
    const compressed: PendingFile[] = [];
    for (const item of pending) {
      if (item.progress === "done") {
        compressed.push(item);
        continue;
      }
      if (!shouldCompress(item.file)) {
        compressed.push(item);
        continue;
      }
      setPending((p) =>
        p.map((f) =>
          f.id === item.id ? { ...f, progress: "compressing" } : f
        )
      );
      try {
        const small = await compressImageInBrowser(item.file);
        const next = { ...item, file: small, progress: "queued" as const };
        compressed.push(next);
        setPending((p) => p.map((f) => (f.id === item.id ? next : f)));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Compression failed";
        anyFailed = true;
        setPending((p) =>
          p.map((f) =>
            f.id === item.id ? { ...f, progress: "failed", error: msg } : f
          )
        );
      }
    }
    // Use the compressed list from here on. Bail early if every file failed
    // compression — there's nothing left to upload.
    const usableFiles = compressed.filter((f) => f.progress !== "failed");
    if (usableFiles.length === 0) {
      setSubmitting(false);
      return;
    }

    if (combineMode) {
      // Single POST with all (compressed) files; server stitches into one PDF.
      setPending((p) =>
        p.map((f) =>
          f.progress === "failed" ? f : { ...f, progress: "uploading" as const }
        )
      );
      const fd = new FormData();
      fd.append("combine", "1");
      if (combinedName.trim()) fd.append("combinedName", combinedName.trim());
      for (const it of usableFiles) fd.append("files", it.file);
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
        anyFailed = true;
        setPending((p) =>
          p.map((f) => ({ ...f, progress: "failed" as const, error: msg }))
        );
      }
    } else {
      for (const item of usableFiles) {
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
          anyFailed = true;
          setPending((p) =>
            p.map((f) =>
              f.id === item.id ? { ...f, progress: "failed", error: msg } : f
            )
          );
        }
      }
    }

    setSubmitting(false);

    // Did anything actually fail? If yes, stay on /upload so the user can see
    // the error message — silent navigation to /inbox is what made the HEIC
    // bug invisible for so long.
    if (anyFailed) {
      // Stay put — the per-file error message is rendered next to its name.
      // Drop the successful items so the failures stand out visually, but
      // keep the count for the banner.
      setPending((p) => {
        const successCount = p.filter((f) => f.progress === "done").length;
        if (successCount) setSessionUploaded((n) => n + successCount);
        return p.filter((f) => f.progress === "failed");
      });
      return;
    }

    // Successful batch: stay on /upload so the user can keep scanning.
    // Clear pending so the screen is fresh for the next photo, bump the
    // session counter so the "X uploaded · processing" banner appears.
    const justUploaded = pending.length;
    setPending([]);
    setSessionUploaded((n) => n + justUploaded);
    // Reset combine-mode state so the next batch starts clean.
    if (combineMode) {
      setCombineMode(false);
      setCombinedName("");
    }
  }

  return (
    <div className="space-y-5">
      {/* Continuous-scan banner: appears after the first successful upload
          in this page session. Tells the user that previous scans are off
          to the AI, and gives them a one-tap path to the inbox without
          forcing them off /upload. */}
      {sessionUploaded > 0 && (
        <div className="surface bg-brand-green/5 border-brand-green/20 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-brand-green shrink-0" />
            <span>
              <span className="font-bold text-brand-green">
                {sessionUploaded}{" "}
                {sessionUploaded === 1 ? "document" : "documents"}
              </span>{" "}
              uploaded · processing in the background
            </span>
          </div>
          <Link
            href="/inbox"
            className="text-xs font-bold text-brand-purple hover:opacity-80 inline-flex items-center gap-1 shrink-0"
          >
            View inbox
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}

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
                <div
                  className={cn(
                    "text-[11px]",
                    item.progress === "failed"
                      ? "text-destructive font-semibold"
                      : "text-muted-foreground"
                  )}
                >
                  {formatBytes(item.file.size)} ·{" "}
                  {item.progress === "compressing"
                    ? "Compressing on device…"
                    : item.progress === "uploading"
                      ? "Uploading…"
                      : item.progress === "done"
                        ? "Done"
                        : item.progress === "failed"
                          ? "Failed"
                          : "Queued"}
                  {item.error ? ` — ${item.error}` : ""}
                </div>
              </div>
              <button
                className={cn(
                  "p-1.5 rounded-full text-muted-foreground hover:bg-muted hover:text-destructive",
                  (item.progress === "uploading" ||
                    item.progress === "compressing") &&
                    "opacity-50 cursor-not-allowed"
                )}
                disabled={
                  item.progress === "uploading" ||
                  item.progress === "compressing"
                }
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
