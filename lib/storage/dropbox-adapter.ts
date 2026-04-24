import {
  uploadToDropboxInbox,
  uploadDropboxAt,
  moveDropboxFile,
  downloadFromDropbox,
  getOrCreateShareLink as dbxGetOrCreateShareLink,
  getTemporaryLink as dbxGetTemporaryLink,
  buildDestinationPath as dbxBuildDestinationPath,
} from "@/lib/dropbox/upload";
import type { StorageAdapter } from "./types";

export const dropboxAdapter: StorageAdapter = {
  provider: "dropbox",

  uploadToInbox: (params) => uploadToDropboxInbox(params),

  uploadAt: (params) => uploadDropboxAt(params),

  moveFile: (from, to) => moveDropboxFile(from, to),

  downloadFile: (path) => downloadFromDropbox(path),

  getOrCreateShareLink: (path) => dbxGetOrCreateShareLink(path),

  getTemporaryLink: (path) => dbxGetTemporaryLink(path),

  buildDestinationPath: (params) => dbxBuildDestinationPath(params),
};
