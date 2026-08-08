import { BucketCounts, GroupState, GroupStatus, OTHER_STORE_FILES_GROUP, RemoteDiffEntry } from "../core/status";
import { FileChanges, RuleScope } from "../core/types";
import { Availability, VersionDrift } from "../core/availability";
import { ApplyItem, CaptureItem, StateAction } from "../core/ConfigSyncCore";
import { ItemCategory } from "../core/catalog";
import { memberUniverse, parseSwitchList, switchListMemberOn, switchListOnCount } from "../core/switchList";
import { Fate, FateInput, rowFate } from "./fateModel";

// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
export type Direction = "capture" | "apply";

// Panel row filter. Buckets match core bucketCounts: capture = local-changed + not-captured,
// apply = store-newer + differs, ok = in-sync.
export type PanelFilter = "all" | "capture" | "apply" | "ok" | "none";

// ── Fate-derived buckets (spec 2026-08-08-c-livetest-batch10 §1, ledger C-#23) ──────────────────
// The single per-row bucket derivation: every count/filter/partition/fold consumer reads THIS
// instead of re-deriving from raw GroupState (familyState), so a `↓ Turns on` row (stageable apply,
// sitting on a no-settings/in-sync GroupState) counts/filters/folds as "apply" — the same bucket
// its rendered sentence implies — never falls through to whatever its raw state happens to say.
// `nothingYet` is the same FateInput field already computed for the row's own sentence — no new
// state is introduced.
export type FateBucket = "conflict" | "apply" | "capture" | "ok" | "none";

export function fateBucket(fate: Fate, nothingYet: boolean): FateBucket {
  if (fate.glyph === "⚠") return "conflict";
  if (fate.stageable && fate.glyph === "↓") return "apply";
  if (fate.stageable && fate.glyph === "↑") return "capture";
  if (nothingYet) return "none";
  return "ok";
}

// "locked" (encrypted, no passphrase set) never runs content comparison, so it has no fate-based
// reading — fateBucket's own contract stays fate-only, five values. "locked" is a sixth, orthogonal
// placement callers add for that one genuine GroupState case (SyncCenterView's rowBucket) — it is
// NOT produced by fateBucket itself.
export type RowBucket = FateBucket | "locked";

// Filter-pill visibility (spec §1.3): a conflict-bucket row stays visible under the "apply" filter
// — its current placement, preserved (today a `differs` GroupState is already included there)
// — rather than growing a dedicated "conflict" filter pill. "locked" is visible only under "all",
// also today's placement (content comparison never ran for it, so no specific filter can claim it).
export function visibleUnderFilter(bucket: RowBucket, filter: PanelFilter): boolean {
  if (filter === "all") return true;
  if (bucket === "locked") return false;
  if (filter === "capture") return bucket === "capture";
  if (filter === "apply") return bucket === "apply" || bucket === "conflict";
  if (filter === "none") return bucket === "none";
  return bucket === "ok";
}

// Filter-pill counts (spec §1.2): the apply pill counts the apply bucket AND conflict (its current
// placement, preserved — a `differs` GroupState already counts under the "down"/To-apply pill
// today); the capture pill counts capture; "In sync" = ok; "No settings yet" = none plus locked
// (also today's placement — bucketCounts already groups raw "locked" under `none`).
export function fateBucketCounts(buckets: RowBucket[]): BucketCounts {
  let up = 0;
  let down = 0;
  let ok = 0;
  let none = 0;
  for (const b of buckets) {
    if (b === "capture") up++;
    else if (b === "apply" || b === "conflict") down++;
    else if (b === "ok") ok++;
    else none++; // "none" | "locked"
  }
  return { up, down, ok, none };
}

// Section partition (spec §1.1): active = conflict|apply|capture (plus locked — today's placement,
// preserved: a locked row is currently neither in-sync nor no-settings, so it renders active,
// unfolded); the folds hold ONLY ok/none.
export type PartitionSection = "active" | "insync" | "nosettings";

export function partitionSection(bucket: RowBucket): PartitionSection {
  if (bucket === "ok") return "insync";
  if (bucket === "none") return "nosettings";
  return "active"; // conflict | apply | capture | locked
}

export interface CappedEntry {
  kind: "add" | "upd" | "del";
  name: string;
}

// Flattens a change set (added → updated → deleted) and splits it at `limit`
// so the detail view can render `shown` plus a "… N more files ▸" line for `rest`.
export function capFileEntries(changes: FileChanges, limit: number): { shown: CappedEntry[]; rest: CappedEntry[] } {
  const all: CappedEntry[] = [
    ...changes.added.map((name): CappedEntry => ({ kind: "add", name })),
    ...changes.updated.map((name): CappedEntry => ({ kind: "upd", name })),
    ...changes.deleted.map((name): CappedEntry => ({ kind: "del", name })),
  ];
  return { shown: all.slice(0, limit), rest: all.slice(limit) };
}

