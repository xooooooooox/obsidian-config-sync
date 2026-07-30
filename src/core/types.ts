export type DeviceClass = "all" | "desktop" | "mobile";

export type SyncMode = "plain" | "fields" | "encrypted";

// Orthogonal rule model (spec 2026-07-25-unified-card-design.md §2): scope and encrypted are
// independent axes, not a mutually-exclusive action enum. scope "local" (This device) can never
// combine with encrypted:true — validated in manifest.ts, which derives from this same const to
// avoid the type/validator drift that caused a prior config-wipe CRITICAL.
export const RULE_SCOPES = ["all", "desktop", "mobile", "local"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

// Per-item scopes for a string-array key (spec §3, D3): element value -> scope; an element with
// no entry defaults to "all". Generalizes the switch-list / memberScopes mechanism to any
// string-array key, not just community-plugins.json / core-plugins.json / enabledCssSnippets.
export type PerItemScopes = Record<string, RuleScope>;

export interface FieldRule {
  pattern: string; // key-name glob pattern
  scope: RuleScope;
  encrypted: boolean;
  locked?: boolean; // preset rule; cannot be removed in the UI
}

// Plain-mode whole-file rule (spec §2, D9): unlike FieldRule, no "local" scope — a Plain file
// that shouldn't sync at all is expressed by the group's own sync toggle, not a file-level scope.
export interface FileRule {
  scope: Exclude<RuleScope, "local">;
  encrypted: boolean;
}

export interface SyncGroup {
  name: string;
  path: string; // real vault-relative path; may start with the {configDir} variable
  type: "file" | "dir";
  devices: DeviceClass;
  mode?: SyncMode; // absent = "plain"; "fields" only on file groups
  fields?: FieldRule[]; // key-name glob rules; only with mode "fields"
  // Whole-file encryption for a Plain single-file group (settingsFile only — never folder
  // members). Only meaningful when mode is absent or "plain"; manifest.ts rejects it otherwise.
  fileRule?: FileRule;
  // Per-item scope maps for string-array keys under mode "fields" (spec §3, D3): key -> element
  // scope map. A key listed here is governed exclusively by capturePerItemArray/
  // applyPerItemArray (src/core/perItem.ts) instead of the key's own {scope, encrypted} rule;
  // manifest.ts rejects combining a perItem key with encrypted:true (encrypt stays key-level,
  // never per-element).
  perItem?: Record<string, PerItemScopes>;
  description?: string; // optional human-readable label, shown in the settings panel
  label?: string; // display name recorded at capture/enable; falls back through the resolver chain
  origin?: "discovered"; // rule created from the Discovered-files section; name/path are fixed by the file
}

export interface SyncManifest {
  version: 1;
  groups: SyncGroup[];
}

export interface StoreLock {
  capturedAt: string;
  groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean }>;
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
  stateNote?: { kind: "ok" | "warn"; text: string };
}

// excludeSelf (either type): true = Config Sync's own settings (the self item's store copy)
// never travel to/from this remote — pull/push skip them and the comparison stops reporting
// them. Absent = false = the self item travels like any other (same-lineage stores).
export type Remote =
  | { name: string; type: "vault"; storePath: string; excludeSelf?: boolean } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean }; // subdir: store folder inside the repo; absent = repo root

export type RibbonKey = "sync";
export type RibbonButtons = Record<RibbonKey, boolean>;
