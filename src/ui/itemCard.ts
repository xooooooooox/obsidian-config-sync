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
import { emptyItem, Item, ItemDef, ItemFieldRule, ItemMap, itemFor, ItemSettingsFile, withItem } from "../core/registry";
import {
  DeviceClass,
  EVERYWHERE,
  PerElementSharing,
  perClass,
  RunsOn,
  runsOnEquals,
  Sharing,
  sharingClass,
  sharingEquals,
  SyncMode,
  THIS_DEVICE,
} from "../core/types";

// ── Row badges (spec §4, D2) ────────────────────────────────────────────────────────────────
// Row = name + badges + sync toggle + chevron, NOTHING else. Badge order: enablement rule
// (only for cards with an `enablement` projection, only when non-default) → N device-scoped →
// N encrypted. Zero counts are omitted entirely — a badge never reads "0 …".

export interface Badge {
  text: string;
  cls: string;
  icon?: string; // lucide icon rendered before the text (round-8 "desktop-only plugin" chip)
  tooltip?: string;
}

const ON_BADGE_TEXT = { desktop: "on: desktop", mobile: "on: mobile", local: "on: this device" } as const;

const ON_BADGE_CLASS = {
  desktop: "config-sync-card-badge-desktop",
  mobile: "config-sync-card-badge-mobile",
  local: "config-sync-card-badge-local",
} as const;

// A fileRule-encrypted item (Plain mode, whole file encrypted) counts as one toward "N
// encrypted" — there is no separate lock-badge string in the copy contract (spec §10's badge
// list has only "N encrypted"), so the fileRule contributes to the same count instead of a
// second badge.
export function countClassPinned(item: Item): number {
  const sf = item.settingsFile;
  if (sf === undefined) return 0;
  let n = 0;
  if (sf.fileRule !== undefined && sharingClass(sf.fileRule.sharing) !== null) n++;
  for (const rule of Object.values(sf.rules)) {
    if (sharingClass(rule.sharing) !== null) n++;
  }
  for (const sharings of Object.values(sf.perElement)) {
    for (const sharing of Object.values(sharings)) {
      if (sharingClass(sharing) !== null) n++;
    }
  }
  return n;
}

export function countEncrypted(item: Item): number {
  const sf = item.settingsFile;
  if (sf === undefined) return 0;
  let n = sf.fileRule?.encrypted === true ? 1 : 0;
  for (const rule of Object.values(sf.rules)) {
    if (rule.encrypted) n++;
  }
  return n;
}