export function insyncLineText(n: number, open: boolean): string {
  return `✓ ${n} item${n === 1 ? "" : "s"} in sync ${open ? "▾" : "▸"}`;
}

export function moreFilesText(n: number): string {
  return `… ${n} more files ▸`;
}

// Default direction by state: capture for local-changed/not-captured, apply otherwise.
export function directionForState(state: GroupState): Direction {
  return state === "local-changed" || state === "not-captured" ? "capture" : "apply";
}

// Version-ahead presentation (定稿 feedback-trio, 2026-07-16): an item whose content matches
// the store but whose LOCAL version is newer than the store's lock entry presents as
// to-capture — capturing refreshes the lock version so other devices' outdated flow can fire.
// Core state stays "in-sync"; this is a view-level derivation.
export function presentedState(state: GroupState, drift: VersionDrift): GroupState {
  return state === "in-sync" && drift === "ahead" ? "local-changed" : state;
}

// Inert states (checkbox disabled) can never be staged: they must not survive in the staged
// set, count into the footer, or enter a capture/apply payload — otherwise items that just
// became in-sync keep inflating "Apply N items" with stale selections.
export function stageableState(state: GroupState): boolean {
  return state !== "in-sync" && state !== "no-settings" && state !== "locked";
}

// The staged direction: an explicit user choice wins over the state default.
export function effectiveDirection(state: GroupState, override: Direction | undefined): Direction {
  return override ?? directionForState(state);
}

export function matchesSearch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

export function nosettingsLineText(n: number, open: boolean): string {
  return `○ ${n} item${n === 1 ? "" : "s"} with no settings yet ${open ? "▾" : "▸"}`;
}

export type SectionKind = "main" | "outdated" | "disabled" | "not-installed" | "desktop-only";

// Unified rule (spec 2026-07-17, closes the install-only/enable-only/update-only family): in
// the non-main sections the state ACTION is the payload, so every row stages except locked —
// an empty settings transfer (no-settings, in-sync) no longer gates interaction. Main-section
// rows keep the plain stageability (there is no action to run there).
export function stageableRow(state: GroupState, section: SectionKind): boolean {
  if (section === "desktop-only") return false; // informational only — can't run here, nothing to stage
  if (section !== "main") return state !== "locked";
  return stageableState(state);
}

// isMobile: a desktop-only plugin (author-declared) can't run on a phone — whether it's
// not-installed or installed-but-disabled (Obsidian refuses to enable it there). Either way it's
// surfaced informationally rather than offered for a failing install/enable. A (practically
// impossible) enabled one stays in main so a running plugin isn't mislabelled "nothing to do".
export function sectionForItem(a: Availability, isMobile: boolean): SectionKind {
  if (isMobile && a.desktopOnly && a.kind !== "enabled") return "desktop-only";
  if (a.kind === "not-installed") return "not-installed";
  if (a.kind === "disabled") return "disabled";
  if (a.anchor === "plugin" && a.drift === "behind") return "outdated";
  return "main";
}

// The status bar's data set: the same rows the Sync Center's header pills count — main-section
// only, with the version-ahead presentation applied. Rows the center files under its own
// sections (desktop-only / disabled / not-installed / outdated) are excluded here too;
// counting them raw made the bar disagree with the center forever on devices where such
// sections are populated (2026-07-27 phone find: center "in sync", bar "↓2"). A group with no
// availability info is kept as-is — hiding it could silently blank a real pending state.
export function statusBarStatuses(
  statuses: GroupStatus[],
  availabilityOf: (group: string) => Availability | undefined,
  isMobile: boolean
): GroupStatus[] {
  return statuses.flatMap((st) => {
    const a = availabilityOf(st.group);
    if (a === undefined) return [st];
    if (sectionForItem(a, isMobile) !== "main") return [];
    return [{ ...st, state: presentedState(st.state, a.drift) }];
  });
}

// Cold-start guidance (spec 2026-07-27): show only while the plugin's own settings are still
// pending (coldstart/adopt/both) AND some group has never synced on this device. "capture"
// pending is a normal working state, not a cold start. Dismissal is device-local and cleared
// by main.ts when self returns to insync, so a future genuine cold start shows it again.
export function showColdStartBanner(
  selfState: "coldstart" | "adopt" | "capture" | "both" | "insync",
  statuses: GroupStatus[],
  dismissed: boolean
): boolean {
  if (dismissed) return false;
  if (selfState !== "coldstart" && selfState !== "adopt" && selfState !== "both") return false;
  return statuses.some((s) => s.state === "never-synced");
}

