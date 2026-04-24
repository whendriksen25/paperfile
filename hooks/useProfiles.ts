"use client";

import { useEffect, useState, useCallback } from "react";
import type { ProfileRow } from "@/types/document";

const STORAGE_KEY = "archive.activeProfileId";

export function useProfiles() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [activeId, setActiveIdInternal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/profiles");
    const json = await res.json();
    const list = (json.data || []) as ProfileRow[];
    setProfiles(list);
    setLoading(false);

    // Pick active: stored > default > first
    const stored =
      typeof window !== "undefined"
        ? Number(window.localStorage.getItem(STORAGE_KEY)) || null
        : null;
    const def = list.find((p) => p.is_default) || list[0] || null;
    const chosen = stored && list.find((p) => p.id === stored) ? stored : def?.id || null;
    setActiveIdInternal(chosen);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setActiveId = useCallback((id: number | null) => {
    setActiveIdInternal(id);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem(STORAGE_KEY, String(id));
      else window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const active = profiles.find((p) => p.id === activeId) || null;

  return { profiles, active, activeId, setActiveId, loading, reload: load };
}
