import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PublicShell } from "@/components/layout/public-shell";
import {
  Sparkles,
  FolderInput,
  CheckCircle2,
  ListChecks,
  ScanLine,
} from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Public homepage at /. Logged-in users get sent straight to their inbox
 * (their typical landing target); logged-out visitors see the marketing
 * page — required by Google OAuth verification (the homepage URL must be
 * publicly accessible without sign-in).
 *
 * Visually neutral by design — Wim plans to redesign this. The structure
 * (header / hero / features / CTA / footer) and routing are what matters.
 */
export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/inbox");

  return (
    <PublicShell>
      {/* Hero */}
      <section className="px-5 md:px-10 py-16 md:py-24 max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand-purple bg-brand-purple/10 px-3 py-1.5 rounded-full mb-6">
          <Sparkles className="h-3.5 w-3.5" />
          Personal document archiver
        </div>
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight leading-[1.05]">
          Scan it. <span className="text-brand-gradient">File it.</span>{" "}
          Act on it.
        </h1>
        <p className="mt-5 text-base md:text-lg text-muted-foreground leading-relaxed max-w-xl mx-auto">
          Every bill, receipt, contract, and medical letter you ever scan —
          read by AI, filed in your own Dropbox, and turned into the right
          to-dos. Your paper, finally manageable.
        </p>
        <div className="mt-8 flex items-center justify-center gap-3">
          <Link href="/login" className="btn-cta">
            Get started
          </Link>
          <Link href="#how-it-works" className="btn-ghost text-sm">
            See how it works
          </Link>
        </div>
      </section>

      {/* Features grid */}
      <section
        id="how-it-works"
        className="px-5 md:px-10 py-12 md:py-16 max-w-5xl mx-auto"
      >
        <div className="grid md:grid-cols-2 gap-5">
          <Feature
            icon={<ScanLine className="h-5 w-5 text-brand-purple" />}
            title="Scan once, structured forever"
            body="Snap a photo from your phone or share a PDF. Paperfile reads the
            content — sender, amount, line items, due dates, even handwritten
            notes — and extracts it as searchable, structured data."
          />
          <Feature
            icon={<FolderInput className="h-5 w-5 text-brand-teal" />}
            title="Filed in your own Dropbox"
            body="Originals land in YOUR Dropbox under a clean folder structure
            (profile / year / type). You own the files, always. Paperfile only
            stores the metadata."
          />
          <Feature
            icon={<CheckCircle2 className="h-5 w-5 text-brand-green" />}
            title="Profiles that just work"
            body="Bills for Dad land under Dad. Receipts for the LLC land under
            the LLC. Paperfile cross-references identifiers like birth dates,
            IBANs, and patient numbers — no manual sorting."
          />
          <Feature
            icon={<ListChecks className="h-5 w-5 text-brand-blue" />}
            title="Actions, not just archives"
            body="Bills become 'pay by Friday' to-dos. Contracts become 'sign by
            the 15th'. Optionally push them to Google Tasks or your bookkeeping
            app — Paperfile keeps your inbox honest."
          />
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="px-5 md:px-10 py-16 md:py-24 max-w-3xl mx-auto text-center">
        <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight">
          Try it on one document
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          Free while in early access. No credit card required.
        </p>
        <div className="mt-6">
          <Link href="/login" className="btn-cta">
            Sign in
          </Link>
        </div>
      </section>
    </PublicShell>
  );
}

function Feature({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="surface p-6">
      <div className="h-10 w-10 rounded-2xl bg-brand-gradient-soft flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="text-base font-extrabold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
        {body}
      </p>
    </div>
  );
}
