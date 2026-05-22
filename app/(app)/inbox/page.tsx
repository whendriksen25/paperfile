import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ProcessingBanner } from "@/components/inbox/processing-banner";
import { NeedsReviewBanner } from "@/components/inbox/needs-review-banner";
import { InboxInfiniteList } from "@/components/inbox/infinite-list";
import { ProfileSelector } from "@/components/layout/profile-selector";
import { ExportToDropboxButton } from "@/components/inbox/export-button";
import { SanityCheckButton } from "@/components/inbox/sanity-check-button";
import { SearchInput } from "@/components/inbox/search-input";
import { SelectModeProvider } from "@/components/inbox/select-mode-context";
import { InboxBulkControls } from "@/components/inbox/inbox-bulk-controls";
import { SelectableCard } from "@/components/inbox/selectable-card";
import { titleCase } from "@/lib/utils/format";
import {
  INBOX_CARD_FIELDS,
  INBOX_PAGE_SIZE,
  reshapeInboxRow,
} from "@/lib/queries/inbox";
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
    needs_review?: string;
    q?: string;
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

  // When grouping is on, we need the full visible set to bucket correctly,
  // so we fetch a larger batch (200 max). When grouping is off we render
  // the first INBOX_PAGE_SIZE (10) server-side and let the client stream
  // more via IntersectionObserver in InboxInfiniteList.
  const initialLimit = group === "none" ? INBOX_PAGE_SIZE : 200;

  let q = supabase
    .from("documents")
    .select(INBOX_CARD_FIELDS)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .limit(initialLimit);

  // ?needs_review=1 is the global triage view — it MUST ignore the active
  // profile filter, otherwise an unassigned doc (profile_id=null) is hidden
  // by an "I'm currently looking at Father" filter and the user just sees
  // the count without ever finding the doc.
  const triage = sp.needs_review === "1";

  // Compute the search query up-front. When the user is actively searching
  // we deliberately IGNORE the active profile filter so the search spans the
  // WHOLE archive. Otherwise a search runs scoped to the currently-selected
  // profile (default "Me"), so a query like "Ekoplaza" returns nothing
  // because those receipts are filed under "Pa" — the #1 "search finds
  // nothing" trap. (Same spirit as the triage view ignoring the filter.)
  const searchQuery = (sp.q || "").trim();

  if (sp.batch) q = q.eq("batch", sp.batch);
  if (sp.profile_id && !triage && !searchQuery) {
    q = q.eq("primary_profile_id", Number(sp.profile_id));
  }
  if (sp.type) q = q.eq("document_type", sp.type);
  if (triage) {
    q = q.or("primary_profile_id.is.null,needs_review.eq.true");
  }
  // Search: uses the existing `fts` GIN index (same machinery as /search).
  // websearch syntax accepts quoted phrases and AND/OR semantics naturally.
  if (searchQuery) {
    q = q.textSearch("fts", searchQuery, {
      type: "websearch",
      config: "simple",
    });
  }

  // Category counts come from a server-side GROUP BY function instead of
  // shipping N rows over the wire. RLS-scoped via SECURITY INVOKER.
  const [{ data, error }, { data: profileData }, { data: countsData }] =
    await Promise.all([
      q,
      supabase.from("profiles").select("*"),
      supabase.rpc("documents_type_counts"),
    ]);

  // Reshape so DocumentCard can keep reading doc.extracted_fields.payment_status
  // — same shape as before, just without the heavy ocr_text/full JSONB.
  const docs = ((data || []) as unknown as Array<Record<string, unknown>>).map(
    reshapeInboxRow
  );
  // Cursor for the infinite-scroll loader. Null when this initial page already
  // contains all matching docs (or when grouping is on — grouping fetches up
  // to 200 in one go and doesn't paginate).
  const initialNextCursor =
    group === "none" && docs.length === initialLimit
      ? docs[docs.length - 1].created_at
      : null;
  const profilesById = new Map(
    ((profileData || []) as ProfileRow[]).map((p) => [p.id, p])
  );

  const categories = ((countsData || []) as { document_type: string; n: number }[])
    .map((r) => [r.document_type, Number(r.n)] as [string, number]);

  // Selection state is cleared whenever the inbox filters change — the
  // resetKey is a stable string derived from the active search params.
  const resetKey = `${sp.profile_id || "all"}:${sp.type || "all"}:${sp.batch || "all"}:${sp.needs_review || "0"}:${searchQuery || "all"}`;
  const profilesArray = (profileData || []) as ProfileRow[];

  return (
    <SelectModeProvider resetKey={resetKey}>
    <div className="px-5 md:px-10 py-6 md:py-10 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight">
            {triage ? "Needs review" : "File it"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {docs.length} {docs.length === 1 ? "document" : "documents"}
            {triage ? " awaiting confirmation" : ""}
            {sp.type ? ` of type "${titleCase(sp.type)}"` : ""}
            {sp.batch ? ` in batch "${sp.batch}"` : ""}.
            {triage && (
              <>
                {" · "}
                <Link
                  href="/inbox"
                  className="text-brand-purple font-semibold hover:underline"
                >
                  Back to all
                </Link>
              </>
            )}
          </p>
        </header>
        <div className="flex items-center gap-3 flex-wrap">
          <SanityCheckButton />
          <ExportToDropboxButton
            type={sp.type || null}
            profileId={sp.profile_id ? Number(sp.profile_id) : null}
            batch={sp.batch || null}
          />
          {/* Bulk multi-select controls — sits LEFT of the profile filter
              per UX preference. Idle: "Select" button. Active: target
              profile picker + Move N docs. */}
          <InboxBulkControls profiles={profilesArray} />
          <ProfileSelector />
        </div>
      </div>

      {/* Live AI processing banner (auto-refreshes inbox when work completes) */}
      <ProcessingBanner />

      {/* Triage banner — always visible regardless of profile filter, so
          unassigned scans don't get hidden behind a Father/LLC/Wife filter */}
      <NeedsReviewBanner />

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
        <SearchInput />
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
        // The `key` forces React to fully remount the infinite-scroll list
        // when the active filters change. Without it, the component's
        // useState(initialDocs) only fires on first mount and switching
        // filter (e.g. Pa → Suus) leaves stale Pa cards on screen even
        // though the server returns the right Suus docs.
        <InboxInfiniteList
          key={`inbox:${sp.profile_id || "all"}:${sp.type || "all"}:${sp.batch || "all"}:${sp.needs_review || "0"}:${searchQuery || "all"}`}
          initialDocs={docs}
          initialNextCursor={initialNextCursor}
          pageSize={INBOX_PAGE_SIZE}
          filters={{
            type: sp.type || null,
            profile_id: sp.profile_id || null,
            batch: sp.batch || null,
            needs_review: sp.needs_review || null,
            q: searchQuery || null,
          }}
          profilesById={Object.fromEntries(profilesById)}
        />
      ) : (
        <GroupedDocs docs={docs} profilesById={profilesById} group={group} />
      )}
    </div>
    </SelectModeProvider>
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
              <SelectableCard
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
