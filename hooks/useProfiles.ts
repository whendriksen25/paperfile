"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ProfileRow } from "@/types/document";

const STORAGE_KEY = "archive.activeProfileId";

/**
 * Shared profile-selection store.
 *
 * Every component that calls useProfiles() sees the SAME profiles list and
 * the SAME active selection. This used to be per-component useState: the
 * header chip updated its own copy and localStorage, but pages holding
 * their own copy (e.g. the Action Center) never re-rendered — switching
 * profile appeared to do nothing until a full page reload.
 */

interface ProfilesState {
  profiles: ProfileRow[];
  activeId: number | null;
  loading: boolean;
}

let state: ProfilesState = { profiles: [], activeId: null, loading: true };
let started = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<ProfilesState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

async function loadShared() {
  setState({ loading: true });
  try {
    const res = await fetch("/api/profiles");
    const json = await res.json();
    const list = (json.data || []) as ProfileRow[];

    // Pick active: stored > default > first
    const stored =
      typeof window !== "undefined"
        ? Number(window.localStorage.getItem(STORAGE_KEY)) || null
        : null;
    const def = list.find((p) => p.is_default) || list[0] || null;
    const chosen =
      stored && list.find((p) => p.id === stored) ? stored : def?.id ?? null;

    setState({ profiles: list, activeId: chosen, loading: false });
  } catch {
    setState({ loading: false });
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!started) {
    started = true;
    loadShared();
    // Cross-tab sync: picking a profile in another tab updates this one.
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        setState({ activeId: e.newValue ? Number(e.newValue) || null : null });
      }
    });
  }
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ProfilesState {
  return state;
}

const serverSnapshot: ProfilesState = {
  profiles: [],
  activeId: null,
  loading: true,
};
function getServerSnapshot(): ProfilesState {
  return serverSnapshot;
}

export function useProfiles() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setActiveId = useCallback((id: number | null) => {
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(STORAGE_KEY, String(id));
      else window.localStorage.removeItem(STORAGE_KEY);
    }
    setState({ activeId: id });
  }, []);

  const active = s.profiles.find((p) => p.id === s.activeId) || null;

  return {
    profiles: s.profiles,
    active,
    activeId: s.activeId,
    setActiveId,
    loading: s.loading,
    reload: loadShared,
  };
}
