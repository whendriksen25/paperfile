import { dropboxAdapter } from "./dropbox-adapter";
import type { StorageAdapter, StorageProvider } from "./types";

export type { StorageAdapter, StorageProvider } from "./types";

/**
 * Returns the adapter for the requested provider. Defaults to the configured
 * primary provider (env var DEFAULT_STORAGE_PROVIDER, fallback "dropbox").
 *
 * To add a new provider:
 *   1. Implement the StorageAdapter interface in lib/storage/{name}-adapter.ts
 *   2. Add the case below
 *   3. Add the provider name to the CHECK constraint in migration 004
 */
export function getStorage(
  provider?: StorageProvider | string | null
): StorageAdapter {
  const target =
    (provider as StorageProvider | undefined) ||
    (process.env.DEFAULT_STORAGE_PROVIDER as StorageProvider | undefined) ||
    "dropbox";

  switch (target) {
    case "dropbox":
      return dropboxAdapter;
    // case "gdrive": return gdriveAdapter;
    // case "onedrive": return onedriveAdapter;
    // case "s3": return s3Adapter;
    // case "local": return localAdapter;
    default:
      throw new Error(
        `Storage provider '${target}' is not implemented. Add an adapter in lib/storage/.`
      );
  }
}