export interface PolicyOption {
  action: StateAction;
  label: string;
  pill: string | null; // collapsed-row pill; null = no state action
}

export function policyOptions(a: Availability): PolicyOption[] {
  if (a.kind === "not-installed") {
    return [
      { action: "install-enable", label: "⤓ Install & enable", pill: "⤓ install & enable" },
      { action: "install", label: "⤓ Install", pill: "⤓ install" },
      { action: "none", label: "Settings only", pill: null },
    ];
  }
  if (a.kind === "disabled") {
    if (a.anchor === "plugin" && a.drift === "behind") {
      return [
        { action: "update-enable", label: "⤓ Update & enable", pill: "⤓ update & enable" },
        { action: "enable", label: "⏻ Enable", pill: "⏻ enable" },
        { action: "none", label: "Keep disabled", pill: null },
      ];
    }
    return [
      { action: "enable", label: "⏻ Enable", pill: "⏻ enable" },
      { action: "none", label: "Keep disabled", pill: null },
    ];
  }
  if (a.anchor === "plugin" && a.drift === "behind") {
    // Update targets the version the store's settings were captured on (方案 c), not "latest":
    // drift === "behind" guarantees storeVersion is non-null.
    return [
      { action: "update", label: `⤓ Update to ${a.storeVersion}`, pill: "⤓ update" },
      { action: "none", label: `Keep ${a.localVersion ?? "current"}`, pill: null },
    ];
  }
  return [];
}

export function defaultPolicy(a: Availability): StateAction {
  return policyOptions(a)[0]?.action ?? "none";
}

// A stored policy is only valid for the ladder of the item's *current* availability —
// e.g. "update-enable" belongs to a disabled+behind ladder, not the outdated-only ladder.
export function isValidPolicy(a: Availability, action: StateAction): boolean {
  return policyOptions(a).some((o) => o.action === action);
}

// The busy-button label during a capture/apply run — arrow-prefixed to match the idle
// "↑ Capture N items" / "↓ Apply N items" buttons. Rendered from the view's activeRun state so a
// mid-run rebuild shows live progress instead of the stale staged count.
export function runProgressLabel(verb: "Capturing" | "Applying", done: number, total: number): string {
  return `${verb === "Capturing" ? "↑" : "↓"} ${verb} ${done}/${total}…`;
}

// ── In-place "where it runs" guidance (spec 2026-07-28 §4) ────────────────────────────────────

export interface MemberDecision {
  id: string;
  scope: "local" | "desktop" | "mobile";
  // Structural (spec 2026-08-05-section-groups-and-member-menu-design.md §R3-A): true iff the
  // "local" scope exists solely because the item's settings-sync card is off — not a rule the
  // user pinned (no localMembers entry, no enabledOn). Always false for desktop/mobile scopes.
  structural: boolean;
}

