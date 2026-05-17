import Link from "next/link";
import { ArrowUpRightFromSquare, Images } from "lucide-react";

/**
 * Banner shown at the TOP of a child doc's detail page to make its
 * origin obvious: this row is one of N receipts that were detected on
 * a single multi-receipt scan owned by a parent doc.
 *
 * The page already shows a "Part of an N-document scan" badge listing
 * every sibling — but that's a sibling-navigation widget. This banner
 * is specifically the "where did THIS doc come from" anchor: it links
 * directly to the original multi-receipt parent and (optionally)
 * describes the child's spatial position on the original scan
 * ("top-left of the original scan"), inferred from the saved
 * polygon centroid stashed on the parent's extracted_fields._multidoc.
 *
 * Renders nothing when parentDocId is falsy — the page can include
 * this component unconditionally and let it self-suppress.
 */
export function ParentScanBanner({
  parentDocId,
  parentSender,
  parentDate,
  parentDropboxPath,
  siblingPosition,
  siblingTotal,
  position,
}: {
  parentDocId: string | null | undefined;
  parentSender: string | null;
  parentDate: string | null;
  parentDropboxPath: string | null;
  siblingPosition: number;
  siblingTotal: number;
  position?:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "middle"
    | null;
}) {
  if (!parentDocId) return null;

  // Build a compact descriptor of the parent scan for the top line.
  // Prefer the parent's sender + date; if both are missing, fall back
  // to a generic label rather than emit "from null scan (null)".
  const parentLabelParts: string[] = [];
  if (parentSender) parentLabelParts.push(parentSender);
  if (parentDate) parentLabelParts.push(`(${parentDate})`);
  const parentDescriptor =
    parentLabelParts.length > 0
      ? parentLabelParts.join(" ")
      : "the original scan";

  const positionLabel = positionDescription(position);

  return (
    <div className="surface p-4 mb-5 bg-brand-purple/5 border-brand-purple/30">
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-full bg-brand-purple/15 flex items-center justify-center shrink-0">
          <Images className="h-4 w-4 text-brand-purple" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-brand-purple">
            Part {siblingPosition} of {siblingTotal} from {parentDescriptor}{" "}
            scan
          </div>
          {positionLabel && (
            <div className="text-xs text-brand-purple/80 mt-0.5">
              Originally {positionLabel} of the original scan.
            </div>
          )}
          {/* Show the parent's storage path in a muted line so a glance
             tells the user where the source image lives, without being
             the primary CTA. */}
          {parentDropboxPath && (
            <div className="text-[11px] text-muted-foreground font-mono mt-1 break-all">
              {parentDropboxPath}
            </div>
          )}
          <div className="mt-2.5">
            <Link
              href={`/document/${parentDocId}`}
              className="text-xs font-bold text-brand-purple hover:opacity-80 inline-flex items-center gap-1.5"
            >
              View original scan
              <ArrowUpRightFromSquare className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function positionDescription(
  pos:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "middle"
    | null
    | undefined
): string | null {
  switch (pos) {
    case "top-left":
      return "the top-left receipt";
    case "top-right":
      return "the top-right receipt";
    case "bottom-left":
      return "the bottom-left receipt";
    case "bottom-right":
      return "the bottom-right receipt";
    case "middle":
      return "the middle receipt";
    default:
      return null;
  }
}
