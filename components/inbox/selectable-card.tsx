"use client";

import { DocumentCard } from "./document-card";
import { useSelectMode } from "./select-mode-context";
import type { DocumentRow, ProfileRow } from "@/types/document";
import { Check } from "lucide-react";

/**
 * Wraps DocumentCard so it participates in inbox multi-select mode.
 *
 *  - Not in select mode → pure passthrough; clicking the card navigates
 *    as normal (the underlying <Link> handles navigation).
 *  - In select mode → renders a checkbox overlay in the top-left of the
 *    card AND intercepts clicks on the whole card area to toggle
 *    selection instead of navigating. Clear visual: a thick purple
 *    border + tinted background when selected.
 */
export function SelectableCard({
  doc,
  profile,
}: {
  doc: DocumentRow;
  profile: ProfileRow | null;
}) {
  const { selectMode, selected, toggle } = useSelectMode();
  const isSelected = selected.has(doc.id);

  if (!selectMode) {
    return <DocumentCard doc={doc} profile={profile} />;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(doc.id);
      }}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          toggle(doc.id);
        }
      }}
      className={`relative cursor-pointer transition-all rounded-2xl ${
        isSelected
          ? "ring-2 ring-brand-purple bg-brand-purple/5"
          : "ring-1 ring-transparent hover:ring-border"
      }`}
    >
      {/* Checkbox overlay — pointer-events-none so clicks pass through
          to the wrapper div above, which handles the selection toggle. */}
      <div
        className={`absolute top-3 left-3 z-10 h-5 w-5 rounded border-2 flex items-center justify-center pointer-events-none transition-colors ${
          isSelected
            ? "bg-brand-purple border-brand-purple"
            : "bg-white/90 border-border"
        }`}
      >
        {isSelected && <Check className="h-3.5 w-3.5 text-white" />}
      </div>
      {/* Block pointer events on the underlying card so its <Link> doesn't
          eat the click. We add an invisible overlay on top of the card
          area to capture all clicks. */}
      <div className="pointer-events-none">
        <DocumentCard doc={doc} profile={profile} />
      </div>
    </div>
  );
}