// Every per-member decision worth a note row: ⌂ local exceptions plus device-class rules.
// `structuralIds` names elements whose "local" scope is structural (registry.ts's
// structuralLocalElements) — the derivation into MemberDecision.structural happens here, in the
// pure layer, rather than being handed down as a pre-computed per-decision flag.
export function memberDecisionsFromScopes(scopes: Record<string, RuleScope>, structuralIds: ReadonlySet<string>): MemberDecision[] {
  return Object.entries(scopes)
    .filter((e): e is [string, "local" | "desktop" | "mobile"] => e[1] !== "all")
    .map(([id, scope]) => ({ id, scope, structural: scope === "local" && structuralIds.has(id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── Enablement single entry (spec 2026-08-06-enablement-single-entry-design.md #5-B) ─────────

export type EnablementCarrier = "core-plugins" | "community-plugins";

// The switch-list group that carries a plugin's on/off state: community items compile as
// `plugin-<id>`; core items ARE their carrier ladder's element id (no prefix).
export function enablementCarrierFor(itemGroup: string): EnablementCarrier {
  return itemGroup.startsWith("plugin-") ? "community-plugins" : "core-plugins";
}

// True when that carrier is itself a synced (compiled) item — the on/off card then owns
// enablement outright, and the disabled item's own per-card policy never runs.
export function carrierIsSynced(itemGroup: string, compiledGroupNames: readonly string[]): boolean {
  return compiledGroupNames.includes(enablementCarrierFor(itemGroup));
}

// ── Unified grammar view skeleton (spec 2026-08-06-sync-center-unified-grammar-design.md §2) ──
// Replaces the old main/outdated/disabled/not-installed/desktop-only dichotomy: every row lives
// in exactly one of these four fixed sections, keyed off its scope — readiness state (outdated,
// disabled, not installed…) becomes row-level fate instead of a separate section.

export type TypeSection = "obsidian" | "core" | "community" | "folders";

export const TYPE_SECTION_TITLES: Record<TypeSection, string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  community: "Community plugins",
  folders: "Your folders",
};

// Fixed display order (spec §2), alphabetical within each section separately (byLabel).
export const TYPE_SECTION_ORDER: readonly TypeSection[] = ["obsidian", "core", "community", "folders"];

// beta plugins sit in the Community section (parity with the settings Beta tab pinning them
// alongside community plugins); custom groups (+ Add folder) are "Your folders".
export function typeSectionForRow(defSection: ItemCategory | "beta"): TypeSection {
  if (defSection === "beta") return "community";
  if (defSection === "custom") return "folders";
  return defSection;
}

// Section header count pill: "31" when nothing narrows the section, "6 of 31" once a state
// filter or a search query hides some of its rows.
export function sectionCountLabel(total: number, visible: number, filtered: boolean): string {
  return filtered ? `${visible} of ${total}` : `${total}`;
}

// ── Remote pane C-grammar model (2026-08-07-c-livetest-batch4 task 1) ──────────────────────────
// Buckets a remote's raw file diff into the same four TYPE_SECTION_ORDER sections the main list
// uses: the two switch-list carriers never appear as an ordinary row (their delta is an on/off
// summary, not a file to diff), everything else sorts into the section its category maps to.

export interface RemoteSectionModel {
  section: TypeSection;
  onOff: RemoteDiffEntry | null;
  entries: RemoteDiffEntry[];
}

export function remoteSections(
  entries: RemoteDiffEntry[],
  categoryOf: (group: string) => ItemCategory | "beta",
  displayNameOf: (group: string) => string
): RemoteSectionModel[] {
  const onOffBySection: Partial<Record<TypeSection, RemoteDiffEntry>> = {};
  const rowsBySection = new Map<TypeSection, RemoteDiffEntry[]>();
  for (const e of entries) {
    if (e.group === "core-plugins") {
      onOffBySection.core = e;
      continue;
    }
    if (e.group === "community-plugins") {
      onOffBySection.community = e;
      continue;
    }
    const section = typeSectionForRow(categoryOf(e.group));
    const rows = rowsBySection.get(section) ?? [];
    rows.push(e);
    rowsBySection.set(section, rows);
  }
  // (other store files) is unattributed metadata, not a real folder — it sorts last within Your
  // folders regardless of display name so a genuine delta is never buried under it.
  const byDisplayName = (a: RemoteDiffEntry, b: RemoteDiffEntry): number => {
    if (a.group === OTHER_STORE_FILES_GROUP) return b.group === OTHER_STORE_FILES_GROUP ? 0 : 1;
    if (b.group === OTHER_STORE_FILES_GROUP) return -1;
    return displayNameOf(a.group).localeCompare(displayNameOf(b.group));
  };
  return TYPE_SECTION_ORDER.flatMap((section): RemoteSectionModel[] => {
    const onOff = onOffBySection[section] ?? null;
    const sectionEntries = (rowsBySection.get(section) ?? []).sort(byDisplayName);
    if (onOff === null && sectionEntries.length === 0) return [];
    return [{ section, onOff, entries: sectionEntries }];
  });
}

// A carrier's on/off delta between the local store and a remote, as a plain set diff over
// membership — reuses parseSwitchList's shape handling so community-plugins.json (array) and
// core-plugins.json (map) both work, and degrades an unparseable/absent side to "nothing on"
// rather than throwing (a remote file that failed to fetch must still render, not crash the pane).
// remoteOnCount/localOnCount are the per-side SOURCE on-set sizes the batch-8 narration needs
// (spec §1): onAtRemote's source is the remote list's total on-member count, offAtRemote's is the
// store (local) list's — extended onto this return rather than re-parsing in a sibling function,
// since both lists are already parsed here.
export interface OnOffFlipsResult {
  onAtRemote: string[];
  offAtRemote: string[];
  remoteOnCount: number;
  localOnCount: number;
}

export function onOffFlips(local: string | null, remote: string | null): OnOffFlipsResult {
  const localList = local === null ? null : parseSwitchList(local);
  const remoteList = remote === null ? null : parseSwitchList(remote);
  const onAtRemote: string[] = [];
  const offAtRemote: string[] = [];
  for (const id of memberUniverse(localList, remoteList)) {
    const onLocal = switchListMemberOn(localList, id);
    const onRemote = switchListMemberOn(remoteList, id);
    if (onRemote && !onLocal) onAtRemote.push(id);
    else if (onLocal && !onRemote) offAtRemote.push(id);
  }
  return {
    onAtRemote: onAtRemote.sort(),
    offAtRemote: offAtRemote.sort(),
    remoteOnCount: switchListOnCount(remoteList),
    localOnCount: switchListOnCount(localList),
  };
}

export function onOffLineText(n: number, open: boolean): string {
  return `On/off list · differs for ${n} plugin${n === 1 ? "" : "s"} ${open ? "▾" : "▸"}`;
}

// Cap on display names shown per side before collapsing to "and N more" (spec
// 2026-08-08-c-livetest-batch8 §1).
const ONOFF_NARRATION_CAP = 5;

export interface OnOffNarrationLine {
  prefix: string; // e.g. "on at kickstart: " — plain narration text
  value: string; // e.g. "its entire list — 74 plugins" / "A, B, C, D, E, and 69 more" — the emphasized part
}

// One side's expanded narration (spec §1): a side's flip count equalling its source on-set size
// means every on-member flipped — the whole-list case (covers the fresh/empty-other-side wall of
// ids) — otherwise up to ONOFF_NARRATION_CAP display names, sorted, then "and N more" once
// truncated. An empty side yields no line (unchanged: still omitted entirely).
function onOffSideLine(
  ids: string[],
  sourceOnCount: number,
  prefix: string,
  wholeListPhrase: string,
  displayOf: (elementId: string) => string
): OnOffNarrationLine | null {
  if (ids.length === 0) return null;
  if (ids.length === sourceOnCount) {
    return { prefix, value: `${wholeListPhrase} — ${ids.length} plugin${ids.length === 1 ? "" : "s"}` };
  }
  const names = [...ids.map(displayOf)].sort((a, b) => a.localeCompare(b));
  if (names.length <= ONOFF_NARRATION_CAP) return { prefix, value: names.join(", ") };
  const shown = names.slice(0, ONOFF_NARRATION_CAP);
  return { prefix, value: `${shown.join(", ")}, and ${names.length - ONOFF_NARRATION_CAP} more` };
}

// Ready-to-render expanded on/off narration lines (spec 2026-08-08-c-livetest-batch8 §3):
// `displayOf` resolves a flip's element id to its display name through the pane's own
// group-name → storedLabel → displayParts chain (§2), so narration names never disagree with row
// names. Either side is null when its flip list is empty.
export function onOffNarrationLines(
  onAtRemote: string[],
  offAtRemote: string[],
  remoteOnCount: number,
  localOnCount: number,
  displayOf: (elementId: string) => string,
  remoteName: string
): { on: OnOffNarrationLine | null; off: OnOffNarrationLine | null } {
  return {
    on: onOffSideLine(onAtRemote, remoteOnCount, `on at ${remoteName}: `, "its entire list", displayOf),
    off: onOffSideLine(offAtRemote, localOnCount, `off at ${remoteName}: `, "everything in your store's list", displayOf),
  };
}

// ── Family rollup (spec 2026-08-07-c-livetest-batch5 task 1) ───────────────────────────────────
// A "family" is a parent object plus its companion groups (e.g. Appearance's themes/snippets
// dirs) — principle #1's "one object = one row" means the family presents through ONE state,
// derived here, rather than each companion surfacing its own row.

export interface FamilyMember {
  name: string;
  state: GroupState;
  fileCount: number;
}

export interface FamilyRollup {
  state: GroupState;
  applyMembers: string[];
  captureMembers: string[];
  applyFiles: number;
  captureFiles: number;
}

function isApplyDirectionState(state: GroupState): boolean {
  return state === "store-newer" || state === "never-synced";
}

function isCaptureDirectionState(state: GroupState): boolean {
  return state === "local-changed" || state === "not-captured";
}

// Any member `differs` forces the whole family into conflict (reuses the existing conflict
// grammar — no new controls). Otherwise a family with members pulling BOTH ways is itself a
// conflict, even though no single member is individually `differs` (e.g. the parent wants to
// apply while a companion wants to capture). One-direction families adopt the FIRST
// direction-contributing member's own literal state (the parent, when it is itself directional,
// since callers pass it first) — this keeps a companion-less family's rollup byte-identical to
// that member's own state, never inventing a different literal value.
export function familyRollup(members: FamilyMember[]): FamilyRollup {
  const applyMembers: string[] = [];
  const captureMembers: string[] = [];
  let applyFiles = 0;
  let captureFiles = 0;
  let anyDiffers = false;
  let applyState: GroupState | null = null;
  let captureState: GroupState | null = null;

  for (const m of members) {
    if (m.state === "differs") {
      anyDiffers = true;
      continue;
    }
    if (isApplyDirectionState(m.state)) {
      applyMembers.push(m.name);
      applyFiles += m.fileCount;
      if (applyState === null) applyState = m.state;
      continue;
    }
    if (isCaptureDirectionState(m.state)) {
      captureMembers.push(m.name);
      captureFiles += m.fileCount;
      if (captureState === null) captureState = m.state;
    }
    // in-sync / no-settings / locked members: neutral — neither list, no file count.
  }

  if (anyDiffers || (applyMembers.length > 0 && captureMembers.length > 0)) {
    return { state: "differs", applyMembers, captureMembers, applyFiles, captureFiles };
  }
  if (applyState !== null) return { state: applyState, applyMembers, captureMembers, applyFiles, captureFiles };
  if (captureState !== null) return { state: captureState, applyMembers, captureMembers, applyFiles, captureFiles };
  // No directional or differs member: every member here is neutral (in-sync/no-settings/locked —
  // the only states isApplyDirectionState/isCaptureDirectionState/"differs" don't already claim).
  // Adopt the PARENT's (first member's) own state rather than a special-cased "in-sync"/
  // "no-settings" guess — preserves current behavior for EVERY neutral state, including "locked",
  // without inventing a rule the parent's real state doesn't already answer.
  const neutralState = members[0]?.state ?? "in-sync";
  return { state: neutralState, applyMembers, captureMembers, applyFiles, captureFiles };
}

// Concatenates a family's members' file changes into one set for the expanded card (spec §4
// "Files"), rewriting each companion's paths relative to the family so `themes/Foo.css` reads
// as a path under the parent rather than a bare `Foo.css` that collides with the parent's own
// files. The parent itself passes `prefix: null` — its paths are already correct as-is.
export function mergeFamilyChanges(parts: { prefix: string | null; changes: FileChanges }[]): FileChanges {
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const { prefix, changes } of parts) {
    const withPrefix = (rel: string): string => (prefix === null ? rel : `${prefix}/${rel}`);
    added.push(...changes.added.map(withPrefix));
    updated.push(...changes.updated.map(withPrefix));
    deleted.push(...changes.deleted.map(withPrefix));
  }
  return { added, updated, deleted };
}

// Folds a remote diff's companion entries into their parent's entry (spec §7 remote pane stays
// unchanged in shape — only companions dissolve), so the remote pane shows the same one-row-per-
// family grammar as the main list. `parentOf` returns null for non-companions (they pass
// through untouched). Order is first-seen: a family's position in the result is wherever its
// parent entry OR its first companion appears first in `entries`.
export function foldCompanionEntries(entries: RemoteDiffEntry[], parentOf: (group: string) => string | null): RemoteDiffEntry[] {
  const result: RemoteDiffEntry[] = [];
  const byGroup = new Map<string, RemoteDiffEntry>();
  const entryFor = (group: string): RemoteDiffEntry => {
    let e = byGroup.get(group);
    if (e === undefined) {
      e = { group, files: [] };
      byGroup.set(group, e);
      result.push(e);
    }
    return e;
  };
  for (const e of entries) {
    const parent = parentOf(e.group);
    if (parent === null) {
      entryFor(e.group).files.push(...e.files);
      continue;
    }
    const target = entryFor(parent);
    target.files.push(...e.files.map((f) => ({ ...f, itemRel: `${e.group}/${f.itemRel}` })));
  }
  return result;
}

// The action bar's staged-selection line (replaces the old 5-param footerSummary once the view
// derives every count from Fate — spec §5). `applyN`/`captureN` are the two direction totals;
// installs/turnsOn/settings are an apply-side breakdown (subsets of applyN, no "+").
export function unifiedFooterSummary(sel: { applyN: number; installs: number; turnsOn: number; settings: number; captureN: number }): string {
  const total = sel.applyN + sel.captureN;
  if (total === 0) return "Nothing selected";
  const parts: string[] = [];
  if (sel.installs > 0) parts.push(`installs ${sel.installs}`);
  if (sel.turnsOn > 0) parts.push(`turns on ${sel.turnsOn}`);
  if (sel.settings > 0) parts.push(`settings ${sel.settings}`);
  if (sel.captureN > 0) parts.push(`captures ${sel.captureN}`);
  if (parts.length === 0) return `${total} selected`;
  return `${total} selected — ${parts.join(" · ")}`;
}

// ── Expanded-card file entries (spec §4, ledger #8) ─────────────────────────────────────────────
// FileChanges (capFileEntries's source) is always computed from the CAPTURE side's perspective
// (types.ts/status.ts): "added" = present locally, absent from the store; "deleted" = present in
// the store, absent locally; "updated" = present on both sides, differs. Under capture direction
// that perspective already IS the effective action. Under apply direction the target is local, so
// added/deleted mirror each other: a store-only file ("deleted", capture-perspective) is really a
// brand-new file landing locally (nothing to diff against — "view" the incoming content); a
// local-only file ("added") is really removed once apply makes local match the store. This mirror
// is the fix for ledger #8 (a not-installed plugin's incoming settings used to render as a
// strikethrough deletion).

export interface FileEntryPresentation {
  glyph: "+" | "↑" | "del" | "·";
  label: string;
  affordance: "view" | "diff" | "none";
  note: string | null;
}

export function fileEntryFor(
  change: { kind: "added" | "updated" | "deleted"; rel: string },
  effDir: "apply" | "capture",
  encrypted: boolean
): FileEntryPresentation {
  const effectiveKind: "added" | "updated" | "deleted" =
    effDir === "capture" ? change.kind : change.kind === "added" ? "deleted" : change.kind === "deleted" ? "added" : "updated";

  // A real deletion never has content to preview — encryption is moot, and the "del" glyph
  // drives the collapsed/expanded strikethrough regardless of direction (#8's other rule: "del"
  // strikethrough only when the EFFECTIVE direction actually deletes, i.e. only here).
  if (effectiveKind === "deleted") {
    return { glyph: "del", label: change.rel, affordance: "none", note: null };
  }

  const ENCRYPTED_NOTE = "changed — encrypted, no preview";
  if (effDir === "capture") {
    return { glyph: "↑", label: change.rel, affordance: encrypted ? "none" : "diff", note: encrypted ? ENCRYPTED_NOTE : null };
  }
  // apply, content-bearing (added = brand-new to local, updated = both sides exist)
  const glyph = effectiveKind === "added" ? "+" : "·";
  const affordance = effectiveKind === "added" ? "view" : "diff";
  return { glyph, label: change.rel, affordance: encrypted ? "none" : affordance, note: encrypted ? ENCRYPTED_NOTE : null };
}

// ── Unified staging (spec §5, task 6) ───────────────────────────────────────────────────────────
// Replaces the old policy/disabled ladders (defaultPolicy, disabledRowAction) for the unified
// grammar: the run payload is derived straight from each row's checkbox + Fate, with the
// two on/off carriers' member state collected separately from their own file-level entry.

export type ConflictChoice = "apply" | "capture";

export interface StageableRow {
  id: string;
  itemName: string;
  fate: Fate;
  selected: boolean;
  carrier: EnablementCarrier | null;
  elementId: string | null;
  availability: Availability | null;
  conflictChoice: ConflictChoice | null;
  conflict: boolean;
  // Names of the row's companion groups actionable in each direction (family rollup's
  // applyMembers/captureMembers, parent name excluded — it's `itemName`). Empty for a row with
  // no companions, which reduces stagedPayload's fan-out below to a no-op.
  companionNames: { apply: string[]; capture: string[] };
}

// Row action matrix (replaces defaultPolicy for the unified grammar): a not-installed row
// ignores hasUpdate entirely (there's nothing installed to be behind); an installed row behind
// the store's captured version offers update; everything else is a plain enable/none. `turnsOn`
// (Fate's own field) is the single switch deciding every "…-enable" suffix.
function stagedAction(a: Availability | null, turnsOn: boolean): StateAction {
  if (a !== null && a.kind === "not-installed") return turnsOn ? "install-enable" : "install";
  if (a !== null && a.anchor === "plugin" && a.drift === "behind") return turnsOn ? "update-enable" : "update";
  return turnsOn ? "enable" : "none";
}

// A row's run direction: a conflict resolves through the session choice (null = still
// unresolved — the caller excludes it before this ever runs); every other row's fate glyph
// already IS its direction (↓ apply, ↑ capture) — "—" (in sync / nothing yet) carries no
// direction and never stages.
function rowDirection(row: StageableRow): "apply" | "capture" | null {
  if (row.conflict) return row.conflictChoice;
  if (row.fate.glyph === "↓") return "apply";
  if (row.fate.glyph === "↑") return "capture";
  return null;
}

// stagedPayload(rows): pure derivation from the current checkbox/conflict-choice session state
// to the two run payloads (spec §5). Unselected rows and unresolved conflicts are excluded —
// never stageable. A plugin row with a synced carrier contributes its elementId to that
// carrier's stagedMembers on the SAME side it runs on: apply only when its fate would actually
// turn it on here (an id left out of stagedMembers keeps its current value, so a settings-only
// apply can't accidentally move a member it never meant to touch); capture always (a capture
// pushes local state as-is, on or off — there's no "turnsOn" concept on that side, the
// partial-selection symmetry spec §5 calls for). The carrier's own item — reused from its own
// row when that row is itself staged (the carrier file differs on its own), else synthesized —
// always carries `stagedMembers` once it exists, even `[]`, so a run that stages only settings
// (no member) can never fall back to the whole-list write.
export function stagedPayload(rows: StageableRow[]): { apply: ApplyItem[]; capture: CaptureItem[] } {
  const apply: ApplyItem[] = [];
  const capture: CaptureItem[] = [];
  const applyMembers: Record<EnablementCarrier, string[]> = { "core-plugins": [], "community-plugins": [] };
  const captureMembers: Record<EnablementCarrier, string[]> = { "core-plugins": [], "community-plugins": [] };

  for (const row of rows) {
    if (!row.selected) continue;
    if (row.conflict && row.conflictChoice === null) continue;
    const dir = rowDirection(row);
    if (dir === null) continue;

    if (row.carrier !== null && row.elementId !== null) {
      const contributes = dir === "apply" ? row.fate.turnsOn : true;
      if (contributes) (dir === "apply" ? applyMembers : captureMembers)[row.carrier].push(row.elementId);
    }

    // Companion fan-out: a staged family row also stages its actionable companions, as plain
    // `{ name, action: "none" }` entries — the companion's own content is the payload, there is
    // no install/update/enable dimension for it. Deduped against anything already pushed to this
    // side (a companion staged twice would otherwise double up in a multi-row run).
    if (dir === "apply") {
      apply.push({ name: row.itemName, action: stagedAction(row.availability, row.fate.turnsOn) });
      for (const name of row.companionNames.apply) {
        if (!apply.some((i) => i.name === name)) apply.push({ name, action: "none" });
      }
    } else {
      // Capture never enables as a side effect of its plain settings/member push (there's no
      // "turnsOn" concept on that side by default — rowFate always hands capture rows turnsOn:
      // false) — EXCEPT the Enablement fallback row's explicit "Turn it on" choice, which
      // `effectiveFate`/`fallbackTurnsOn` fold into `row.fate.turnsOn` the same way they do for
      // apply (spec 2026-08-06 §4 Enablement amendment: restores the pre-C capture-side enable).
      capture.push({ name: row.itemName, action: row.fate.turnsOn ? "enable" : "none" });
      for (const name of row.companionNames.capture) {
        if (!capture.some((i) => i.name === name)) capture.push({ name, action: "none" });
      }
    }
  }

  for (const carrier of ["core-plugins", "community-plugins"] as const) {
    const members = applyMembers[carrier];
    const existing = apply.find((i) => i.name === carrier);
    if (existing !== undefined) existing.stagedMembers = members;
    else if (members.length > 0) apply.push({ name: carrier, action: "none", stagedMembers: members });
  }
  for (const carrier of ["core-plugins", "community-plugins"] as const) {
    const members = captureMembers[carrier];
    const existing = capture.find((i) => i.name === carrier);
    if (existing !== undefined) existing.stagedMembers = members;
    else if (members.length > 0) capture.push({ name: carrier, action: "none", stagedMembers: members });
  }

  return { apply, capture };
}

// The single per-row fate derivation shared by every consumer that needs to know "what will
// this row's run actually do" — staging (feeds stagedPayload via the caller's stagedRows()),
// footer counts, and the resolved-conflict display all call this SAME function instead of each
// re-deriving their own copy (review fix, task 6 round 2: a resolved conflict's displayed
// "turns on" and its actual staged action must never be able to disagree, and the footer's
// "turns on" count must never disagree with the payload's).
//
// Two independent adjustments, composable: (1) a resolved conflict (`conflictChoice` non-null on
// a `⚠` fate) re-derives a REAL directed fate via `rowFate` itself — never the frozen
// `turnsOn: false` the conflict branch always returns — so "Use theirs" on a plugin whose store
// switch-list state would turn it on genuinely stages that. (2) `fallbackTurnsOn` folds in the
// two carrier-unsynced fallback ladders' menu choice (After install / Enablement, spec §4) —
// `Fate.turnsOn` is unconditionally `false` there by design (the sentence must stay free of
// enablement verbs per spec §3), so the caller computes that choice separately and passes it
// through here rather than `rowFate` ever seeing it.
export function effectiveFate(fate: Fate, input: FateInput, conflictChoice: ConflictChoice | null, fallbackTurnsOn: boolean): Fate {
  const resolved = fate.glyph === "⚠" && conflictChoice !== null ? rowFate({ ...input, conflict: false, direction: conflictChoice }) : fate;
  return fallbackTurnsOn ? { ...resolved, turnsOn: true } : resolved;
}
