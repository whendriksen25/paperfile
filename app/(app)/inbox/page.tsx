import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { DocumentCard } from "@/components/inbox/document-card";
import { ProcessingBanner } from "@/components/inbox/processing-banner";
import { ProfileSelector } from "@/components/layout/profile-selector";
import { ExportToDropboxButton } from "@/components/inbox/export-button";
import { Search } from "lucide-react";
import { titleCase } from "@/lib/utils/format";
import type { DocumentRow, ProfileRow } from "@/types/document";

export const dynamic = "force-dynamic";

type GroupKey = "none" | "profile" | "type" | "month";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    batch?: string;
    profile_id?: string;
    type?: string;
    group?: string;
  }>;
}) {
  const sp = await searchParams;
  const group: GroupKey =
    sp.group === "profile" ||
    sp.group === "type" ||
    sp.group === "month"
      ? sp.group
      : "none";
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

      {/* Live AI processing banner (auto-refreshes inbox when work completes) */}
      <ProcessingBanner />

      {/* Group-by selector (preserves the other query params) */}
      <div className="surface p-4 mb-5">
        <div className="section-label mb-3">Group documents by</div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              { key: "none", label: "None (date)" },
              { key: "profile", label: "Profile" },
              { key: "type", label: "Document type" },
              { key: "month", label: "Month" },
            ] as { key: GroupKey; label: string }[]
          ).map((opt) => {
            const params = new URLSearchParams();
            if (sp.batch) params.set("batch", sp.batch);
            if (sp.profile_id) params.set("profile_id", sp.profile_id);
            if (sp.type) params.set("type", sp.type);
            if (opt.key !== "none") params.set("group", opt.key);
            const href =
              params.toString().length > 0
                ? `/inbox?${params.toString()}`
                : "/inbox";
            const active = group === opt.key;
            return (
              <Link
                key={opt.key}
                href={href}
                className={`pill border transition-colors ${
                  active
                    ? "bg-brand-charcoal text-white border-brand-charcoal"
                    : "bg-white text-foreground border-border hover:bg-muted"
                }`}
              >
                {opt.label}
              </Link>
            );
          })}
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
      ) : group === "none" ? (
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
      ) : (
        <GroupedDocs docs={docs} profilesById={profilesById} group={group} />
      )}
    </div>
  );
}

/**
 * Groups documents by profile / document_type / month and renders each group
 * as a labelled section. Sort within each group is preserved from the
 * original query (created_at desc).
 */
function GroupedDocs({
  docs,
  profilesById,
  group,
}: {
  docs: DocumentRow[];
  profilesById: Map<number, ProfileRow>;
  group: Exclude<GroupKey, "none">;
}) {
  const buckets = new Map<string, { label: string; docs: DocumentRow[] }>();

  for (const doc of docs) {
    let key: string;
    let label: string;
    if (group === "profile") {
      const p = doc.primary_profile_id
        ? profilesById.get(doc.primary_profile_id)
        : null;
      key = p ? `p_${p.id}` : "p_none";
      label = p?.name || "Unassigned";
    } else if (group === "type") {
      key = doc.document_type || "_none";
      label = doc.document_type ? titleCase(doc.document_type) : "Unclassified";
    } else {
      // group === "month"
      const d = doc.document_date || doc.created_at;
      const dt = d ? new Date(d) : null;
      if (dt && !isNaN(dt.getTime())) {
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        key = `${yyyy}-${mm}`;
        label = dt.toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        });
      } else {
        key = "_undated";
        label = "Undated";
      }
    }

    const bucket = buckets.get(key) || { label, docs: [] };
    bucket.docs.push(doc);
    buckets.set(key, bucket);
  }

  // Stable order: by group size desc, then label asc — except for the
  // "Unassigned" / "Unclassified" buckets which always go last.
  const entries = Array.from(buckets.entries()).sort(([ka, a], [kb, b]) => {
    const aLast = ka === "p_none" || ka === "_none" || ka === "_undated";
    const bLast = kb === "p_none" || kb === "_none" || kb === "_undated";
    if (aLast && !bLast) return 1;
    if (!aLast && bLast) return -1;
    if (group === "month") return kb.localeCompare(ka); // newest month first
    if (b.docs.length !== a.docs.length) return b.docs.length - a.docs.length;
    return a.label.localeCompare(b.label);
  });

  return (
    <div className="space-y-6">
      {entries.map(([key, bucket]) => (
        <section key={key}>
          <header className="flex items-baseline justify-between mb-3 px-1">
            <h2 className="text-base font-extrabold tracking-tight">
              {bucket.label}
            </h2>
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {bucket.docs.length}{" "}
              {bucket.docs.length === 1 ? "document" : "documents"}
            </span>
          </header>
          <div className="grid gap-3">
            {bucket.docs.map((doc) => (
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
        </section>
      ))}
    </div>
  );
}
