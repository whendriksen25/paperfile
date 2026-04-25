import { createServiceClient } from "@/lib/supabase/server";
import {
  getUserSettings,
  saveUserSettings,
  type UserSettings,
} from "@/lib/services/user-settings";

/**
 * Minimal Google Tasks API client.
 *
 *  - Uses OAuth refresh-token flow stored in user_settings.google_oauth.
 *  - Auto-refreshes the access token when it's within 60s of expiring.
 *  - Lazy-creates a "Paperfile" task list and caches its id in settings.
 *
 * Why not the official `googleapis` package? It's ~1MB of JS and bundles a
 * lot we don't need. Direct fetch keeps the dep tree small and the failure
 * modes obvious.
 */

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

function requireGoogleConfig() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      "Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env.local."
    );
  }
  return { id, secret };
}

/** Builds the redirect_uri Google needs to match exactly. */
export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/oauth/google/callback`;
}

/** First leg of OAuth: where to send the user. */
export function googleAuthUrl(origin: string, state: string): string {
  const { id } = requireGoogleConfig();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: googleRedirectUri(origin),
    scope: "https://www.googleapis.com/auth/tasks openid email",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Callback leg: trade auth code for refresh + access tokens. */
export async function exchangeCodeForTokens(
  code: string,
  origin: string
): Promise<{
  refresh_token: string;
  access_token: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
}> {
  const { id, secret } = requireGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: id,
    client_secret: secret,
    redirect_uri: googleRedirectUri(origin),
    grant_type: "authorization_code",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Google token exchange failed: ${json.error_description || json.error || res.status}`
    );
  }
  return json;
}

/** Decode the email from a Google id_token (no signature check — trust source). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8")
    );
    return (payload.email as string | undefined) || null;
  } catch {
    return null;
  }
}

/**
 * Refresh the access token if needed, returning a usable bearer token.
 * Persists the new access_token + expires_at back to user_settings.
 */
async function getAccessToken(
  userId: string,
  settings: UserSettings
): Promise<string> {
  const g = settings.google_oauth;
  if (!g) throw new Error("Google not connected.");

  const safetyMs = 60_000;
  if (g.access_token && g.expires_at && g.expires_at > Date.now() + safetyMs) {
    return g.access_token;
  }

  const { id, secret } = requireGoogleConfig();
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    refresh_token: g.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google refresh failed: ${json.error_description || json.error || res.status}`
    );
  }

  const admin = await createServiceClient();
  await saveUserSettings(admin, userId, {
    google_oauth: {
      ...g,
      access_token: json.access_token,
      expires_at: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    },
  });
  return json.access_token as string;
}

/**
 * Look up the "Paperfile" task list, or create it if missing. Caches the id
 * back into settings so subsequent pushes skip the lookup.
 */
async function ensurePaperfileList(
  userId: string,
  settings: UserSettings,
  accessToken: string
): Promise<string> {
  if (settings.google_oauth?.task_list_id) {
    return settings.google_oauth.task_list_id;
  }

  // Look up existing
  const listRes = await fetch(`${TASKS_BASE}/users/@me/lists`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const listJson = await listRes.json();
  if (!listRes.ok) {
    throw new Error(`Google list fetch failed: ${listJson.error?.message || listRes.status}`);
  }

  const existing = (listJson.items || []).find(
    (l: { title: string }) => l.title === "Paperfile"
  );
  let listId: string;
  if (existing) {
    listId = existing.id as string;
  } else {
    const createRes = await fetch(`${TASKS_BASE}/users/@me/lists`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Paperfile" }),
    });
    const createJson = await createRes.json();
    if (!createRes.ok) {
      throw new Error(
        `Google list create failed: ${createJson.error?.message || createRes.status}`
      );
    }
    listId = createJson.id as string;
  }

  const admin = await createServiceClient();
  await saveUserSettings(admin, userId, {
    google_oauth: { ...(settings.google_oauth as NonNullable<UserSettings["google_oauth"]>), task_list_id: listId },
  });
  return listId;
}

/**
 * Create a new Google Task in the user's Paperfile list.
 * Returns { task_id, list_id } so we can store them on the action.
 */
export async function createGoogleTask(
  userId: string,
  payload: { title: string; notes?: string; due?: string | null }
): Promise<{ task_id: string; list_id: string }> {
  const admin = await createServiceClient();
  const settings = await getUserSettings(admin, userId);
  const accessToken = await getAccessToken(userId, settings);
  const listId = await ensurePaperfileList(userId, settings, accessToken);

  // Google Tasks "due" must be RFC3339 with Z; only the date portion is honoured.
  const due = payload.due
    ? new Date(payload.due).toISOString().replace(/\.\d{3}Z$/, "Z")
    : undefined;

  const res = await fetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: payload.title,
        notes: payload.notes,
        due,
      }),
    }
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Google task create failed: ${json.error?.message || res.status}`);
  }
  return { task_id: json.id as string, list_id: listId };
}

/** Mark an existing Google Task done. Best-effort; no throw on 404. */
export async function completeGoogleTask(
  userId: string,
  listId: string,
  taskId: string
): Promise<void> {
  const admin = await createServiceClient();
  const settings = await getUserSettings(admin, userId);
  const accessToken = await getAccessToken(userId, settings);

  const res = await fetch(
    `${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "completed" }),
    }
  );
  if (!res.ok && res.status !== 404) {
    const json = await res.json().catch(() => ({}));
    throw new Error(
      `Google task complete failed: ${json.error?.message || res.status}`
    );
  }
}

/** Revoke the stored refresh token at Google, then clear local settings. */
export async function disconnectGoogle(userId: string): Promise<void> {
  const admin = await createServiceClient();
  const settings = await getUserSettings(admin, userId);
  const token = settings.google_oauth?.refresh_token;
  if (token) {
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
    } catch {
      // Best-effort: even if Google rejects we still clear locally.
    }
  }
  await saveUserSettings(admin, userId, { google_oauth: null });
}
