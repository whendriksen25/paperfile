"use client";

import { useState } from "react";
import Link from "next/link";
import { Images, ArrowUpRightFromSquare } from "lucide-react";

/**
 * Renders the original multi-receipt scan on a parent doc's detail page,
 * with each child receipt's polygon overlaid in colour and clickable.
 *
 * The parent doc's main `dropbox_path` is one of the receipt crops
 * (typically `_part1.jpg`), so the standard preview pane shows just
 * that single receipt. Users want to see the FULL original mosaic too
 * — to verify the split, jump between siblings, and understand the
 * spatial relationship that the numbering (#1..#N) doesn't convey.
 *
 * Data flow: the page server component looks up the parent's
 * `extracted_fields._multidoc.polygons` (set by the analyze pipeline
 * when the split was made) and pairs them with the child doc ids by
 * index. We render via the existing /api/documents/[id]/preview route
 * with ?original=1, which streams the original full scan instead of
 * the current dropbox_path.
 *
 * SVG overlays use the same viewBox as the image (0..1 normalised
 * polygon coords map directly), so the polygons stay aligned regardless
 * of the displayed image size. Each polygon is colour-coded and
 * labelled with its part number.
 */

export interface ChildPolygon {
  childId: string;
  vertices: { x: number; y: number }[];
  partNumber: number; // 1-based, matches the _partN.jpg in the filename
  sender?: string | null;
  amount?: number | null;
}

// Eight reasonable accent colours. Wraps for very large receipt counts.
const COLOURS = [
  "#7c3aed", // purple
  "#16a34a", // green
  "#dc2626", // red
  "#0891b2", // cyan
  "#ea580c", // orange
  "#7e22ce", // violet
  "#65a30d", // lime
  "#be123c", // rose
];

export function OriginalScanViewer({
  parentDocId,
  childPolygons,
  totalReceipts,
}: {
  parentDocId: string;
  childPolygons: ChildPolygon[];
  totalReceipts: number;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Image dimensions, only used to know aspect ratio for the SVG. We
  // wait for the image to load so we can size the SVG to match.
  const [naturalSize, setNaturalSize] = useState<{
    w: number;
    h: number;
  } | null>(null);

  const aspectRatio = naturalSize
    ? `${naturalSize.w} / ${naturalSize.h}`
    : "auto";

  return (
    <div className="surface bg-brand-purple/5 border-brand-purple/30 p-4">
      <div className="flex items-start gap-3 mb-3">
        <Images className="h-5 w-5 text-brand-purple shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold">
            Original multi-receipt scan
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalReceipts} {totalReceipts === 1 ? "receipt" : "receipts"}{" "}
            detected on this scan. Hover a polygon to highlight its
            child; click to open.
          </p>
        </div>
      </div>

      <div
        className="relative w-full rounded-md overflow-hidden border border-border bg-white"
        style={{ aspectRatio }}
      >
        {/* The original full-scan image. /preview?original=1 streams the
            file at extracted_fields._original_scan_path. */}
        <img
          src={`/api/documents/${parentDocId}/preview?original=1`}
          alt={`Original scan with ${totalReceipts} receipts`}
          className="absolute inset-0 w-full h-full object-contain"
          onLoad={(e) => {
            const img = e.currentTarget;
            setNaturalSize({
              w: img.naturalWidth,
              h: img.naturalHeight,
            });
          }}
        />

        {/* SVG overlay with the polygons. viewBox is 0..1 so polygon
            normalised coords plot directly. */}
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
        >
          {childPolygons.map((cp, i) => {
            const colour = COLOURS[i % COLOURS.length];
            const isHovered = hoveredId === cp.childId;
            const points = cp.vertices
              .map((v) => `${v.x},${v.y}`)
              .join(" ");
            // Centroid for placing the label.
            const cx =
              cp.vertices.reduce((s, v) => s + v.x, 0) /
              Math.max(1, cp.vertices.length);
            const cy =
              cp.vertices.reduce((s, v) => s + v.y, 0) /
              Math.max(1, cp.vertices.length);
            return (
              <g key={cp.childId}>
                {/* Click target — wraps the polygon + label in a Link */}
                <a
                  href={`/document/${cp.childId}`}
                  onMouseEnter={() => setHoveredId(cp.childId)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{ cursor: "pointer" }}
                >
                  <polygon
                    points={points}
                    fill={colour}
                    fillOpacity={isHovered ? 0.35 : 0.12}
                    stroke={colour}
                    strokeWidth={isHovered ? 0.006 : 0.004}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Centred number label, scaled inversely so it stays
                      readable regardless of image size. */}
                  <text
                    x={cx}
                    y={cy}
                    fill={colour}
                    fontSize="0.05"
                    fontWeight="bold"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{
                      paintOrder: "stroke",
                      stroke: "white",
                      strokeWidth: 0.012,
                    }}
                  >
                    {cp.partNumber}
                  </text>
                </a>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Below the image: a compact legend. Clicking jumps to the child. */}
      <ul className="mt-3 grid sm:grid-cols-2 gap-1.5">
        {childPolygons.map((cp, i) => {
          const colour = COLOURS[i % COLOURS.length];
          return (
            <li key={cp.childId}>
              <Link
                href={`/document/${cp.childId}`}
                className="flex items-center gap-2 text-xs hover:bg-muted/40 rounded px-2 py-1.5 transition-colors"
                onMouseEnter={() => setHoveredId(cp.childId)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <span
                  className="inline-block h-3 w-3 rounded-sm shrink-0"
                  style={{ backgroundColor: colour }}
                  aria-hidden
                />
                <span className="font-mono font-bold text-foreground">
                  #{cp.partNumber}
                </span>
                <span className="text-muted-foreground truncate">
                  {cp.sender || "—"}
                  {cp.amount != null
                    ? ` · €${cp.amount.toFixed(2)}`
                    : ""}
                </span>
                <ArrowUpRightFromSquare className="h-3 w-3 text-muted-foreground ml-auto shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
