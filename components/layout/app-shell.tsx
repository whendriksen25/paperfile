"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils/cn";
import {
  ScanLine,
  FolderCheck,
  CheckCircle2,
  Users,
  ListTree,
  Settings,
  LogOut,
} from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import Image from "next/image";
import { useEffect, useState } from "react";
import type { ProfileRow } from "@/types/document";

const core = [
  { href: "/upload", label: "Scan it", icon: ScanLine },
  { href: "/inbox", label: "File it", icon: FolderCheck },
  { href: "/actions", label: "Act on it", icon: CheckCircle2 },
];

const organization = [
  { href: "/profiles", label: "Profiles", icon: Users },
  { href: "/categories", label: "Categories", icon: ListTree },
  { href: "/settings", label: "Settings", icon: Settings },
];

const mobileNav = [
  { href: "/upload", label: "Scan", icon: ScanLine },
  { href: "/inbox", label: "Library", icon: FolderCheck },
  { href: "/actions", label: "Actions", icon: CheckCircle2 },
  { href: "/profiles", label: "Profiles", icon: Users },
];

interface User {
  email?: string | null;
}

/**
 * Renders the Paperfile brand asset. Tries /brand/paperfile-logo.png first;
 * if missing, falls back to the inline SVG Wordmark. The fallback covers the
 * "until-you-drop-the-PNG-in" state, and means the app never looks broken.
 */
function PaperfileBrand() {
  const [imgFailed, setImgFailed] = useState(false);
  if (imgFailed) {
    return <Wordmark tone="white" size={28} />;
  }
  return (
    <Image
      src="/brand/paperfile-logo.png"
      alt="Paperfile"
      width={1000}
      height={1000}
      priority
      className="block w-[90%] h-auto mx-auto"
      onError={() => setImgFailed(true)}
    />
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [user, setUser] = useState<User | null>(null);
  const [defaultProfile, setDefaultProfile] = useState<ProfileRow | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((j) => {
        const list = (j.data || []) as ProfileRow[];
        setDefaultProfile(list.find((p) => p.is_default) || list[0] || null);
      });
  }, [supabase]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = (user?.email || "Me")
    .split("@")[0]
    .split(/[._-]/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-background">
      {/* Desktop charcoal sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col bg-sidebar text-sidebar-foreground rounded-r-3xl m-3 ml-0 overflow-hidden">
        {/* Logo — spans the full sidebar width */}
        <div className="px-3 pt-4 pb-6">
          <Link href="/upload" className="block w-full">
            <PaperfileBrand />
          </Link>
        </div>

        {/* Nav sections */}
        <nav className="flex-1 px-4 space-y-6">
          <div>
            <div className="px-4 mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-sidebar-muted">
              Core Workflow
            </div>
            <div className="space-y-1">
              {core.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "side-link",
                      active ? "side-link-active" : "side-link-inactive"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>

          <div>
            <div className="px-4 mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-sidebar-muted">
              Organization
            </div>
            <div className="space-y-1">
              {organization.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "side-link",
                      active ? "side-link-active" : "side-link-inactive"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* User pill at bottom */}
        <div className="p-4">
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-full bg-white/5 border border-white/10">
            <div className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">
                {defaultProfile?.name || "You"}
              </div>
              <div className="text-[11px] text-brand-teal font-semibold">
                Paperfile
              </div>
            </div>
            <button
              onClick={signOut}
              title="Sign out"
              className="text-sidebar-muted hover:text-sidebar-foreground p-1"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 pb-24 md:pb-6">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card/95 backdrop-blur border-t border-border z-30 flex justify-around">
        {mobileNav.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-0.5 py-2.5 px-4 text-[10px] font-bold transition-colors",
                active ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
