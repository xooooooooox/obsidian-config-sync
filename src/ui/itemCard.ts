/**
 * Unified card — pure render helpers (spec docs/superpowers/specs/2026-07-25-unified-card-design.md
 * §4/§5/§10, task-5-brief.md). One renderer works for every ItemDef (registry.ts); this module
 * holds every piece of that renderer's logic that can be expressed as a pure function of
 * (def, cfg, live-file-state) — badge computation, zone presence, and the Fields/Companion-folders
 * row models — so it can be unit tested without touching the DOM or Obsidian's API.
 * `src/ui/SettingTab.ts`'s `renderItemCard` is the only consumer that turns these models into
 * actual elements.
 *
 * Every literal string exported here is copy-contract-exact (spec §10) — grep the spec table
 * before changing any of them.
 */
import { GROUP_NAME_RE } from "../core/manifest";
import { basename } from "../core/pathing";
import { emptyItemConfig, ItemConfig, ItemDef, ItemFieldRule, ItemSettingsFile } from "../core/registry";
import { DeviceClass, PerItemScopes, RuleScope } from "../core/types";

// ── Row badges (spec §4, D2) ────────────────────────────────────────────────────────────────
// Row = name + badges + sync toggle + chevron, NOTHING else. Badge order: enablement-scope
// (only for cards with an `enablement` projection, only when non-default) → N device-scoped →
// N encrypted. Zero counts are omitted entirely — a badge never reads "0 …".

export interface Badge {
  text: string;
  cls: string;
  icon?: string; // lucide icon rendered before the text (round-8 "desktop-only plugin" chip)
}

const ON_BADGE_TEXT: Record<Exclude<RuleScope, "all">, string> = {
  desktop: "on: desktop",
  mobile: "on: mobile",
  local: "on: this device",
};

const ON_BADGE_CLASS: Record<Exclude<RuleScope, "all">, string> = {
  desktop: "config-sync-card-badge-desktop",
  mobile: "config-sync-card-badge-mobile",
  local: "config-sync-card-badge-local",
};

// A fileRule-encrypted item (Plain mode, whole file encrypted) counts as one toward "N
// encrypted" — there is no separate lock-badge string in the copy contract (spec §10's badge
// list has only "N encrypted"), so the fileRule contributes to the same count instead of a
// second badge.
export function countDeviceScoped(cfg: ItemConfig): number {
  const sf = cfg.settingsFile;
  if (sf === undefined) return 0;
  let n = 0;
  if (sf.fileRule !== undefined && (sf.fileRule.scope === "desktop" || sf.fileRule.scope === "mobile")) n++;
  for (const rule of Object.values(sf.rules)) {
    if (rule.scope === "desktop" || rule.scope === "mobile") n++;
  }
  for (const scopes of Object.values(sf.perItem)) {
    for (const scope of Object.values(scopes)) {
      if (scope === "desktop" || scope === "mobile") n++;
    }
  }
  return n;
}

export function countEncrypted(cfg: ItemConfig): number {
  const sf = cfg.settingsFile;
  if (sf === undefined) return 0;
  let n = sf.fileRule?.encrypted === true ? 1 : 0;
  for (const rule of Object.values(sf.rules)) {
    if (rule.encrypted) n++;
  }
  return n;
}

