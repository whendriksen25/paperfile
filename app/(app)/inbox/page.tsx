import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { DocumentCard } from "@/components/inbox/document-card";
import { ProfileSelector } from "@/components/layout/profile-selector";
import { ExportToDropboxButton } from "@/components/inbox/export-button";
import { Search } from "lucide-react";
import { titleCase } from "@/lib/utils/format";
import type { DocumentRow, ProfileRow } from "@/types/document";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string; profile_id?: string; type?: string }>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  let q = supabase
    .from("documents")
    .select("*")
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(200);

  if (sp.batch) q = q.eq("batch", sp.batch);
  if (sp.profile_id) q = q.eq("primary_profile_id", Number(sp.profile_id));
  if (sp.type) q = q.eq("document_type", sp.type);

  const [{ data, error }, { data: profileData }, { data: typeData }] =
    await Promise.all([
      q,
      supabase.from("profiles").select("*"),
      supabase
        .from("documents")
        .select("document_type")
        .neq("status", "deleted")
        .not("document_type", "is", null),
    ]);

  const docs = (data || []) as DocumentRow[];
  const profilesById = new Map(
    ((profileData || []) as ProfileRow[]).map((p) => [p.id, p])
  );

  // Build category counts (across ALL docs, not just the current filter)
  const categoryMap = new Map<string, number>();
  for (const r of (typeData || []) as { document_type: string | null }[]) {
    if (r.document_type)
      categoryMap.set(r.document_type, (categoryMap.get(r.document_type) || 0) + 1);
  }
  const categories = Array.from(categoryMap.entries()).sort(
    (a, b) => b[1] - a[1]
  );

  return (
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight">File it</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {docs.length} {docs.length === 1 ? "document" : "documents"}
            {sp.type ? ` of type "${titleCase(sp.type)}"` : ""}
            {sp.batch ? ` in batch "${sp.batch}"` : ""}.
          </p>
        </header>
        <div className="flex items-center gap-3">
          <ExportToDropboxButton
            type={sp.type || null}
            profileId={sp.profile_id ? Number(sp.profile_id) : null}
            batch={sp.batch || null}
          />
          <ProfileSelector />
        </div>
      </div>

      {/* Categories filter row */}
      {categories.length > 0 && (
        <div className="surface p-4 mb-5">
          <div className="section-label mb-3">Browse by category</div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/inbox"
              className={`pill border transition-colors ${
                !sp.type
                  ? "bg-brand-charcoal text-white border-brand-charcoal"
                  : "bg-white text-foreground border-border hover:bg-muted"
              }`}
            >
              All <span className="opacity-60">{docs.length}</span>
            </Link>
            {categories.map(([type, count]) => (
              <Link
                key={type}
                href={`/inbox?type=${encodeURIComponent(type)}`}
                className={`pill border transition-colors ${
                  sp.type === type
                    ? "bg-brand-purple text-white border-brand-purple"
                    : "bg-white text-foreground border-border hover:bg-muted"
                }`}
              >
                {titleCase(type)} <span className="opacity-60">{count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="mb-5">
        <div className="relative">
          <Search className="h-4 w-4 text-muted-foreground absolute left-4 top-1/2 -translate-y-1/2" />
          <input
            placeholder="Search documents…"
            className="input-pill pl-11"
            disabled
          />
        </div>
      </div>

      {error ? (
        <div className="surface p-6 text-sm text-destructive">
          Could not load documents: {error.message}
        </div>
      ) : docs.length === 0 ? (
        <div className="surface p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No documents yet. Head to{" "}
            <a href="/upload" className="text-brand-purple font-bold underline">
              Scan it
            </a>{" "}
            to add the first one.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {docs.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              profile={
                doc.primary_profile_id
                  ? profilesById.get(doc.primary_profile_id) || null
                  : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
