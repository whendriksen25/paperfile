"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Shared client-side state for inbox multi-select mode.
 *
 * Two things live in here:
 *   - selectMode: whether checkboxes are visible / clicks toggle selection
 *   - selected: the set of currently-selected document IDs
 *
 * Consumed by:
 *   - InboxBulkControls (the toolbar toggle + bulk action area)
 *   - SelectableCard (the wrapper around each DocumentCard)
 *   - InboxInfiniteList (passes selection through to its cards)
 *
 * Selection clears automatically when the inbox filter URL changes —
 * leaving a doc selected after switching from "Pa" to "Suus" would be
 * surprising.
 */

interface SelectModeState {
  selectMode: boolean;
  setSelectMode: (on: boolean) => void;
  selected: Set<string>;
  toggle: (id: string) => void;
  selectMany: (ids: string[]) => void;
  clear: () => void;
}

const SelectModeContext = createContext<SelectModeState | null>(null);

export function SelectModeProvider({
  children,
  /** Used to clear selection when the URL search params change. */
  resetKey,
}: {
  children: React.ReactNode;
  resetKey?: string;
}) {
  const [selectMode, setSelectModeState] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Clear selection (and exit select mode) when the inbox filter changes.
  useEffect(() => {
    setSelected(new Set());
    setSelectModeState(false);
  }, [resetKey]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectMany = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const setSelectMode = useCallback((on: boolean) => {
    setSelectModeState(on);
    if (!on) setSelected(new Set());
  }, []);

  const value = useMemo<SelectModeState>(
    () => ({ selectMode, setSelectMode, selected, toggle, selectMany, clear }),
    [selectMode, setSelectMode, selected, toggle, selectMany, clear]
  );

  return (
    <SelectModeContext.Provider value={value}>
      {children}
    </SelectModeContext.Provider>
  );
}

/** Hook for consumers; returns a safe no-op state when outside the provider
 * so pages that don't wire up select mode still render normally. */
export function useSelectMode(): SelectModeState {
  const ctx = useContext(SelectModeContext);
  if (ctx) return ctx;
  return {
    selectMode: false,
    setSelectMode: () => {},
    selected: new Set(),
    toggle: () => {},
    selectMany: () => {},
    clear: () => {},
  };
}