export function computeBadges(def: ItemDef, cfg: ItemConfig): Badge[] {
  const badges: Badge[] = [];
  // Innate manifest property first, ahead of every config-driven badge — neutral grey so the
  // colored "on: …" (the user's CHOICE) keeps its contrast (round-8 spec §2, mockup-approved).
  if (def.desktopOnly === true) {
    badges.push({ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" });
  }
  if (def.enablement !== undefined && cfg.enabledOn !== undefined && cfg.enabledOn !== "all") {
    badges.push({ text: ON_BADGE_TEXT[cfg.enabledOn], cls: ON_BADGE_CLASS[cfg.enabledOn] });
  }
  const scoped = countDeviceScoped(cfg);
  if (scoped > 0) badges.push({ text: `${scoped} device-scoped`, cls: "config-sync-card-badge-count" });
  const encrypted = countEncrypted(cfg);
  if (encrypted > 0) badges.push({ text: `${encrypted} encrypted`, cls: "config-sync-card-badge-count" });
  return badges;
}

// ── Zone presence (spec §4) ─────────────────────────────────────────────────────────────────

// Zone ① "Enabled on" exists only for cards whose registry def carries an enablement projection
// (core/community/beta plugins) — Task 6 builds the zone itself; this task only needs to know
// whether to reserve the slot.
export function hasEnablementZone(def: ItemDef): boolean {
  return def.enablement !== undefined;
}

// Zone ① copy (spec §4/§10, D2/D4; 2026-07-26 round-3 revision: one row — label left, scope
// dropdown right; the hint moved into the dropdown's tooltip and dropped the carrier filename,
// dev detail in a user-facing panel). Only rendered for a def where hasEnablementZone(def) is true.
export const ENABLED_ON_LABEL = "Enabled on";
export const ENABLED_ON_HINT = "Which devices turn this plugin on";

export type SettingsFileZoneKind = "none" | "state-only" | "settings";

// "none" = the def has no settingsFile at all (never true for the five Obsidian cards). "state-
// only" = a core plugin that has never written its settings file yet (registry.ts's
// `defaultPath: null`) — zone ② shows a hint instead of Fields/Plain controls. "settings" = the
// normal case.
export function settingsFileZoneKind(def: ItemDef): SettingsFileZoneKind {
  if (def.settingsFile === undefined) return "none";
  return def.settingsFile.defaultPath === null ? "state-only" : "settings";
}

export function stateOnlyHint(itemLabel: string, expectedFile: string): string {
  return `Settings appear here once ${itemLabel} writes ${expectedFile}.`;
}

// ── Settings file mode (spec §4/§5, D9; spec 2026-07-26-card-visual-refresh-design.md §3) ──────

// Derived mode (spec 2026-07-26-card-visual-refresh-design.md §3): the stored mode is written by
// the UI, never chosen by the user — any per-key customization (a rule OR a per-item map, incl.
// snippet member scopes on enabledCssSnippets) makes the card per-key ("fields"); none makes it
// whole-file ("plain").
export function deriveMode(sf: ItemSettingsFile): "plain" | "fields" {
  return Object.keys(sf.rules).length > 0 || Object.keys(sf.perItem).length > 0 ? "fields" : "plain";
}

// ItemConfig convenience form of the same test — false when the card has no settingsFile at all
// (nothing to derive from).
export function hasKeyRules(cfg: ItemConfig): boolean {
  return cfg.settingsFile !== undefined && deriveMode(cfg.settingsFile) === "fields";
}

// ── Fields zone row models (spec §4, D6) ────────────────────────────────────────────────────

export const DEFAULT_FIELD_RULE: ItemFieldRule = { scope: "all", encrypted: false };

export function isStringArrayValue(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export interface FieldRowModel {
  key: string;
  isArray: boolean;
  rule: ItemFieldRule;
  perItemEnabled: boolean;
}

// The Appearance card's enabledCssSnippets key is never an ordinary rule row — its per-item scope
// lives in the dedicated snippets member rows under Companion folders instead (spec §4/§5); rule
// rows and File preview's click-to-add both exclude it.
export const ENABLED_CSS_SNIPPETS_KEY = "enabledCssSnippets";

// Rule rows list ONLY configured keys (rules ∪ perItem) — browsing the file's full key set is the
// File preview's job now (spec 2026-07-26-card-visual-refresh-design.md §3.1). Key order: rules
// first (insertion order), then perItem-only keys. A key absent from liveDoc (settings file not
// yet re-read, or the key was removed from the file) defaults isArray to false rather than
// throwing.
export function buildRuleRows(def: ItemDef, cfg: ItemConfig, liveDoc: Record<string, unknown>): FieldRowModel[] {
  const sf = cfg.settingsFile;
  if (sf === undefined) return [];
  const keys = [...Object.keys(sf.rules), ...Object.keys(sf.perItem).filter((k) => !(k in sf.rules))].filter(
    (k) => !(def.id === "appearance" && k === ENABLED_CSS_SNIPPETS_KEY)
  );
  return keys.map((key) => ({
    key,
    isArray: isStringArrayValue(liveDoc[key]),
    rule: sf.rules[key] ?? DEFAULT_FIELD_RULE,
    perItemEnabled: key in sf.perItem,
  }));
}

// Progressive-disclosure collapsed-row label for a companion's member list (spec
// 2026-07-26-card-visual-refresh-design.md §4): "· N themes" for the themes/ preset, "· N files"
// for everything else.
export function memberCountLabel(isThemesPreset: boolean, n: number): string {
  return isThemesPreset ? `· ${n} themes` : `· ${n} files`;
}

export function encryptDisabledForScope(scope: RuleScope): boolean {
  return scope === "local";
}

// Encrypt and Per-item scopes are mutually exclusive on the same rule (manifest.ts's D3
// perItem+encrypted rejection) — final-review MUST-FIX 2 enforces this in BOTH directions at the
// write boundary, not just via disabled controls: encryptToggleDisabled below covers "the Encrypt
// checkbox must render disabled while Per-item is on" (added to the pre-existing scope==="local"
// disable reason); applyPerItemToggle covers "enabling Per-item must clear encrypted in the SAME
// write", since a rule can already be encrypted:true from before Per-item was ever turned on — a
// disabled checkbox alone only stops a NEW toggle, it doesn't retroactively clear a stale one.
export function encryptToggleDisabled(scope: RuleScope, perItemEnabled: boolean): boolean {
  return encryptDisabledForScope(scope) || perItemEnabled;
}

export const PER_ITEM_DISABLED_HINT = "Turn off Encrypt to enable Per-item scopes.";
export const ENCRYPT_DISABLED_PERITEM_HINT = "Turn off Per-item scopes to encrypt.";

// Toggling Per-item scopes on/off for one Fields-mode row (D3 + MUST-FIX 2): turning it ON must
// clear `encrypted` on the SAME rule in the SAME write.
export function applyPerItemToggle(sf: ItemSettingsFile, key: string, enabled: boolean): ItemSettingsFile {
  const nextPerItem = { ...sf.perItem };
  if (enabled) nextPerItem[key] = nextPerItem[key] ?? {};
  else delete nextPerItem[key];
  if (!enabled) return { ...sf, perItem: nextPerItem };
  const currentRule = sf.rules[key] ?? DEFAULT_FIELD_RULE;
  return { ...sf, rules: { ...sf.rules, [key]: { ...currentRule, encrypted: false } }, perItem: nextPerItem };
}

export interface PerItemElementRow {
  element: string;
  scope: RuleScope;
}

export function buildPerItemElementRows(elements: string[], scopes: PerItemScopes): PerItemElementRow[] {
  return elements.map((element) => ({ element, scope: scopes[element] ?? "all" }));
}

export function defaultSettingsFile(): ItemSettingsFile {
  return { mode: "plain", rules: {}, perItem: {} };
}

// ── Appearance specifics (spec §4/§5) ───────────────────────────────────────────────────────

export const SNIPPET_MEMBER_HINT = "Files always sync — each snippet's choice here is where it's turned on.";

export interface SnippetMemberRow {
  name: string;
  scope: RuleScope;
}

// Union of files actually present under snippets/ and any name already scoped in
// perItem.enabledCssSnippets (so a scoped-but-since-deleted file doesn't just vanish from view).
export function buildSnippetMemberRows(fileNames: string[], perItem: PerItemScopes): SnippetMemberRow[] {
  const names = new Set([...fileNames, ...Object.keys(perItem)]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, scope: perItem[name] ?? "all" }));
}

// Writes one snippet member's scope into perItem[ENABLED_CSS_SNIPPETS_KEY] (final-review blocker:
// the settings-tab dropdown's write path). Scope "all" clears that name's entry — and, when the
// map is left empty, deletes the ENABLED_CSS_SNIPPETS_KEY entry from perItem entirely rather than
// leaving `{}` behind: deriveMode counts the KEY's presence, not its contents, so a bare `{}` would
// keep the card stuck in Fields mode forever with nothing to undo it (enabledCssSnippets is
// excluded from rule rows — see ENABLED_CSS_SNIPPETS_KEY above — so there is no ✕ that could ever
// remove a residual empty map). Pure — never mutates sf or its nested maps.
export function withSnippetScope(sf: ItemSettingsFile, name: string, scope: RuleScope): ItemSettingsFile {
  const scopes = { ...(sf.perItem[ENABLED_CSS_SNIPPETS_KEY] ?? {}) };
  if (scope === "all") delete scopes[name];
  else scopes[name] = scope;
  const perItem = { ...sf.perItem };
  if (Object.keys(scopes).length === 0) delete perItem[ENABLED_CSS_SNIPPETS_KEY];
  else perItem[ENABLED_CSS_SNIPPETS_KEY] = scopes;
  return { ...sf, perItem };
}

// ── Companion folders zone (spec §4, D8 — scaffold only; Task 7 wires add/remove/warnings) ──

// Tail hint under a non-snippet companion's member-file list (spec §3.1) — a plain folder has no
// per-file scope control (see renderPlainCompanionMembers's doc comment), so this clarifies that
// the folder's own scope/enabled row above governs every file inside it.
export const FOLDER_MEMBER_HINT = "This folder syncs as a whole — everything in it goes to the devices selected above.";

export interface CompanionRowModel {
  path: string;
  scope: DeviceClass;
  enabled: boolean;
  isPreset: boolean;
}

// Presets (themes/, snippets/) must render as a row from the very first open — before the user
// has ever toggled one, cfg.companions has no entry for it yet, so a preset with no matching
// entry gets a synthesized OFF/all-devices default row rather than being missing entirely.
export function buildCompanionRows(def: ItemDef, cfg: ItemConfig): CompanionRowModel[] {
  const byPath = new Map(cfg.companions.map((c) => [c.path, c]));
  const presetDefs = def.presetCompanions ?? [];
  const presetPaths = new Set(presetDefs.map((p) => p.path));
  const presetRows: CompanionRowModel[] = presetDefs.map((p) => {
    const existing = byPath.get(p.path);
    return existing !== undefined ? { ...existing, isPreset: true } : { path: p.path, scope: "all", enabled: false, isPreset: true };
  });
  const userRows: CompanionRowModel[] = cfg.companions.filter((c) => !presetPaths.has(c.path)).map((c) => ({ ...c, isPreset: false }));
  return [...presetRows, ...userRows];
}

// ── Companion / custom-path input validation (spec §4, D7/D8, task-7-brief.md) ─────────────────
// Shared by zone ② "Custom path" and zone ③ "+ Add folder": both accept a vault-relative path
// typed by the user. Trims, turns backslashes into forward slashes (Windows paste), collapses
// "//", and strips leading/trailing slashes. Validation then rejects empty, absolute (leading
// "/" or a drive letter, checked BEFORE the leading slash is stripped) and any ".." segment
// (path escape) — every rejection is a caller-displayed inline error, never a silent no-op.

export function normalizeCompanionPath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

const DRIVE_LETTER_RE = /^[a-zA-Z]:/;

export type CompanionPathValidation = { ok: true; path: string } | { ok: false; error: string };

export function validateCompanionPath(raw: string): CompanionPathValidation {
  const trimmed = raw.trim();
  // A path with nothing but slashes (or nothing at all) is empty, not "absolute" — checked
  // before the absolute test below so "///" reports the more useful message.
  if (trimmed.replace(/\/+/g, "") === "") return { ok: false, error: "Enter a path." };
  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/") || DRIVE_LETTER_RE.test(trimmed)) {
    return { ok: false, error: "Path must be vault-relative, not absolute." };
  }
  const path = normalizeCompanionPath(raw);
  if (path === "") return { ok: false, error: "Enter a path." };
  if (path.split("/").includes("..")) return { ok: false, error: 'Path cannot contain ".." segments.' };
  return { ok: true, path };
}

