import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user category-token glossary.
 *
 * Used to deduplicate the free-text subcategory tokens Claude invents
 * inside line_items.category_path. Without this, "apple", "apples",
 * "Apple" and "appel" all show up as separate buckets in the spend
 * report. With this, every variant is silently rewritten to the same
 * canonical token before being stored.
 *
 * Three entry points:
 *   - canonicaliseToken — single token, returns the canonical form
 *   - canonicalisePath — whole category_path array, returns the
 *     canonical version (first element kept as-is — it's one of the
 *     fixed 25 top-category keys, no drift to dedupe there)
 *   - listTaxonomy — for the prompt hint and the cleanup CLI
 */

/** Lowercase, strip diacritics, replace runs of non-alphanumeric with "_". */
export function normalizeToken(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
}

/** Very simple stemming — drop common plural endings. English-leaning
 * but works for Dutch loanwords often enough. */
export function singularize(s: string): string {
  if (s.length <= 3) return s;
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y";
  if (s.endsWith("sses")) return s.slice(0, -2);
  if (s.endsWith("ches") || s.endsWith("shes")) return s.slice(0, -2);
  if (s.endsWith("xes") || s.endsWith("zes")) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us")) {
    return s.slice(0, -1);
  }
  return s;
}

/** Standard Levenshtein. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  // Single-row DP.
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Acceptable edit distance, scaled to token length so short tokens
 * aren't matched too loosely. */
function maxAcceptableEdits(s: string): number {
  if (s.length <= 4) return 1;
  if (s.length <= 7) return 2;
  return 3;
}

interface TaxonomyRow {
  id: string;
  top_category: string;
  token: string;
  aliases: string[];
  usage_count: number;
}

/**
 * Map a raw token (free-text from Claude) to its canonical form for
 * this user under this top-category. Registers a brand-new token if
 * nothing close exists.
 *
 * Resolution order:
 *  1. Exact normalized+singularized match against an existing canonical
 *  2. Exact match against any alias
 *  3. Edit distance within length-scaled threshold against any canonical
 *  4. Register as new canonical → return the singularized form
 */
