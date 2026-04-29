/**
 * Renders the actual file inline via /api/documents/{id}/preview
 * (server-side download from the storage adapter).
 *
 *  - PDFs render in an <iframe> (browser PDF viewer)
 *  - Images render in an <img> tag
 *  - Anything else falls back to a placeholder
 *
 * Used both on /document/[id] and /actions (in the focused-action panel)
 * so the user can review the doc inline without navigating away.
 */
export function DocumentPreview({
  id,
  fileName,
  fileType,
  className,
}: {
  id: string;
  fileName: string | null;
  fileType: string | null;
  className?: string;
}) {
  const url = `/api/documents/${id}/preview`;
  const ext = (fileName || "").toLowerCase();
  const mime = (fileType || "").toLowerCase();
  const isPdf = mime.includes("pdf") || ext.endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") ||
    /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(ext);

  if (isPdf) {
    return (
      <iframe
        src={url}
        title={fileName || "Document preview"}
        className={
          className ||
          "rounded-2xl bg-muted w-full h-[480px] border border-border"
        }
      />
    );
  }
  if (isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={fileName || "Document preview"}
        className={
          className ||
          "rounded-2xl bg-muted w-full max-h-[600px] object-contain border border-border"
        }
      />
    );
  }
  return (
    <div className="rounded-2xl bg-muted aspect-[4/3] flex items-center justify-center text-muted-foreground text-xs">
      Preview not available — open the file to view.
    </div>
  );
}
