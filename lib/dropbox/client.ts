import { Dropbox } from "dropbox";

/**
 * Returns a Dropbox SDK client authenticated with the long-lived access token
 * from DROPBOX_ACCESS_TOKEN. Server-side only — never import from client code.
 */
export function createDropbox(): Dropbox {
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "DROPBOX_ACCESS_TOKEN is not set. Generate a token in the Dropbox app console and add it to .env.local."
    );
  }
  return new Dropbox({ accessToken: token, fetch });
}

export function dropboxRootFolder(): string {
  const root = process.env.DROPBOX_ROOT_FOLDER || "/Archive";
  return root.startsWith("/") ? root : `/${root}`;
}