export function companionConflictError(itemLabel: string): string {
  return `${itemLabel} already syncs this path.`;
}

// Basename-derived group-name shape check (final-review MUST-FIX 1). registry.ts's
// compileCompanions names a companion group after basename(path) — parseGroup (manifest.ts)
// enforces GROUP_NAME_RE on every group name, so a basename that fails it (a space, a dot, any
// other punctuation) compiles here without complaint but bricks recompile()'s validateSyncManifest
// safety net later, silently zeroing out compiledGroups. Checked separately from
// validateCompanionPath (which only cares about the path's OWN shape — absolute/".."/empty) so a
// settings-file custom path is never subjected to this: its group name is the item id, never the
// path's basename (see registry.ts's compileSingleFile/legacyGroupName) — nothing to check there.
export function validateCompanionBasename(path: string): string | null {
  const name = basename(path);
  return GROUP_NAME_RE.test(name)
    ? null
    : `Folder name "${name}" must use only letters, digits, "-" or "_", starting with a letter or digit.`;
}

export function companionNameConflictError(name: string): string {
  return `"${name}" is already used by another synced item — rename this folder or choose a different path.`;
}

// Plain (non-mapKey) companion member listing (spec §4 "成员行" — themes/ and any user-added
// folder): file/folder names on disk, deduped and sorted. No per-member scope chip here — see
// task-7-brief.md/uc-task-7-report.md for why (the switch-list/memberScopes engine only knows
// about community-plugins.json, core-plugins.json and enabledCssSnippets; an arbitrary plain
// directory group has no per-file carry-scope mechanism to write to).
export function sortCompanionMemberNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// ── Copy contract (spec §10, verbatim) ──────────────────────────────────────────────────────

