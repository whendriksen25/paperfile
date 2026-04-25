"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, User, Building2, Plus } from "lucide-react";
import { useProfiles } from "@/hooks/useProfiles";
import { cn } from "@/lib/utils/cn";

/**
 * Top-right profile picker. Two responsibilities:
 *
 *  1. Stores the user's chosen profile in localStorage (via useProfiles).
 *  2. On pages that filter by profile (today: /inbox), keeps the URL's
 *     ?profile_id= query in sync with the active profile, so the
 *     server-rendered list reloads to show only that profile's documents.
 *
 * On other pages, picking a profile only updates the stored selection — the
 * filter kicks in next time the user lands on /inbox.
 */
export function ProfileSelector() {
  const { profiles, active, activeId, setActiveId, loading } = useProfiles();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** Pages where the profile selector should drive the URL filter. */
  const filtersUrl = pathname === "/inbox";

  /**
   * Whenever the active profile changes (or we land on /inbox), make sure the
   * URL's ?profile_id matches. We only rewrite the URL if the value would
   * actually change — avoids an infinite loop.
   */
  useEffect(() => {
    if (!filtersUrl || loading) return;
    const current = searchParams.get("profile_id");
    const desired = activeId ? String(activeId) : null;
    if (current === desired) return;

    const params = new URLSearchParams(searchParams.toString());
    if (desired) params.set("profile_id", desired);
    else params.delete("profile_id");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [filtersUrl, activeId, loading, pathname, router, searchParams]);

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground px-3 py-2">Loading…</div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-border shadow-soft hover:shadow-card text-sm transition-all"
      >
        {active?.type === "business" ? (
          <Building2 className="h-3.5 w-3.5 text-brand-purple" />
        ) : (
          <User className="h-3.5 w-3.5 text-brand-purple" />
        )}
        <span className="font-semibold truncate max-w-[140px]">
          {active?.name || "All profiles"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 mt-2 w-64 surface p-2 z-50 animate-fade-in">
            <div className="px-2 py-1 section-label">
              Filter by profile
            </div>
            <button
              onClick={() => {
                setActiveId(null);
                setOpen(false);
              }}
              className={cn(
                "w-full text-left px-3 py-2 rounded-full text-sm font-semibold hover:bg-muted",
                active === null && "bg-muted"
              )}
            >
              All profiles
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setActiveId(p.id);
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-full text-sm font-semibold hover:bg-muted flex items-center gap-2",
                  active?.id === p.id && "bg-muted"
                )}
              >
                {p.type === "business" ? (
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="truncate flex-1">{p.name}</span>
                {p.is_default && (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-brand-teal">
                    default
                  </span>
                )}
              </button>
            ))}
            <div className="border-t border-border mt-1 pt-1">
              <Link
                href="/profiles"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-full text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Manage profiles
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
