export type DeviceClass = "all" | "desktop" | "mobile";

export interface SyncGroup {
  name: string;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "dir";
  devices: DeviceClass;
  sanitize?: string[]; // key-name glob patterns; file groups only
  description?: string; // optional human-readable label, shown in the settings panel
  origin?: "discovered"; // rule created from the Discovered-files section; name/path are fixed by the file
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

export interface StoreLock {
  publishedAt: string;
  groups: Record<string, { sourcePluginVersion: string }>;
}

export interface GroupResult {
  group: string;
  status: "ok" | "warning" | "error";
  filesWritten: string[];
  filesDeleted: string[];
  messages: string[];
  needsAppReload: boolean;
}

export type Remote =
  | { name: string; type: "vault"; storePath: string } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string }; // subdir: store folder inside the repo; absent = repo root

export type RibbonKey = "capture" | "apply" | "revert" | "pull" | "push";
export type RibbonButtons = Record<RibbonKey, boolean>;
