export type DeviceClass = "all" | "desktop" | "mobile";

export type SyncMode = "plain" | "fields" | "encrypted";

// Orthogonal rule model (spec 2026-07-25-unified-card-design.md §2): scope and encrypted are
// independent axes, not a mutually-exclusive action enum. scope "local" (This device) can never
// combine with encrypted:true — validated in manifest.ts, which derives from this same const to
// avoid the type/validator drift that caused a prior config-wipe CRITICAL.
export const RULE_SCOPES = ["all", "desktop", "mobile", "local"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

// Per-device enablement rule for an on/off list member (Sync Center unified grammar). Distinct
// from RuleScope: this governs whether a member turns on/off on this device, not sync scope.
export const MEMBER_RULES = ["all", "desktop", "mobile", "always-here", "never-here"] as const;
export type MemberRule = (typeof MEMBER_RULES)[number];

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
  // memberLabels (2026-08-09-c-livetest-batch15): id → display name, only on the two carrier
  // entries (core-plugins, community-plugins) — names for on/off-list members that have no lock
  // entry of their own (never individually synced). Absent = today's shape, fully back-compatible.
  groups: Record<
    string,
    { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean; label?: string; memberLabels?: Record<string, string> }
  >;
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
// What the git transport answers a credential prompt with. The username matters: PAT-only hosts
// ignore it, a self-hosted GitLab validates it — so it is carried, never assumed at the edge.
export type GitAuth = { username: string; token: string };

export type Remote =
  | { name: string; type: "vault"; storePath: string; excludeSelf?: boolean } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean; tokenId?: string; username?: string }; // subdir: store folder inside the repo; absent = repo root. tokenId: name of the keychain secret holding the token — the token itself never enters data.json. username: sent alongside it; absent = "token", which PAT-only hosts ignore but a self-hosted GitLab validates

export type RibbonKey = "sync";
export type RibbonButtons = Record<RibbonKey, boolean>;