export const SCOPE_LABELS: Record<RuleScope, string> = {
  all: "All devices",
  desktop: "Desktop only",
  mobile: "Mobile only",
  local: "This device",
};

export const FILE_SCOPE_OPTIONS: Exclude<RuleScope, "local">[] = ["all", "desktop", "mobile"];
export const FIELD_SCOPE_OPTIONS: RuleScope[] = ["all", "desktop", "mobile", "local"];
// ENABLED ON cycle for a manifest-desktop-only plugin: mobile can never install it, so that
// stop is meaningless — the cycle runs all → desktop → local (round-8 spec §2).
export const DESKTOP_ONLY_ENABLED_OPTIONS: RuleScope[] = ["all", "desktop", "local"];
export const COMPANION_SCOPE_OPTIONS: DeviceClass[] = ["all", "desktop", "mobile"];

// Scope renders as a Commander-style clickable icon (round-6 定稿): the icon IS the state, a
// click advances to the next option in the row's own option list, wrapping at the end.
export const SCOPE_ICONS: Record<RuleScope, string> = {
  all: "monitor-smartphone",
  desktop: "monitor",
  mobile: "smartphone",
  local: "airplay",
};

export function nextScope<T extends RuleScope>(current: T, options: readonly T[]): T {
  const i = options.indexOf(current);
  if (i !== -1) {
    const next = options[(i + 1) % options.length];
    if (next === undefined) throw new Error("nextScope: options list is empty");
    return next;
  }
  // Stored value missing from the offered options (e.g. a stale enabledOn:"mobile" on a
  // desktop-only plugin whose cycle no longer offers mobile): resume from the value's slot in
  // the canonical order to the next offered option instead of snapping back to options[0]
  // (round-8 spec §2 — the cycle continues, the stale stored value is never silently rewritten).
  const canon: readonly RuleScope[] = ["all", "desktop", "mobile", "local"];
  const start = canon.indexOf(current);
  for (let step = 1; step <= canon.length; step++) {
    const candidate = canon[(start + step) % canon.length] as T;
    if (options.includes(candidate)) return candidate;
  }
  throw new Error("nextScope: options list is empty");
}