export function computeBadges(def: ItemDef, item: Item, isThisDevice: boolean): Badge[] {
  const badges: Badge[] = [];
  // On/off-only badge first, innate property (settingsFile state on the def)
  if (def.settingsFile !== undefined && def.settingsFile.defaultPath === null) {
    badges.push({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      tooltip: "No settings file on this device yet — only the on/off state syncs.",
    });
  }
  // Innate manifest property first, ahead of every config-driven badge — neutral grey so the
  // colored "on: …" (the user's CHOICE) keeps its contrast (round-8 spec §2, mockup-approved).
  if (def.desktopOnly === true) {
    badges.push({ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" });
  }
  // "this device" is the device-local thisDeviceItems set; desktop/mobile ride the item's runsOn.
  if (def.enablement !== undefined) {
    const device = item.runsOn?.device;
    if (isThisDevice) {
      badges.push({ text: ON_BADGE_TEXT.local, cls: ON_BADGE_CLASS.local });
    } else if (device === "desktop" || device === "mobile") {
      badges.push({ text: ON_BADGE_TEXT[device], cls: ON_BADGE_CLASS[device] });
    }
  }
  const classPinned = countClassPinned(item);
  if (classPinned > 0) badges.push({ text: `${classPinned} device-scoped`, cls: "config-sync-card-badge-count" });
  const encrypted = countEncrypted(item);
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

// Zone ① copy (spec §4/§10, D2/D4; 2026-07-26 round-3 revision: one row — label left, sharing
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
// snippet member rules on enabledCssSnippets) makes the card per-key ("fields"); none makes it
// whole-file ("plain").
export function deriveMode(sf: ItemSettingsFile): "plain" | "fields" {
  return Object.keys(sf.rules).length > 0 || Object.keys(sf.perElement).length > 0 ? "fields" : "plain";
}

// Item convenience form of the same test — false when the card has no settingsFile at all
// (nothing to derive from).
export function hasKeyRules(item: Item): boolean {
  return item.settingsFile !== undefined && deriveMode(item.settingsFile) === "fields";
}

// Whole-file fileRule legality (C-#25) — mirrors manifest.ts's parseGroup validator EXACTLY
// (manifest.ts:165-169): a fileRule is only legal on a "plain" (or absent, which defaults to
// plain) mode group, never "fields" or "encrypted". Every registry item compiles to type:"file"
// (registry.ts's compileSingleFile), so type is never the deciding factor here — mode always is.
// The Sync Center's Settings-sync menu (only rendered when this is true) and setItemFileSharing's
// write guard (throws when it's false) both gate on this one function so neither can drift from
// what the validator would actually accept.
export function fileRuleLegalForMode(mode: SyncMode | undefined): boolean {
  return mode === undefined || mode === "plain";
}

// ── Fields zone row models (spec §4, D6) ────────────────────────────────────────────────────

export const DEFAULT_FIELD_RULE: ItemFieldRule = { sharing: EVERYWHERE, encrypted: false };

export function isStringArrayValue(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export interface FieldRowModel {
  key: string;
  isArray: boolean;
  rule: ItemFieldRule;
  perElementEnabled: boolean;
}

// The Appearance card's enabledCssSnippets key is never an ordinary rule row — its per-element rule
// lives in the dedicated snippets member rows under Companion folders instead (spec §4/§5); rule
// rows and File preview's click-to-add both exclude it.
export const ENABLED_CSS_SNIPPETS_KEY = "enabledCssSnippets";

// Rule rows list ONLY configured keys (rules ∪ perItem) — browsing the file's full key set is the
// File preview's job now (spec 2026-07-26-card-visual-refresh-design.md §3.1). Key order: rules
// first (insertion order), then perItem-only keys. A key absent from liveDoc (settings file not
// yet re-read, or the key was removed from the file) defaults isArray to false rather than
// throwing.
export function buildRuleRows(def: ItemDef, item: Item, liveDoc: Record<string, unknown>): FieldRowModel[] {
  const sf = item.settingsFile;
  if (sf === undefined) return [];
  const isAppearance = def.section === "obsidian" && def.id === "appearance";
  const keys = [...Object.keys(sf.rules), ...Object.keys(sf.perElement).filter((k) => !(k in sf.rules))].filter(
    (k) => !(isAppearance && k === ENABLED_CSS_SNIPPETS_KEY)
  );
  return keys.map((key) => ({
    key,
    isArray: isStringArrayValue(liveDoc[key]),
    rule: sf.rules[key] ?? DEFAULT_FIELD_RULE,
    perElementEnabled: key in sf.perElement,
  }));
}

// Progressive-disclosure collapsed-row label for a companion's member list (spec
// 2026-07-26-card-visual-refresh-design.md §4): "· N themes" for the themes/ preset, "· N files"
// for everything else.
export function memberCountLabel(isThemesPreset: boolean, n: number): string {
  return isThemesPreset ? `· ${n} themes` : `· ${n} files`;
}

export function encryptDisabledForSharing(sharing: Sharing): boolean {
  return sharing.kind === "this-device";
}

// Encrypt and per-element rules are mutually exclusive on the same rule (manifest.ts's D3
// perItem+encrypted rejection) — final-review MUST-FIX 2 enforces this in BOTH directions at the
// write boundary, not just via disabled controls: encryptToggleDisabled below covers "the Encrypt
// checkbox must render disabled while Per-item is on" (added to the pre-existing this-device
// disable reason); applyPerElementToggle covers "enabling per-element rules must clear encrypted in the SAME
// write", since a rule can already be encrypted:true from before Per-item was ever turned on — a
// disabled checkbox alone only stops a NEW toggle, it doesn't retroactively clear a stale one.
export function encryptToggleDisabled(sharing: Sharing, perElementEnabled: boolean): boolean {
  return encryptDisabledForSharing(sharing) || perElementEnabled;
}

export const PER_ITEM_DISABLED_HINT = "Turn off Encrypt to enable Per-item device rules.";
export const ENCRYPT_DISABLED_PERITEM_HINT = "Turn off Per-item device rules to encrypt.";

// Toggling per-element rules on/off for one Fields-mode row (D3 + MUST-FIX 2): turning it ON must
// clear `encrypted` on the SAME rule in the SAME write.
export function applyPerElementToggle(sf: ItemSettingsFile, key: string, enabled: boolean): ItemSettingsFile {
  const nextPerElement = { ...sf.perElement };
  if (enabled) nextPerElement[key] = nextPerElement[key] ?? {};
  else delete nextPerElement[key];
  if (!enabled) return { ...sf, perElement: nextPerElement };
  const currentRule = sf.rules[key] ?? DEFAULT_FIELD_RULE;
  return { ...sf, rules: { ...sf.rules, [key]: { ...currentRule, encrypted: false } }, perElement: nextPerElement };
}

export interface PerElementRow {
  element: string;
  sharing: Sharing;
}

export function buildPerElementRows(elements: string[], sharings: PerElementSharing): PerElementRow[] {
  return elements.map((element) => ({ element, sharing: sharings[element] ?? EVERYWHERE }));
}

export function defaultSettingsFile(): ItemSettingsFile {
  return { mode: "plain", rules: {}, perElement: {} };
}

// C-#26: prunes semantic defaults off a settingsFile so a sharing round-trip (e.g. desktop →
// everywhere) leaves data.json byte-identical to before the round started, instead of the
// write-back residue that hit the user on 2026-08-09. Two independent prunes, applied in order: a
// fileRule of exactly {sharing: everywhere, encrypted:false} carries no information (it's what an
// absent fileRule already means) and is dropped; if the settingsFile is then left deep-equal to
// defaultSettingsFile() — plain mode, no fileRule, empty rules/perElement — the whole key is
// dropped too, so the field never persists just to say "nothing is customized". Any real content
// (encrypted:true, a rule, a perElement entry, a non-plain mode) always survives untouched. The
// item's own `path` is NOT part of this: it lives on the Item since v3, not inside settingsFile.
export function pruneSettingsFile(sf: ItemSettingsFile): ItemSettingsFile | undefined {
  const fileRule = sf.fileRule !== undefined && sf.fileRule.sharing.kind === "everywhere" && !sf.fileRule.encrypted ? undefined : sf.fileRule;
  const pruned: ItemSettingsFile = { ...sf, fileRule };
  const isDefault =
    pruned.mode === "plain" && pruned.fileRule === undefined && Object.keys(pruned.rules).length === 0 && Object.keys(pruned.perElement).length === 0;
  return isDefault ? undefined : pruned;
}

// ── Appearance specifics (spec §4/§5) ───────────────────────────────────────────────────────

export const SNIPPET_MEMBER_HINT = "Files always sync — each snippet's choice here is where it's turned on.";

export const SNIPPET_ORPHAN_HINT =
  "A deleted file stays listed while it still has a device choice. Forget clears the choice — the next capture then removes the snippet from every device.";

export interface SnippetMemberRow {
  name: string;
  sharing: Sharing;
  fileExists: boolean;
}

// Union of files actually present under snippets/ and any name already given a sharing in
// perElement.enabledCssSnippets (so a ruled-but-since-deleted file doesn't just vanish from view —
// fileExists: false marks those orphans for the pill/Forget affordance).
export function buildSnippetMemberRows(fileNames: string[], perElement: PerElementSharing): SnippetMemberRow[] {
  const files = new Set(fileNames);
  const names = new Set([...fileNames, ...Object.keys(perElement)]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, sharing: perElement[name] ?? EVERYWHERE, fileExists: files.has(name) }));
}

// Writes one snippet member's sharing into perElement[ENABLED_CSS_SNIPPETS_KEY] (final-review blocker:
// the settings-tab dropdown's write path). An everywhere sharing clears that name's entry — and, when the
// map is left empty, deletes the ENABLED_CSS_SNIPPETS_KEY entry from perItem entirely rather than
// leaving `{}` behind: deriveMode counts the KEY's presence, not its contents, so a bare `{}` would
// keep the card stuck in Fields mode forever with nothing to undo it (enabledCssSnippets is
// excluded from rule rows — see ENABLED_CSS_SNIPPETS_KEY above — so there is no ✕ that could ever
// remove a residual empty map). Pure — never mutates sf or its nested maps.
export function withSnippetSharing(sf: ItemSettingsFile, name: string, sharing: Sharing): ItemSettingsFile {
  const sharings = { ...(sf.perElement[ENABLED_CSS_SNIPPETS_KEY] ?? {}) };
  if (sharing.kind === "everywhere") delete sharings[name];
  else sharings[name] = sharing;
  const perElement = { ...sf.perElement };
  if (Object.keys(sharings).length === 0) delete perElement[ENABLED_CSS_SNIPPETS_KEY];
  else perElement[ENABLED_CSS_SNIPPETS_KEY] = sharings;
  return { ...sf, perElement };
}

// ── Companion folders zone (spec §4, D8 — scaffold only; Task 7 wires add/remove/warnings) ──

// Tail hint under a non-snippet companion's member-file list (spec §3.1) — a plain folder has no
// per-file control (see renderPlainCompanionMembers's doc comment), so this clarifies that
// the folder's own device/enabled row above governs every file inside it.
export const FOLDER_MEMBER_HINT = "This folder syncs as a whole — everything in it goes to the devices selected above.";

export interface CompanionRowModel {
  path: string;
  device: DeviceClass;
  enabled: boolean;
  isPreset: boolean;
}

// Presets (themes/, snippets/) must render as a row from the very first open — before the user
// has ever toggled one, cfg.companions has no entry for it yet, so a preset with no matching
// entry gets a synthesized OFF/all-devices default row rather than being missing entirely.
export function buildCompanionRows(def: ItemDef, item: Item): CompanionRowModel[] {
  const configured = item.companions ?? [];
  const byPath = new Map(configured.map((c) => [c.path, c]));
  const presetDefs = def.presetCompanions ?? [];
  const presetPaths = new Set(presetDefs.map((p) => p.path));
  const presetRows: CompanionRowModel[] = presetDefs.map((p) => {
    const existing = byPath.get(p.path);
    return existing !== undefined ? { ...existing, isPreset: true } : { path: p.path, device: "all", enabled: false, isPreset: true };
  });
  const userRows: CompanionRowModel[] = configured.filter((c) => !presetPaths.has(c.path)).map((c) => ({ ...c, isPreset: false }));
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
// path's basename (see registry.ts's compileSingleFile and ItemDef.groupName) — nothing to check there.
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
// folder): file/folder names on disk, deduped and sorted. No per-member sharing chip here — see
// task-7-brief.md/uc-task-7-report.md for why (the switch-list engine only knows
// about community-plugins.json, core-plugins.json and enabledCssSnippets; an arbitrary plain
// directory group has no per-file sharing mechanism to write to).
export function sortCompanionMemberNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

// ── Copy contract (spec §10, verbatim) ──────────────────────────────────────────────────────

// Sharing is a union, so its display vocabulary is a function of the value rather than a record
// keyed by a flat enum — a per-class rule's word depends on the class it carries.
export function sharingLabel(sharing: Sharing): string {
  if (sharing.kind === "everywhere") return "All devices";
  if (sharing.kind === "this-device") return "This device";
  return sharing.class === "desktop" ? "Desktop only" : "Mobile only";
}

export const FILE_SHARING_OPTIONS: Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile")];
// C-#25: what the Sync Center's Settings-sync row shows instead of a menu when
// fileRuleLegalForMode is false — vocabulary matches the More row's "Per-key rules, locks &
// folders" (spec §1) rather than inventing a second phrase for the same idea.
export const FILE_SHARING_MENU_UNAVAILABLE_TEXT = "Per-key rules decide — see More";
export const FIELD_SHARING_OPTIONS: Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];
// ENABLED ON cycle for a manifest-desktop-only plugin: mobile can never install it, so that
// stop is meaningless — the cycle runs everywhere → desktop → this device (round-8 spec §2).
export const DESKTOP_ONLY_ENABLED_OPTIONS: Sharing[] = [EVERYWHERE, perClass("desktop"), THIS_DEVICE];
export const COMPANION_DEVICE_OPTIONS: DeviceClass[] = ["all", "desktop", "mobile"];

// Sharing renders as a Commander-style clickable icon (round-6 定稿): the icon IS the state, a
// click advances to the next option in the row's own option list, wrapping at the end.
export function sharingIcon(sharing: Sharing): string {
  if (sharing.kind === "everywhere") return "monitor-smartphone";
  if (sharing.kind === "this-device") return "airplay";
  return sharing.class === "desktop" ? "monitor" : "smartphone";
}

// Sync Center card "Runs on" row (spec 2026-08-06-c-livetest-batch2-design.md §2, ledger C-#10):
// the five stops the menu offers, in menu order. They are RunsOn VALUES now, not a flat enum —
// the two force stops keep the device axis at "all" and pin the state instead, and their `where`
// stays "everywhere", which is what today's rules do in effect (C-#46; spec §8 keeps that
// question out of this release). "all" mirrors the idle glyph, the two force stops get their own
// (unused elsewhere — verified via `git grep -n '"power'` across src/, 2026-08-06).
export const RUNS_ON_OPTIONS: readonly RunsOn[] = [
  { device: "all" },
  { device: "desktop" },
  { device: "mobile" },
  { device: "all", force: { state: "on", where: "everywhere" } },
  { device: "all", force: { state: "off", where: "everywhere" } },
];

export function runsOnIcon(rule: RunsOn): string {
  if (rule.force !== undefined) return rule.force.state === "on" ? "power" : "power-off";
  if (rule.device === "desktop") return "monitor";
  if (rule.device === "mobile") return "smartphone";
  return "monitor-smartphone";
}

// Runs-on menu labels (spec §4/§6, copy final) — the wording is unchanged from the five values
// this union replaces; only the shape behind it moved.
export function runsOnLabel(rule: RunsOn): string {
  if (rule.force !== undefined) return rule.force.state === "on" ? "Always on here" : "Never on here";
  if (rule.device === "desktop") return "Computers only";
  if (rule.device === "mobile") return "Phones only";
  return "Follows your devices";
}

// A rule is at its default stop when it neither pins a class nor forces a state — the "is-set"
// accent and the menu's checkmark both read this.
export function runsOnIsDefault(rule: RunsOn): boolean {
  return runsOnEquals(rule, { device: "all" });
}

export function nextSharing(current: Sharing, options: readonly Sharing[]): Sharing {
  const i = options.findIndex((o) => sharingEquals(o, current));
  if (i !== -1) {
    const next = options[(i + 1) % options.length];
    if (next === undefined) throw new Error("nextSharing: options list is empty");
    return next;
  }
  // Stored value missing from the offered options (e.g. a stale mobile rule on a desktop-only
  // plugin whose cycle no longer offers mobile): resume from the value's slot in the canonical
  // order to the next offered option instead of snapping back to options[0] (round-8 spec §2 —
  // the cycle continues, the stale stored value is never silently rewritten).
  const canon: readonly Sharing[] = [EVERYWHERE, perClass("desktop"), perClass("mobile"), THIS_DEVICE];
  const start = canon.findIndex((o) => sharingEquals(o, current));
  for (let step = 1; step <= canon.length; step++) {
    const candidate = canon[(start + step) % canon.length];
    if (candidate !== undefined && options.some((o) => sharingEquals(o, candidate))) return candidate;
  }
  throw new Error("nextSharing: options list is empty");
}

// Appended to the everywhere stop of a desktop-only plugin's ENABLED ON cycle: it never touches
// mobile for these plugins (the runtime auto-mask keeps mobile's local state), so the tooltip
// says so instead of letting "All devices" read as "mobile too".
export const DESKTOP_ONLY_ALL_NOTE = "mobile is excluded automatically";

export function sharingCycleTooltip(sharing: Sharing, note?: string): string {
  const label = note === undefined ? sharingLabel(sharing) : `${sharingLabel(sharing)} — ${note}`;
  return `Where it syncs (currently: ${label})`;
}

// Reused as the ✎ icon's tooltip/aria (spec 2026-07-26-card-visual-refresh-design.md §2/§5) — no
// longer an inline toggle label; the toggle itself was deleted, along with `Per-key rules are
// active — remove them to control the whole file again`/`Remove rule`/`Reset to default path`/
// `Encrypt` · `Encrypted`, which are single-call-site literals inlined directly in SettingTab.ts.
export const CUSTOM_PATH_LABEL = "Custom path";
export const PER_ELEMENT_RULES_LABEL = "Per-item device rules";
export const ADD_FOLDER_LABEL = "+ Add folder";
export const SYNC_ALL_LABEL = "Sync all";
export const SYNC_ALL_HINT = "Toggle every plugin below.";
// File-preview footer legend (round-7 spec §2, 定稿 B): color dots + neutral words. The old
// single-string legend rendered as plain text, so the colors it *named* never showed; sharing
// entries reuse the preview's own key color classes so dot and key can never drift apart.
export interface PreviewLegendEntry {
  kind: "sharing" | "lock" | "hint";
  cls: string | null; // dot color class — set exactly when kind is "sharing"
  text: string;
}
export const PREVIEW_LEGEND_ENTRIES: PreviewLegendEntry[] = [
  { kind: "sharing", cls: "config-sync-json-desktop", text: "desktop only" },
  { kind: "sharing", cls: "config-sync-json-mobile", text: "mobile only" },
  { kind: "sharing", cls: "config-sync-json-strip", text: "this device" },
  { kind: "lock", cls: null, text: "encrypted" },
  { kind: "hint", cls: null, text: "click a key to add a rule" },
];

// ── Sync all (spec §4/§5/§10, D11) — one master row per Core/Community/Beta section: toggles
// every card's Item.enabled in that section; its own value is derived (all-enabled), never
// stored separately. No kind-exclusion: every def in the section participates, unlike the old
// per-catalog-section "list"/allowSyncAll split this replaces.

export function sectionAllEnabled(defs: ItemDef[], items: ItemMap): boolean {
  return defs.length > 0 && defs.every((d) => itemFor(items, d).enabled);
}

export function applySyncAll(defs: ItemDef[], items: ItemMap, on: boolean): ItemMap {
  let next = items;
  for (const d of defs) {
    next = withItem(next, d.section, d.id, { ...(itemFor(next, d) ?? emptyItem()), enabled: on });
  }
  return next;
}
