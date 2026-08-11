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

// One lock entry per group. The index signature is the carried tail (spec
// 2026-08-11-data-model-hardening.md §3.1, invariant II.1): parseStoreLock validates the named
// fields and keeps every other key exactly as it found it, so a field a NEWER build writes
// survives a parse here instead of being stripped and pushed back out to the fleet as a loss.
export interface StoreLockEntry {
  // The v2 payload (spec 2026-08-11-data-model-hardening.md §6): this item's OWN provenance, so
  // freshness stops being a single whole-store timestamp. Both reach a reader through the carried
  // tail rather than through validation — read them with manifest.ts's lockEntryCapturedAt /
  // lockEntryHash, never off these fields, for the same reason `version` is read via
  // storeLockVersion. Absent on every lock written before this build, and absent by design on a
  // group whose store copy is ciphertext; an absent value is never a difference.
  capturedAt?: string; // when THIS item was last captured into the store
  hash?: string; // fingerprint of this item's store content — the same canonical hash the direction baseline uses
  sourcePluginVersion?: string;
  sourceAppVersion?: string;
  desktopOnly?: boolean;
  label?: string;
  // memberLabels (2026-08-09-c-livetest-batch15): id → display name, only on the two carrier
  // entries (core-plugins, community-plugins) — names for on/off-list members that have no lock
  // entry of their own (never individually synced). Absent = today's shape, fully back-compatible.
  memberLabels?: Record<string, string>;
  [key: string]: unknown;
}

export interface StoreLock {
  // The lock's FORMAT version (spec 2026-08-11-data-model-hardening.md §4.3). Absent = 1: every
  // lock written before this build has today's shape and is parsed and normalised exactly as it
  // always was. This build writes 2. Declared here for the writers, but never trusted as a number
  // on the way in — it rides through parseStoreLock in the carried tail like any other key, so
  // read it through manifest.ts's storeLockVersion rather than off this field.
  version?: number;
  // The lineage watermark (§6): the remote state this store was last aligned to. Only a pull moves
  // it — that alignment is what makes status.ts's remoteLockAhead settle to false after a pull, and
  // it used to be smuggled into `capturedAt`, which had to carry both meanings at once. Absent = a
  // v1 lock, whose `capturedAt` still carries both; read it through manifest.ts's lockWatermark.
  syncedWatermark?: string;
  // DERIVED since v2: max(groups[*].capturedAt), i.e. the newest moment any item in THIS store was
  // captured. It describes local content only — a pull recomputes it from the merged entries and
  // never copies the remote's value over it, which is what used to make it a watermark by accident.
  capturedAt: string;
  groups: Record<string, StoreLockEntry>;
  [key: string]: unknown; // carried the same way as an entry's unknown keys (§3.1)
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