export async function canonicaliseToken(
  admin: SupabaseClient,
  userId: string,
  topCategory: string,
  rawToken: string
): Promise<string> {
  const cleaned = singularize(normalizeToken(rawToken));
  if (!cleaned) return "";

  // Pull this user's taxonomy for this top-category. Personal scale —
  // tens to low hundreds of rows per top-category at most, fine to
  // load all + filter in memory rather than hitting Postgres with
  // each lookup variant.
  const { data: rows, error } = await admin
    .from("line_item_taxonomy")
    .select("id, top_category, token, aliases, usage_count")
    .eq("user_id", userId)
    .eq("top_category", topCategory);
  if (error) {
    console.warn("[taxonomy] load failed, returning cleaned token:", error);
    return cleaned;
  }
  const taxonomy = (rows || []) as TaxonomyRow[];

  // 1 & 2 — exact / alias match
  const direct = taxonomy.find(
    (r) => r.token === cleaned || r.aliases.includes(cleaned)
  );
  if (direct) {
    await bumpUsage(admin, direct.id, direct.usage_count);
    return direct.token;
  }

  // 3 — edit distance
  let best: { row: TaxonomyRow; distance: number } | null = null;
  for (const r of taxonomy) {
    const d = editDistance(cleaned, r.token);
    if (d <= maxAcceptableEdits(cleaned)) {
      if (!best || d < best.distance) best = { row: r, distance: d };
    }
  }
  if (best) {
    // Register the variant as an alias so next time it's an exact match.
    const newAliases = Array.from(new Set([...best.row.aliases, cleaned]));
    await admin
      .from("line_item_taxonomy")
      .update({
        aliases: newAliases,
        usage_count: best.row.usage_count + 1,
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", best.row.id);
    return best.row.token;
  }

  // 4 — register new
  const { error: insErr } = await admin.from("line_item_taxonomy").insert({
    user_id: userId,
    top_category: topCategory,
    token: cleaned,
    aliases: [],
    usage_count: 1,
  });
  if (insErr && !/duplicate/i.test(insErr.message)) {
    console.warn("[taxonomy] insert failed:", insErr.message);
  }
  return cleaned;
}

async function bumpUsage(
  admin: SupabaseClient,
  id: string,
  current: number
): Promise<void> {
  await admin
    .from("line_item_taxonomy")
    .update({
      usage_count: current + 1,
      last_seen_at: new Date().toISOString(),
    })
    .eq("id", id);
}

/**
 * Canonicalise an entire category_path. The first element is one of the
 * 25 canonical top-category keys (no drift possible there). Subsequent
 * elements are run through the taxonomy.
 */
export async function canonicalisePath(
  admin: SupabaseClient,
  userId: string,
  path: string[]
): Promise<string[]> {
  if (!Array.isArray(path) || path.length === 0) return [];
  const top = String(path[0] || "").toLowerCase().trim();
  if (!top) return [];
  const out: string[] = [top];
  for (let i = 1; i < path.length; i++) {
    const tok = String(path[i] || "").trim();
    if (!tok) break; // stop at first empty
    const canon = await canonicaliseToken(admin, userId, top, tok);
    if (canon) out.push(canon);
  }
  return out;
}

/** Same logic but lighter: only canonicalises against an in-memory
 * snapshot — for the backfill script that wants to avoid per-row DB
 * roundtrips. Returns just the rewritten path; the caller decides
 * whether/how to persist newly-discovered tokens. */
export function canonicalisePathInMemory(
  path: string[],
  taxonomyByTop: Map<string, TaxonomyRow[]>
): string[] {
  if (!Array.isArray(path) || path.length === 0) return [];
  const top = String(path[0] || "").toLowerCase().trim();
  if (!top) return [];
  const rows = taxonomyByTop.get(top) || [];
  const out: string[] = [top];
  for (let i = 1; i < path.length; i++) {
    const raw = String(path[i] || "").trim();
    if (!raw) break;
    const cleaned = singularize(normalizeToken(raw));
    if (!cleaned) continue;
    const direct = rows.find(
      (r) => r.token === cleaned || r.aliases.includes(cleaned)
    );
    if (direct) {
      out.push(direct.token);
      continue;
    }
    let best: { row: TaxonomyRow; distance: number } | null = null;
    for (const r of rows) {
      const d = editDistance(cleaned, r.token);
      if (d <= maxAcceptableEdits(cleaned)) {
        if (!best || d < best.distance) best = { row: r, distance: d };
      }
    }
    out.push(best ? best.row.token : cleaned);
  }
  return out;
}

/**
 * Snapshot of the taxonomy for a user, grouped by top_category. Used
 * by the prompt-hint builder and the backfill script.
 */
export async function loadTaxonomySnapshot(
  admin: SupabaseClient,
  userId: string
): Promise<Map<string, TaxonomyRow[]>> {
  const { data, error } = await admin
    .from("line_item_taxonomy")
    .select("id, top_category, token, aliases, usage_count")
    .eq("user_id", userId)
    .order("usage_count", { ascending: false })
    .limit(5000);
  const byTop = new Map<string, TaxonomyRow[]>();
  if (error) return byTop;
  for (const r of (data || []) as TaxonomyRow[]) {
    const arr = byTop.get(r.top_category) || [];
    arr.push(r);
    byTop.set(r.top_category, arr);
  }
  return byTop;
}

/**
 * Build a compact prompt fragment listing the user's existing taxonomy
 * so Claude can prefer reusing tokens it's already chosen. Roughly:
 *
 *   groceries: produce, fruit, apple, dairy, milk, ...
 *   pharmacy: pain_relief, ibuprofen, ...
 *
 * Capped at ~80 tokens per top-category to keep prompt size reasonable.
 */
export function buildTaxonomyHint(
  snapshot: Map<string, TaxonomyRow[]>
): string {
  if (snapshot.size === 0) return "";
  const lines: string[] = [];
  for (const [top, rows] of Array.from(snapshot.entries())) {
    if (rows.length === 0) continue;
    const tokens = rows
      .slice(0, 80)
      .map((r) => r.token)
      .join(", ");
    lines.push(`  ${top}: ${tokens}`);
  }
  if (lines.length === 0) return "";
  return [
    "EXISTING TAXONOMY HINT — prefer reusing these subcategory tokens",
    "when an item fits, rather than inventing fresh variants. The format",
    "is one line per top-category followed by the tokens you've used",
    "before on this user's archive. Use these labels as-is (lowercase",
    "singular). Only invent a new subcategory token when the item",
    "genuinely doesn't fit any existing one.",
    "",
    ...lines,
  ].join("\n");
}
