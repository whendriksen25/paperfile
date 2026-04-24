import { Dropbox } from "dropbox";

/**
 * Returns a Dropbox SDK client. Prefers the OAuth refresh-token flow (recommended
 * — tokens auto-rotate forever), falls back to a long-lived access token if no
 * refresh token is configured.
 *
 * Required env (refresh flow):
 *   DROPBOX_APP_KEY
 *   DROPBOX_APP_SECRET
 *   DROPBOX_REFRESH_TOKEN
 *
 * Fallback env (legacy access token):
 *   DROPBOX_ACCESS_TOKEN
 *
 * Server-side only — never import this module from client code.
 */
export function createDropbox(): Dropbox {
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const accessToken = process.env.DROPBOX_ACCESS_TOKEN;

  if (appKey && appSecret && refreshToken) {
    return new Dropbox({
      clientId: appKey,
      clientSecret: appSecret,
      refreshToken,
      fetch,
    });
  }

  if (accessToken) {
    return new Dropbox({ accessToken, fetch });
  }

  throw new Error(
    "Dropbox not configured. Set DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN (preferred), or DROPBOX_ACCESS_TOKEN."
  );
}

export function dropboxRootFolder(): string {
  const root = process.env.DROPBOX_ROOT_FOLDER || "/Archive";
  return root.startsWith("/") ? root : `/${root}`;
}
