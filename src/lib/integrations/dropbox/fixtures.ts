/**
 * Recorded Dropbox API v2 shapes (api.dropboxapi.com/2) — trimmed to the
 * fields the adapter reads. Sources: POST /files/list_folder and
 * /files/list_folder/continue (the continue answer is empty — nothing changed
 * since the recorded cursor).
 */
import type { FixtureRoute } from "../core/types.js";

export interface DropboxEntry {
  ".tag": "file" | "folder";
  id: string;
  name: string;
  path_display: string;
  size?: number; // files only, bytes
  server_modified?: string; // files only, ISO
}

export interface DropboxListFolderAnswer {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export const LIST_FOLDER: DropboxListFolderAnswer = {
  entries: [
    {
      ".tag": "folder",
      id: "id:a4ayc_80_OEAAAAAAAAAXw",
      name: "Tax",
      path_display: "/Tax",
    },
    {
      ".tag": "file",
      id: "id:a4ayc_80_OEAAAAAAAAAYa",
      name: "Tax return 2025.pdf",
      path_display: "/Tax/Tax return 2025.pdf",
      size: 1840205,
      server_modified: "2026-01-28T14:22:00Z",
    },
    {
      ".tag": "file",
      id: "id:a4ayc_80_OEAAAAAAAAAYb",
      name: "House inventory.xlsx",
      path_display: "/House inventory.xlsx",
      size: 48217,
      server_modified: "2026-05-15T10:01:00Z",
    },
  ],
  cursor: "AAFmZ0123recordedcursor",
  has_more: false,
};

export const LIST_FOLDER_CONTINUE: DropboxListFolderAnswer = {
  entries: [],
  cursor: "AAFmZ0123recordedcursor",
  has_more: false,
};

export const DROPBOX_FIXTURES: readonly FixtureRoute[] = [
  // Order matters: /continue shares the /list_folder prefix.
  {
    method: "POST",
    url: "https://api.dropboxapi.com/2/files/list_folder/continue",
    json: LIST_FOLDER_CONTINUE,
  },
  {
    method: "POST",
    url: "https://api.dropboxapi.com/2/files/list_folder",
    json: LIST_FOLDER,
  },
];