// Appended to the "all" stop of a desktop-only plugin's ENABLED ON cycle: "all" never touches
// mobile for these plugins (the runtime auto-mask keeps mobile's local state), so the tooltip
// says so instead of letting "All devices" read as "mobile too".
export const DESKTOP_ONLY_ALL_NOTE = "mobile is excluded automatically";

export function scopeCycleTooltip(scope: RuleScope, note?: string): string {
  const label = note === undefined ? SCOPE_LABELS[scope] : `${SCOPE_LABELS[scope]} — ${note}`;
  return `Change scope (currently: ${label})`;
}

// Reused as the ✎ icon's tooltip/aria (spec 2026-07-26-card-visual-refresh-design.md §2/§5) — no
// longer an inline toggle label; the toggle itself was deleted, along with `Per-key rules are
// active — remove them to control the whole file again`/`Remove rule`/`Reset to default path`/
// `Encrypt` · `Encrypted`, which are single-call-site literals inlined directly in SettingTab.ts.
export const CUSTOM_PATH_LABEL = "Custom path";
export const PER_ITEM_SCOPES_LABEL = "Per-item scopes";
export const ADD_FOLDER_LABEL = "+ Add folder";
export const SYNC_ALL_LABEL = "Sync all";
export const SYNC_ALL_HINT = "Toggle every plugin below.";
// File-preview footer legend (round-7 spec §2, 定稿 B): color dots + neutral words. The old
// single-string legend rendered as plain text, so the colors it *named* never showed; scope
// entries reuse the preview's own key color classes so dot and key can never drift apart.
export interface PreviewLegendEntry {
  kind: "scope" | "lock" | "hint";
  cls: string | null; // dot color class — set exactly when kind is "scope"
  text: string;
}
export const PREVIEW_LEGEND_ENTRIES: PreviewLegendEntry[] = [
  { kind: "scope", cls: "config-sync-json-desktop", text: "desktop only" },
  { kind: "scope", cls: "config-sync-json-mobile", text: "mobile only" },
  { kind: "scope", cls: "config-sync-json-strip", text: "this device" },
  { kind: "lock", cls: null, text: "encrypted" },
  { kind: "hint", cls: null, text: "click a key to add a rule" },
];

// ── Sync all (spec §4/§5/§10, D11) — one master row per Core/Community/Beta section: toggles
// every card's ItemConfig.enabled in that section; its own value is derived (all-enabled), never
// stored separately. No kind-exclusion: every def in the section participates, unlike the old
// per-catalog-section "list"/allowSyncAll split this replaces.

export function sectionAllEnabled(defs: ItemDef[], items: Record<string, ItemConfig>): boolean {
  return defs.length > 0 && defs.every((d) => (items[d.id] ?? emptyItemConfig()).enabled);
}

export function applySyncAll(defs: ItemDef[], items: Record<string, ItemConfig>, on: boolean): Record<string, ItemConfig> {
  const next = { ...items };
  for (const d of defs) {
    const cfg = next[d.id] ?? emptyItemConfig();
    next[d.id] = { ...cfg, enabled: on };
  }
  return next;
}
