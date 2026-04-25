import { PublicShell } from "@/components/layout/public-shell";

/**
 * Layout for public-facing pages — wraps children in the PublicShell so they
 * get the marketing-style header + footer instead of the authenticated app
 * sidebar. The homepage at app/page.tsx uses PublicShell directly because
 * it lives at the same route level (route groups can't both own "/").
 */
export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PublicShell>{children}</PublicShell>;
}
