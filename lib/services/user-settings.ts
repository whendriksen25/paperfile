import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Strongly-typed shape of the JSONB settings blob stored per user.
 * Add new fields here when you wire up future integrations.
 */
export interface UserSettings {
  bookkeeping_url?: string | null;
  bookkeeping_token?: string | null;
}

/** Fetch (or default) the current user's settings row. Never throws. */
export async function getUserSettings(
  client: SupabaseClient,
  userId: string
): Promise<UserSettings> {
  const { data } = await client
    .from("user_settings")
    .select("settings")
    .eq("user_id", userId)
    .maybeSingle();
  return ((data?.settings as UserSettings) || {}) as UserSettings;
}

/** Upsert the user's settings, merging on top of whatever's already stored. */
export async function saveUserSettings(
  client: SupabaseClient,
  userId: string,
  patch: Partial<UserSettings>
): Promise<UserSettings> {
  const existing = await getUserSettings(client, userId);
  const next = { ...existing, ...patch };
  await client
    .from("user_settings")
    .upsert(
      { user_id: userId, settings: next, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
  return next;
}
