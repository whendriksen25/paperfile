import Link from "next/link";

/**
 * Visual chrome for the public-facing pages (homepage, privacy, terms).
 * Lightweight header + footer with no app sidebar. Used directly by the
 * homepage and via the (public) route-group layout for /privacy and /terms.
 *
 * Designed to be visually neutral so it can be restyled later without
 * touching the app shell.
 */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-5 md:px-10 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 font-extrabold text-lg"
          >
            <span className="h-7 w-7 rounded-xl bg-brand-gradient inline-block" />
            <span>Paperfile</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/privacy"
              className="px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              Terms
            </Link>
            <Link href="/login" className="ml-2 btn-primary text-xs !py-2 !px-4">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border mt-16">
        <div className="max-w-5xl mx-auto px-5 md:px-10 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <div>© {new Date().getFullYear()} Paperfile</div>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <a
              href="mailto:contact@paperfile.nl"
              className="hover:text-foreground"
            >
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
