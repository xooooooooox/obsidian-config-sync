export type DeviceClass = "all" | "desktop" | "mobile";

export type SyncMode = "plain" | "fields" | "encrypted";

export interface FieldRule {
  pattern: string; // key-name glob pattern
  action: "strip" | "encrypt";
}

export interface SyncGroup {
  name: string;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "dir";
  devices: DeviceClass;
  mode?: SyncMode; // absent = "plain"; "fields" only on file groups
  fields?: FieldRule[]; // key-name glob rules; only with mode "fields"
  description?: string; // optional human-readable label, shown in the settings panel
  origin?: "discovered"; // rule created from the Discovered-files section; name/path are fixed by the file
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

export interface StoreLock {
  capturedAt: string;
  groups: Record<string, { sourcePluginVersion: string }>;
}

export interface FileChanges {
  added: string[];
  updated: string[];
  deleted: string[];
}

export function hasChanges(c: FileChanges): boolean {
  return c.added.length > 0 || c.updated.length > 0 || c.deleted.length > 0;
}

export interface GroupResult {
  group: string;
  status: "ok" | "warning" | "error";
  filesWritten: string[];
  filesDeleted: string[];
  messages: string[];
  needsAppReload: boolean;
  changes: FileChanges;
}

export type Remote =
  | { name: string; type: "vault"; storePath: string } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string }; // subdir: store folder inside the repo; absent = repo root

export type RibbonKey = "sync" | "revert";
export type RibbonButtons = Record<RibbonKey, boolean>;
