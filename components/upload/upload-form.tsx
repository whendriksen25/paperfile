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
import { directUpload } from "@/lib/utils/direct-upload-client";
import { combineImagesToPdfClient } from "@/lib/utils/combine-images-client";

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
  // Items from the LAST submit that failed. Kept in a separate list so they
  // never get bundled into the next combine/scan batch — once Scan is hit,
  // those items are off the table for combining with future ones.
  const [recentFailures, setRecentFailures] = useState<PendingFile[]>([]);
  // Items the server detected as duplicates of an existing doc. Surfaced
  // separately so the user can see "this scan matched XYZ" instead of
  // wondering why their upload didn't show up in the inbox.
  const [recentDuplicates, setRecentDuplicates] = useState<
    { id: string; fileName: string; existingId: string }[]
  >([]);
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

    const batchSize = pending.length;
    let lastDocId: string | null = null;
    // Tracked locally because reading `pending` after the loop returns stale
    // state (React batches setPending calls; the closure's `pending` is the
    // pre-loop snapshot). Without this, navigation-on-success masks failures.
    let anyFailed = false;
    // Failed items from THIS submit, captured locally — at the end we move
    // them out of the active pending list into recentFailures so they can't
    // accidentally be combined with the next batch.
    const failuresThisRun: PendingFile[] = [];
    // Count of items the server flagged as duplicates of an existing doc
    // during this submit. The dup details get pushed into recentDuplicates
    // state inline, but we also need a local count so the green-banner
    // tally is accurate (state closure is stale at end-of-run).
    let dupsThisRun = 0;

    // ----- Step 1: client-side compression / normalisation -----
    // Shrink + HEIC-convert images in the browser. Two reasons it still
    // matters even though the bytes now go straight to Dropbox (no 4.5 MB
    // server-body limit): (1) smaller JPEGs upload faster and sit under
    // Claude's per-image pixel ceiling, improving extraction; (2) in COMBINE
    // mode every page must be JPEG so pdf-lib can stitch it in the browser.
    //
    // We replace each PendingFile's `.file` with the compressed version.
    const compressed: PendingFile[] = [];
    for (const item of pending) {
      if (item.progress === "done") {
        compressed.push(item);
        continue;
      }
      // Combine mode: force-normalise EVERY image page to JPEG (the browser
      // PDF stitch embeds JPEG). Single mode: only large images need it.
      const isImage =
        item.file.type.startsWith("image/") ||
        /\.(jpe?g|png|webp|heic|heif|tiff?|gif)$/i.test(item.file.name);
      const mustCompress = combineMode ? isImage : shouldCompress(item.file);
      if (!mustCompress) {
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
        console.warn(
          `[upload] compression failed for ${item.file.name}: ${msg}`
        );
        if (combineMode) {
          // In combine mode, a page we can't decode can't be stitched into
          // the PDF — treat it as a real failure.
          anyFailed = true;
          failuresThisRun.push({ ...item, progress: "failed", error: msg });
          setPending((p) =>
            p.map((f) =>
              f.id === item.id ? { ...f, progress: "failed", error: msg } : f
            )
          );
        } else {
          // Single-file mode: direct-to-Dropbox has no body limit, so an
          // uncompressed original is fine — upload it and let the server's
          // sharp / heic-convert fallbacks handle decoding.
          const next = { ...item, progress: "queued" as const };
          compressed.push(next);
          setPending((p) => p.map((f) => (f.id === item.id ? next : f)));
        }
      }
    }
    // Use the compressed list from here on. If every page failed compression
    // there's nothing to upload — fall through to the end-of-run bookkeeping
    // so the failures still surface in the "Recent failures" panel.
    const usableFiles = compressed.filter((f) => f.progress !== "failed");

    if (usableFiles.length > 0 && combineMode) {
      // Combine mode: stitch the (now-JPEG) pages into ONE PDF in the browser,
      // then upload that single PDF straight to Dropbox. No page bytes ever
      // touch our server, so there's no combined-body size limit.
      setPending((p) =>
        p.map((f) =>
          f.progress === "failed" ? f : { ...f, progress: "uploading" as const }
        )
      );
      try {
        const pdf = await combineImagesToPdfClient(
          usableFiles.map((f) => f.file),
          combinedName.trim() || `combined_${Date.now()}`
        );
        const json = await directUpload(pdf, {
          combine: true,
          batch: batch || null,
          profileId: profileId || null,
          tags,
        });
        lastDocId = json.data?.id || null;
        if (json.duplicate && lastDocId) {
          // Combined PDF matched an existing doc — surface as duplicate
          // instead of pretending we did a new upload.
          dupsThisRun += batchSize; // whole combined batch counts as one dup
          setRecentDuplicates((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              fileName: combinedName.trim() || "combined document",
              existingId: lastDocId as string,
            },
          ]);
          setPending([]);
        } else {
          setPending((p) =>
            p.map((f) => ({
              ...f,
              progress: "done" as const,
              documentId: lastDocId || undefined,
            }))
          );
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        anyFailed = true;
        for (const it of usableFiles) {
          failuresThisRun.push({ ...it, progress: "failed", error: msg });
        }
        setPending((p) =>
          p.map((f) => ({ ...f, progress: "failed" as const, error: msg }))
        );
      }
    } else if (usableFiles.length > 0) {
      for (const item of usableFiles) {
        if (item.progress === "done") continue;
        setPending((p) =>
          p.map((f) => (f.id === item.id ? { ...f, progress: "uploading" } : f))
        );
        try {
          const json = await directUpload(item.file, {
            batch: batch || null,
            profileId: profileId || null,
            tags,
          });
          lastDocId = json.data?.id || null;
          if (json.duplicate && lastDocId) {
            // Server saw this exact file before — surface a duplicate
            // marker and remove it from pending so it doesn't show as
            // a fresh upload.
            dupsThisRun++;
            setRecentDuplicates((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                fileName: item.file.name,
                existingId: lastDocId as string,
              },
            ]);
            setPending((p) => p.filter((f) => f.id !== item.id));
          } else {
            setPending((p) =>
              p.map((f) =>
                f.id === item.id
                  ? { ...f, progress: "done", documentId: lastDocId || undefined }
                  : f
              )
            );
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "Upload failed";
          anyFailed = true;
          failuresThisRun.push({ ...item, progress: "failed", error: msg });
          setPending((p) =>
            p.map((f) =>
              f.id === item.id ? { ...f, progress: "failed", error: msg } : f
            )
          );
        }
      }
    }

    setSubmitting(false);

    // Always close the batch: pending is cleared so any new files the user
    // adds form a fresh batch and won't be combined with these (whether
    // they succeeded or failed). Successes feed the green banner counter;
    // failures move into a separate "Recent failures" surface; duplicates
    // are surfaced in their own "Skipped duplicates" surface.
    const failedCount = failuresThisRun.length;
    const successCount = Math.max(
      0,
      batchSize - failedCount - dupsThisRun
    );
    setPending([]);
    if (successCount > 0) setSessionUploaded((n) => n + successCount);
    if (failedCount > 0) {
      setRecentFailures((prev) => [...prev, ...failuresThisRun]);
    }
    // Reset combine-mode state so the next batch starts clean.
    if (combineMode) {
      setCombineMode(false);
      setCombinedName("");
    }
    // Touch anyFailed so the linter doesn't complain about an unused var
    // (we keep the flag because it documents intent at each catch site).
    void anyFailed;
  }

  return (
    <div className="space-y-5">
      {/* Continuous-scan banner: appears after the first successful upload
          in this page session. Tells the user that previous scans are off
          to the AI, and gives them a one-tap path to the inbox without
          forcing them off /upload. */}
      {recentFailures.length > 0 && (
        <div className="surface bg-destructive/5 border-destructive/30 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-bold text-destructive uppercase tracking-wide">
              {recentFailures.length === 1
                ? "1 file failed in your last scan"
                : `${recentFailures.length} files failed in your last scan`}
            </div>
            <button
              type="button"
              onClick={() => setRecentFailures([])}
              className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Dismiss all
            </button>
          </div>
          {recentFailures.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">{item.file.name}</div>
                <div className="text-destructive">
                  {item.error || "Unknown error"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    // Move it back into pending as a fresh queued item so
                    // the user can retry without re-picking the file.
                    setPending((p) => [
                      ...p,
                      {
                        id: crypto.randomUUID(),
                        file: item.file,
                        progress: "queued",
                      },
                    ]);
                    setRecentFailures((prev) =>
                      prev.filter((f) => f.id !== item.id)
                    );
                  }}
                  className="text-[11px] font-bold text-brand-purple hover:opacity-80 px-2 py-1"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setRecentFailures((prev) =>
                      prev.filter((f) => f.id !== item.id)
                    )
                  }
                  className="p-1 text-muted-foreground hover:text-foreground"
                  aria-label="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {recentDuplicates.length > 0 && (
        <div className="surface bg-amber-50 border-amber-300 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-bold text-amber-900 uppercase tracking-wide">
              {recentDuplicates.length === 1
                ? "1 duplicate skipped"
                : `${recentDuplicates.length} duplicates skipped`}
            </div>
            <button
              type="button"
              onClick={() => setRecentDuplicates([])}
              className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Dismiss all
            </button>
          </div>
          {recentDuplicates.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <div className="min-w-0 truncate">
                <span className="font-semibold">{d.fileName}</span>{" "}
                <span className="text-amber-800">already in Paperfile</span>
              </div>
              <Link
                href={`/document/${d.existingId}`}
                className="text-[11px] font-bold text-brand-purple hover:opacity-80 shrink-0"
              >
                Open original →
              </Link>
            </div>
          ))}
        </div>
      )}

      {sessionUploaded > 0 && (
        <div className="surface bg-brand-green/5 border-brand-green/20 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <CheckCircle2 className="h-4 w-4 text-brand-green shrink-0" />
            <span className="truncate">
              <span className="font-bold text-brand-green">
                {sessionUploaded}{" "}
                {sessionUploaded === 1 ? "document" : "documents"}
              </span>{" "}
              uploaded this session
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              href="/inbox"
              className="text-xs font-bold text-brand-purple hover:opacity-80 inline-flex items-center gap-1"
            >
              View inbox
              <ArrowRight className="h-3 w-3" />
            </Link>
            <button
              type="button"
              onClick={() => setSessionUploaded(0)}
              className="p-1 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
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
          accept="application/pdf,image/*,text/csv,text/xml,application/xml,.csv,.xml,.tsv,.txt"
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
