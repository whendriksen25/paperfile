import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileRow } from "@/types/document";

/**
 * Best-effort fuzzy match between a profile_hint string (the human name as it
 * appears on a document) and the user's existing profiles.
 *
 * Strategy:
 *   1. Exact name match (case insensitive) wins
 *   2. Otherwise: token overlap — count how many words from the hint appear
 *      in the profile name. Highest overlap wins, ties broken by length proximity.
 *   3. Returns null if no profile shares any token.
 */
export function matchProfileByHint(
  hint: string | null | undefined,
  profiles: ProfileRow[]
): ProfileRow | null {
  if (!hint || profiles.length === 0) return null;
  const h = hint.toLowerCase().trim();

  // 1. Exact match
  const exact = profiles.find((p) => p.name.toLowerCase().trim() === h);
  if (exact) return exact;

  // 2. Token overlap
  const hintTokens = new Set(
    h.split(/\W+/).filter((t) => t.length >= 2)
  );
  if (hintTokens.size === 0) return null;

  const hintArr = Array.from(hintTokens);
  let best: { profile: ProfileRow; score: number } | null = null;
  for (const p of profiles) {
    const pTokens = new Set(
      p.name
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length >= 2)
    );
    let overlap = 0;
    for (const t of hintArr) if (pTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    if (!best || overlap > best.score) {
      best = { profile: p, score: overlap };
    }
  }
  return best?.profile || null;
}

/**
 * Loads all profiles for the current user from a Supabase admin client.
 */
export async function listProfilesForUser(
  admin: SupabaseClient,
  userId: string
): Promise<ProfileRow[]> {
  const { data } = await admin
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("name");
  return (data || []) as ProfileRow[];
}

/**
 * Returns the user's default profile, creating one if none exists.
 */
export async function ensureDefaultProfile(
  admin: SupabaseClient,
  userId: string
): Promise<ProfileRow> {
  const profiles = await listProfilesForUser(admin, userId);
  const def = profiles.find((p) => p.is_default);
  if (def) return def;

  const fallback = profiles[0];
  if (fallback) return fallback;

  const { data, error } = await admin
    .from("profiles")
    .insert({
      user_id: userId,
      name: "Me",
      type: "person",
      is_default: true,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Failed to create default profile: ${error?.message}`);
  }
  return data as ProfileRow;
}
