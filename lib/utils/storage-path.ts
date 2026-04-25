import { titleCase } from "./format";

/**
 * Breakdown of a Dropbox storage path into the bits we want to display.
 * Paths look like:
 *   /Archive/_inbox/1745543210_foo.jpg                       (staged)
 *   /Archive/Father/2026/medical_bill/foo.jpg                (filed)
 *   /Archive/_unsorted/foo.jpg                               (couldn't classify)
 */
export interface ParsedStoragePath {
  /** The original path, unchanged. */
  raw: string;
  /** Human-friendly breadcrumb segments (already titled). Excludes the filename. */
  breadcrumb: string[];
  /** True if the file is still in the inbox staging folder. */
  inInbox: boolean;
  /** True if the file is in the catch-all _unsorted folder. */
  unsorted: boolean;
  /** Just the filename (last segment). */
  filename: string;
}

export function parseStoragePath(path: string | null | undefined): ParsedStoragePath {
  const raw = path || "";
  if (!raw) {
    return {
      raw,
      breadcrumb: [],
      inInbox: false,
      unsorted: false,
      filename: "",
    };
  }
  const parts = raw.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  const folders = parts.slice(0, -1);

  const inInbox = folders.includes("_inbox");
  const unsorted = folders.includes("_unsorted");

  // Drop leading root folder name (e.g. "Archive") and underscored buckets we
  // present specially below.
  const breadcrumb = folders
    .filter((p) => p !== "_inbox" && p !== "_unsorted")
    .map((p) => titleCase(p.replace(/_/g, " ")));

  return { raw, breadcrumb, inInbox, unsorted, filename };
}

/** Render-ready short label, e.g. "Father › 2026 › Medical Bill". */
export function storagePathLabel(path: string | null | undefined): string {
  const parsed = parseStoragePath(path);
  if (parsed.inInbox) return "Inbox (not yet filed)";
  if (parsed.unsorted) return "Unsorted";
  // Drop the first segment if it's the root name like "Archive".
  const segments = parsed.breadcrumb.slice(1);
  if (segments.length === 0) return parsed.breadcrumb.join(" › ");
  return segments.join(" › ");
}
