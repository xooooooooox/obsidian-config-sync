import { BucketCounts, GroupState, GroupStatus, RemoteDiffEntry, RemoteState } from "../core/status";
import { FileChanges, sharingClass, StorageSection, SyncGroup } from "../core/types";
import { Availability, VersionDrift } from "../core/availability";
import { carrierRef, refItemId } from "../core/itemKeys";
import { ApplyItem, CaptureItem, StateAction } from "../core/ConfigSyncCore";
import { EnablementList, memberUniverse, parseSwitchList, switchListMemberOn, switchListOnCount } from "../core/switchList";
import { Fate, FateInput, NOTHING_YET_SENTENCE, rowFate } from "./fateModel";
import { SyncAction } from "./actionIcons";
import { ENABLEMENT_CARRIER_GROUPS } from "../core/switchList";

// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
export type Direction = "capture" | "apply";

// Panel row filter. Buckets match core bucketCounts: capture = local-changed + not-captured,
// apply = store-newer + differs, ok = in-sync. "leftover" narrows the view to the store-orphan
// section alone — no ROW is ever a leftover, so every bucket hides under it.
export type PanelFilter = "all" | "capture" | "apply" | "ok" | "excluded" | "none" | "leftover";

// The single per-row bucket derivation: every count/filter/partition/fold consumer reads THIS
// instead of re-deriving from raw GroupState (familyState), so a `↓ Turns on` row (stageable apply,
// sitting on a no-settings/in-sync GroupState) counts/filters/folds as "apply" — the same bucket
// its rendered sentence implies — never falls through to whatever its raw state happens to say.
// `fate.nothingYet` is rowFate's OWN verdict — covers both the
// direct nothing-yet presentation and one degraded from an empty-verb apply direction — never a
// caller-recomputed guess (e.g. a family-rollup `pres === "no-settings"` check) that can disagree
// with what rowFate actually decided.
export type FateBucket = "conflict" | "apply" | "capture" | "excluded" | "ok" | "none";

// A fifth bucket for a row a device-scope or
// device-opt-out rule keeps this device from touching — counting it "ok" (`✓ N items in
// sync`) would lie to the user who just turned an item off here. Returned for BOTH exclusion
// causes (optedOutHere and class exclusion — same user-rule family, same placement) via
// `fate.excluded` (fateModel.ts's own field, mirroring `nothingYet`'s precedent — the minimal
// honest way for this function to know the cause without re-deriving it from FateInput, which it
// never receives). Positioned after the stageable checks (conflict/apply/capture always win — a
// still-syncing/conflicted family member outranks either exclusion cause) and before nothingYet.
export function fateBucket(fate: Fate): FateBucket {
  if (fate.glyph === "⚠") return "conflict";
  if (fate.stageable && fate.glyph === "↓") return "apply";
  if (fate.stageable && fate.glyph === "↑") return "capture";
  if (fate.excluded) return "excluded";
  if (fate.nothingYet) return "none";
  return "ok";
}

// "locked" (encrypted, no passphrase set) never runs content comparison, so it has no fate-based
// reading — fateBucket's own contract stays fate-only, five values. "locked" is a sixth, orthogonal
// placement callers add for that one genuine GroupState case (SyncCenterView's rowBucket) — it is
// NOT produced by fateBucket itself.
export type RowBucket = FateBucket | "locked";

// Fallback for a row whose OWN state is "locked": fateWithInput's display
// bypass unconditionally returns a non-stageable "—" fate for ANY locked row — including one whose
// FAMILY rolled up to a DIRECTIONAL companion's state (a locked parent's own state is neutral to
// familyRollup, so a directional companion, e.g. a plain settings dir with real changes, still
// pulls the family's rollup off "locked"). Feeding that bypass fate to fateBucket would silently
// vanish such a family into "ok" (config-reachable: any item with companions set to Encrypted mode
// with no passphrase). Locked has no fate-based reading at all, so its bucket is derived here
// instead, straight from the family's raw GroupState via the plain state→bucket
// vocabulary: a directional companion
// state buckets the family as such; the neutral fallback (no directional companion — the rollup
// stays "locked", true whenever the row is a solo locked item or every companion is itself
// neutral) keeps the family's own "locked" placement.
export function legacyLockedFamilyBucket(familyState: GroupState): RowBucket {
  if (familyState === "local-changed" || familyState === "not-captured") return "capture";
  if (familyState === "store-newer" || familyState === "never-synced") return "apply";
  if (familyState === "differs") return "conflict";
  return "locked";
}

// Filter-pill visibility: a conflict-bucket row stays visible under the "apply" filter
// (a `differs` GroupState is included there)
// rather than growing a dedicated "conflict" filter pill. "locked" is visible only under "all"
// (content comparison never ran for it, so no specific filter can claim it).
export function visibleUnderFilter(bucket: RowBucket, filter: PanelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "leftover") return false; // store orphans are a section, never rows
  if (bucket === "locked") return false;
  if (filter === "capture") return bucket === "capture";
  if (filter === "apply") return bucket === "apply" || bucket === "conflict";
  if (filter === "none") return bucket === "none";
  if (filter === "excluded") return bucket === "excluded";
  return bucket === "ok";
}

// A dedicated `FateBucketCounts` (extends the core `BucketCounts` shape rather than
// widening it) — `excluded` is a UI-presentation count, not a run-status one, so it stays out of
// `core/status.ts`'s `BucketCounts`/`bucketCounts` (the raw comparison-based counter other,
// non-UI code paths also use).
export interface FateBucketCounts extends BucketCounts {
  excluded: number;
}

// Filter-pill counts: the apply pill counts the apply bucket AND conflict
// (a `differs` GroupState counts under the "down"/To-apply pill);
// the capture pill counts capture; "In sync" = ok; "Not synced here" = excluded;
// "No settings yet" = none plus locked (bucketCounts already groups raw
// "locked" under `none`).
export function fateBucketCounts(buckets: RowBucket[]): FateBucketCounts {
  let up = 0;
  let down = 0;
  let ok = 0;
  let none = 0;
  let excluded = 0;
  for (const b of buckets) {
    if (b === "capture") up++;
    else if (b === "apply" || b === "conflict") down++;
    else if (b === "ok") ok++;
    else if (b === "excluded") excluded++;
    else none++; // "none" | "locked"
  }
  return { up, down, ok, none, excluded };
}

// Section partition: active = conflict|apply|capture (plus locked
// — a locked row is neither in-sync nor no-settings, so
// it renders active, unfolded); the folds hold ok/excluded/none — excluded gets its OWN fold,
// never merged into "insync" (the whole point: a user who just opted an item out must not
// still read it inside "✓ N items in sync").
export type PartitionSection = "active" | "insync" | "excluded" | "nosettings";

export function partitionSection(bucket: RowBucket): PartitionSection {
  if (bucket === "ok") return "insync";
  if (bucket === "excluded") return "excluded";
  if (bucket === "none") return "nosettings";
  return "active"; // conflict | apply | capture | locked
}

export interface CappedEntry {
  kind: "add" | "upd" | "del";
  name: string;
}

// Flattens a change set (added → updated → deleted) and splits it at `limit`
// so the detail view can render `shown` plus a "… N more files" line for `rest`.
export function capFileEntries(changes: FileChanges, limit: number): { shown: CappedEntry[]; rest: CappedEntry[] } {
  const all: CappedEntry[] = [
    ...changes.added.map((name): CappedEntry => ({ kind: "add", name })),
    ...changes.updated.map((name): CappedEntry => ({ kind: "upd", name })),
    ...changes.deleted.map((name): CappedEntry => ({ kind: "del", name })),
  ];
  return { shown: all.slice(0, limit), rest: all.slice(limit) };
}

// Plain text, no glyph prefix, no
// trailing triangle — the renderer composes the leading `.config-sync-row-chevron` (▸/▾) and the
// fixed-size Lucide fold icon (foldIcons.ts) around this label.
export function insyncLineText(n: number): string {
  return `${n} item${n === 1 ? "" : "s"} in sync`;
}

// The excluded fold's own trailing line — same shape idiom as
// insyncLineText/nosettingsLineText, copy kept verbatim-consistent with the row sentence ("Not
// synced on this device") so the pill → fold → row wording maps at zero cost. Plain text
// (see insyncLineText's comment above).
export function excludedLineText(n: number): string {
  return `${n} item${n === 1 ? "" : "s"} not synced on this device`;
}

// Plain text, no trailing triangle — the renderer appends a static FOLD-family
// `chevron-right` after this label (same idiom insyncLineText's comment above already
// established); this "more" line never re-collapses, so the icon never rotates.
export function moreFilesText(n: number): string {
  return `… ${n} more files`;
}

// The FILES row's default collapsed state — a bare-number `config-sync-pill
// is-neutral` (same neutral-pill family `config-sync-card-membercount` already established for a
// companion folder's member count), this sentence living in the pill's own aria-label/tooltip
// only, same split as `memberCountLabel` (itemCard.ts).
export function filesChangeLabel(n: number): string {
  return `${n} files change`;
}

// Default direction by state: capture for local-changed/not-captured, apply otherwise.
export function directionForState(state: GroupState): Direction {
  return state === "local-changed" || state === "not-captured" ? "capture" : "apply";
}

// Version-ahead presentation: an item whose content matches
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

// Plain text (see insyncLineText's comment above).
export function nosettingsLineText(n: number): string {
  return `${n} item${n === 1 ? "" : "s"} with no settings yet`;
}

export type SectionKind = "main" | "outdated" | "disabled" | "not-installed" | "desktop-only";

// Unified rule (closes the install-only/enable-only/update-only family): in
// the non-main sections the state ACTION is the payload, so every row stages except locked —
// an empty settings transfer (no-settings, in-sync) does not gate interaction. Main-section
// rows keep the plain stageability (there is no action to run there).
export function stageableRow(state: GroupState, section: SectionKind): boolean {
  if (section === "desktop-only") return false; // informational only — can't run here, nothing to stage
  if (section !== "main") return state !== "locked";
  return stageableState(state);
}

// A row's own compiled group can carry the device-scope fact in TWO independent places —
// both occur in real stores: (a) the group-level `devices` class (custom
// groups/companions; groupsForDevice's own exclusion axis — a genuinely different group never
// even reaches this device's status pass), and (b) a Plain-mode settings-file's own
// `fileRule.sharing` (the Settings-sync menu's write target, `setItemFileSharing`) — normally
// elevated onto `devices` at compile time (registry.ts's compileSingleFile), but the two can
// still disagree in practice (e.g. a pre-existing/migrated group whose top-level `devices` never
// picked up a later fileRule-only write). Checking both, independently, is the only reading that
// can't miss either axis. FileSharing excludes this-device by construction, so a per-class
// value is always a real DeviceClass to compare against.
export function groupExcludedHere(group: SyncGroup, deviceClass: "desktop" | "mobile"): boolean {
  const devicesExcluded = group.devices !== "all" && group.devices !== deviceClass;
  const fileRuleClass = group.fileRule === undefined ? null : sharingClass(group.fileRule.sharing);
  return devicesExcluded || (fileRuleClass !== null && fileRuleClass !== deviceClass);
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

// The status bar's data set: the rows the Sync Center LISTS, so the two can agree. Three
// narrowings, each mirroring something the view does:
//
//   1. The self group is dropped — it has its own sidebar destination and never enters the list.
//   2. Companions fold into their parent through `familyRollup`, the same producer the view's
//      rows use. `fileCount` doesn't affect the rolled-up STATE, so 0 is passed for every member.
//   3. Only `desktop-only` rows are dropped. `stageableRow` judges exactly that section
//      unstageable ("informational only — can't run here"), so it is the one availability class the
//      view itself never counts as pending. Outdated/disabled/not-installed rows DO stage and DO
//      show up in the center's counts, so dropping them would make the bar read low.
//
// One accepted residual: the bar has no access to the view's fate machinery (install policy,
// conflict choices, direction overrides), so a row whose FATE the view resolves to something
// non-directional can still count here. Closing it means mirroring the view's own state into a
// status bar, which costs more than the disagreement it removes.
export function statusBarStatuses(
  statuses: GroupStatus[],
  availabilityOf: (group: string) => Availability | undefined,
  isMobile: boolean,
  family: { selfGroup: string; parentOf: (group: string) => string | null }
): GroupStatus[] {
  const present = new Set(statuses.map((s) => s.group));
  const families = new Map<string, FamilyMember[]>();
  for (const st of statuses) {
    if (st.group === family.selfGroup) continue;
    // …and the two on/off carriers, for the same reason the view drops them: they dissolve into
    // their section's head chip and never render as rows. Counting them here is what left the bar
    // reading one higher in each direction than the pills right above it.
    if (ENABLEMENT_CARRIER_GROUPS.has(st.group)) continue;
    const parent = family.parentOf(st.group);
    // A companion whose parent isn't compiled here stands on its own — the same honest degradation
    // the view's familyGroups() makes.
    const key = parent !== null && present.has(parent) ? parent : st.group;
    const a = availabilityOf(st.group);
    // A group with no availability info keeps its raw state — hiding or reinterpreting it could
    // silently blank a real pending state.
    const member: FamilyMember = { name: st.group, state: presentedState(st.state, a === undefined ? null : a.drift), fileCount: 0 };
    const members = families.get(key);
    if (members === undefined) families.set(key, [member]);
    // The parent leads: familyRollup adopts the FIRST direction-contributing member's literal
    // state, which is how a companion-less family keeps its own state byte-identical.
    else if (st.group === key) members.unshift(member);
    else members.push(member);
  }
  return [...families].flatMap(([group, members]) => {
    const a = availabilityOf(group);
    if (a !== undefined && sectionForItem(a, isMobile) === "desktop-only") return [];
    return [{ group, state: familyRollup(members).state }];
  });
}

// Cold-start guidance: show only while the plugin's own settings are still
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

// How the Leftover surface presents (DESIGN.md's Leftover section): "leftover" is a judgment about
// which store files nothing tracks — a judgment this device cannot make while its own
// configuration is still pending adoption (coldstart/adopt/both: the store side is the newer
// one), so the section AND its filter pill give way to one quiet hint line. A capture-pending
// self (this device's own config is the newer side) does NOT gate — stopping a sync here
// legitimately produces leftovers before the next capture. An unknown self state reads as
// "section": unknown is not pending adoption.
export function leftoverPresentation(
  selfState: "coldstart" | "adopt" | "capture" | "both" | "insync" | null,
  count: number
): "section" | "hint" | "none" {
  if (count === 0) return "none";
  return selfState === "coldstart" || selfState === "adopt" || selfState === "both" ? "hint" : "section";
}

export const LEFTOVER_ADOPT_HINT =
  "Some store files aren't tracked here yet — adopt the configuration first, then anything truly left over shows up for cleanup.";

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
    // Update targets the version the store's settings were captured on, not "latest":
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


// The on/off list an item's enablement rides, from the item's own REF: a community item
// rides the community list, everything else the core one. Takes the ref rather than the group name
// because the section is a fact about the item, not something to be read back out of its name — the
// caller resolves it once (SyncCenterView's rowRef) and hands it here.
export function enablementCarrierFor(itemRef: string): EnablementList {
  return refItemId(itemRef)?.section === "community" ? "community-plugins" : "core-plugins";
}

// True when that carrier is itself a synced (compiled) item — the on/off card then owns
// enablement outright, and the disabled item's own per-card policy never runs.
// Refs on both sides: the carrier's own ref against the refs of the compiled
// groups. Never compare a LIST id against compiled group NAMES — that only works because a
// carrier's group name happens to equal its list id, which is a coincidence of the compiler's
// choice, not a fact either side states.
export function carrierIsSynced(itemRef: string, compiledRefs: readonly (string | undefined)[]): boolean {
  return compiledRefs.includes(carrierRef(enablementCarrierFor(itemRef)));
}

// Every row lives
// in exactly one of these four fixed sections, keyed off its scope — readiness state (outdated,
// disabled, not installed…) becomes row-level fate instead of a separate section.

export type TypeSection = "obsidian" | "core" | "community" | "folders";

export const TYPE_SECTION_TITLES: Record<TypeSection, string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  community: "Community plugins",
  folders: "Your folders",
};

// Fixed display order, alphabetical within each section separately (byLabel).
export const TYPE_SECTION_ORDER: readonly TypeSection[] = ["obsidian", "core", "community", "folders"];

// beta plugins sit in the Community section (parity with the settings Beta tab pinning them
// alongside community plugins); custom groups (+ Add folder) are "Your folders".
export function typeSectionForRow(defSection: StorageSection | "beta"): TypeSection {
  if (defSection === "beta") return "community";
  if (defSection === "custom") return "folders";
  return defSection;
}

// Section header count pill: "31" when nothing narrows the section, "6/31" once a state
// filter or a search query hides some of its rows. One form on every platform.
export function sectionCountLabel(total: number, visible: number, filtered: boolean): string {
  return filtered ? `${visible}/${total}` : `${total}`;
}

// How many digit slots the sidebar's count badges reserve, so their icons line up as a column.
// Derived from the widest count actually on the pane, never fixed: a fixed reservation is wrong in
// both directions at once — too small and the longest count overflows the very column the
// reservation exists to hold, too large and every shorter count carries the difference as dead
// space inside its own capsule. Zero counts still take one slot, because "0" is one character wide.
export function widestCountDigits(counts: readonly number[]): number {
  return String(Math.max(0, ...counts)).length;
}

// A carrier's on/off delta between the local store and a remote, as a plain set diff over
// membership — reuses parseSwitchList's shape handling so community-plugins.json (array) and
// core-plugins.json (map) both work, and degrades an unparseable/absent side to "nothing on"
// rather than throwing (a remote file that failed to fetch must still render, not crash the pane).
// remoteOnCount/localOnCount are the per-side SOURCE on-set sizes the narration needs:
// onAtRemote's source is the remote list's total on-member count, offAtRemote's is the
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

// Cap on display names shown per side before collapsing to "and N more".
const ONOFF_NARRATION_CAP = 5;

export interface OnOffNarrationLine {
  prefix: string; // e.g. "on at <remote>: " — plain narration text
  value: string; // e.g. "its entire list — 74 plugins" / "A, B, C, D, E, and 69 more" — the emphasized part
}

// One side's expanded narration: a side's flip count equalling its source on-set size
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

// Ready-to-render expanded on/off narration lines:
// `displayOf` resolves a flip's element id to its display name through the pane's own
// group-name → storedLabel → displayParts chain, so narration names never disagree with row
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

// A "family" is a parent object plus its companion groups (e.g. Appearance's themes/snippets
// dirs) — "one object = one row" means the family presents through ONE state,
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

// Concatenates a family's members' file changes into one set for the expanded card's
// "Files", rewriting each companion's paths relative to the family so `themes/Foo.css` reads
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

// Folds a remote diff's companion entries into their parent's entry, so a remote comparison yields
// the same one-row-per-family grammar the main list has. `parentOf` returns null for non-companions (they pass
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

// The action bar's staged-selection line (the view derives every count from Fate).
// `applyN`/`captureN` are the two direction totals; installs/turnsOn/settings are an apply-side
// breakdown (subsets of applyN, no "+").
//
// Counts lead: every number sits at the start of its own phrase, so they scan down one edge instead
// of hiding behind a verb ("installs 2 · turns on 1" made the reader hunt for the digits).
//
// Empty when the line would only restate the buttons beside it. `1 selected — captures 1` next to a
// `Capture 1 item` button is two sentences for one fact; the line earns its space only when it
// carries an apply-side breakdown, or when both directions are staged and no single button
// totals the selection.
export function unifiedFooterSummary(sel: { applyN: number; installs: number; turnsOn: number; settings: number; captureN: number }): string {
  const total = sel.applyN + sel.captureN;
  if (total === 0) return "Nothing selected";
  const breakdown: string[] = [];
  if (sel.installs > 0) breakdown.push(`${sel.installs} install`);
  if (sel.turnsOn > 0) breakdown.push(`${sel.turnsOn} turn on`);
  if (sel.settings > 0) breakdown.push(`${sel.settings} settings`);
  const bothDirections = sel.applyN > 0 && sel.captureN > 0;
  if (breakdown.length === 0 && !bothDirections) return "";
  const parts = [...breakdown];
  if (sel.captureN > 0) parts.push(`${sel.captureN} capture`);
  return `${total} selected · ${parts.join(" · ")}`;
}

// FileChanges (capFileEntries's source) is always computed from the CAPTURE side's perspective
// (types.ts/status.ts): "added" = present locally, absent from the store; "deleted" = present in
// the store, absent locally; "updated" = present on both sides, differs. Under capture direction
// that perspective already IS the effective action. Under apply direction the target is local, so
// added/deleted mirror each other: a store-only file ("deleted", capture-perspective) is really a
// brand-new file landing locally (nothing to diff against — "view" the incoming content); a
// local-only file ("added") is really removed once apply makes local match the store. Without
// this mirror, a not-installed plugin's incoming settings would render as a
// strikethrough deletion.

// The six side+consequence sentences a FILES entry's tooltip carries (DESIGN.md's State column):
// exported as named constants — the single producer both fileEntryFor below and the
// icon-collision/tooltip guards read from, so a future edit to any of them can't drift the two
// apart silently (the same "producer-vs-producer" discipline the fate-chip glyph registry uses).
export const CAPTURE_ADDED_TOOLTIP = "New in the store — starts syncing to your other devices";
export const CAPTURE_UPDATED_TOOLTIP = "Store copy updated";
export const CAPTURE_DELETED_TOOLTIP = "Removed from the store — removed from your other devices";
export const APPLY_ADDED_TOOLTIP = "New on this device";
export const APPLY_UPDATED_TOOLTIP = "Changed on this device";
export const APPLY_DELETED_TOOLTIP = "Deleted from this device";

export interface FileEntryPresentation {
  glyph: "+" | "·" | "del";
  label: string;
  affordance: "view" | "diff" | "none";
  note: string | null;
  // The side+consequence sentence for this entry's aria-label/hover: the FILES
  // row's own track-2 badge says which side the whole list affects, ONCE — this says what
  // happens to THIS file. Always present, encrypted entries included (the note above only
  // withholds the content preview, not the fact of what changed).
  tooltip: string;
}

// Direction arrows (DESIGN.md's State column) say which side exactly once, on the FILES row's own
// track-2 badge — never per entry. An entry's own glyph is the diff-kind family (`+`/`·`/`del`,
// rendered `+`/`~`/`−`) in BOTH directions — never collapsed to a bare direction
// arrow: added/updated/deleted is real information
// (a new store file starts syncing to a user's other devices; a removal removes it everywhere),
// not a direction. This function is the single producer of that per-entry read — glyph says
// WHAT happened to the file, tooltip says WHERE (which side, what consequence).
export function fileEntryFor(
  change: { kind: "added" | "updated" | "deleted"; rel: string },
  effDir: "apply" | "capture",
  encrypted: boolean
): FileEntryPresentation {
  const effectiveKind: "added" | "updated" | "deleted" =
    effDir === "capture" ? change.kind : change.kind === "added" ? "deleted" : change.kind === "deleted" ? "added" : "updated";

  // A real deletion never has content to preview — encryption is moot, and the "del" glyph
  // drives the collapsed/expanded strikethrough regardless of direction ("del"
  // strikethrough only when the EFFECTIVE direction actually deletes, i.e. only here).
  if (effectiveKind === "deleted") {
    const tooltip = effDir === "capture" ? CAPTURE_DELETED_TOOLTIP : APPLY_DELETED_TOOLTIP;
    return { glyph: "del", label: change.rel, affordance: "none", note: null, tooltip };
  }

  const ENCRYPTED_NOTE = "changed — encrypted, no preview";
  const glyph = effectiveKind === "added" ? "+" : "·";
  if (effDir === "capture") {
    const tooltip = effectiveKind === "added" ? CAPTURE_ADDED_TOOLTIP : CAPTURE_UPDATED_TOOLTIP;
    return { glyph, label: change.rel, affordance: encrypted ? "none" : "diff", note: encrypted ? ENCRYPTED_NOTE : null, tooltip };
  }
  // apply, content-bearing (added = brand-new to local, updated = both sides exist)
  const affordance = effectiveKind === "added" ? "view" : "diff";
  const tooltip = effectiveKind === "added" ? APPLY_ADDED_TOOLTIP : APPLY_UPDATED_TOOLTIP;
  return { glyph, label: change.rel, affordance: encrypted ? "none" : affordance, note: encrypted ? ENCRYPTED_NOTE : null, tooltip };
}

// The run payload is derived straight from each row's checkbox + Fate, with the
// two on/off carriers' member state collected separately from their own file-level entry.

export type ConflictChoice = "apply" | "capture";

export interface StageableRow {
  id: string;
  itemName: string;
  fate: Fate;
  selected: boolean;
  carrier: EnablementList | null;
  elementId: string | null;
  availability: Availability | null;
  conflictChoice: ConflictChoice | null;
  conflict: boolean;
  // Names of the row's companion groups actionable in each direction (family rollup's
  // applyMembers/captureMembers, parent name excluded — it's `itemName`). Empty for a row with
  // no companions, which reduces stagedPayload's fan-out below to a no-op.
  companionNames: { apply: string[]; capture: string[] };
}

// Row action matrix: a not-installed row
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
// to the two run payloads. Unselected rows and unresolved conflicts are excluded —
// never stageable. A plugin row with a synced carrier contributes its elementId to that
// carrier's stagedMembers on the SAME side it runs on: apply only when its fate would actually
// turn it on here (an id left out of stagedMembers keeps its current value, so a settings-only
// apply can't accidentally move a member it never meant to touch); capture always (a capture
// pushes local state as-is, on or off — there's no "turnsOn" concept on that side, which is
// the partial-selection symmetry). The carrier's own item — reused from its own
// row when that row is itself staged (the carrier file differs on its own), else synthesized —
// always carries `stagedMembers` once it exists, even `[]`, so a run that stages only settings
// (no member) can never fall back to the whole-list write.
export function stagedPayload(rows: StageableRow[]): { apply: ApplyItem[]; capture: CaptureItem[] } {
  const apply: ApplyItem[] = [];
  const capture: CaptureItem[] = [];
  const applyMembers: Record<EnablementList, string[]> = { "core-plugins": [], "community-plugins": [] };
  const captureMembers: Record<EnablementList, string[]> = { "core-plugins": [], "community-plugins": [] };

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
      // apply.
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
// re-deriving their own copy (a resolved conflict's displayed
// "turns on" and its actual staged action must never be able to disagree, and the footer's
// "turns on" count must never disagree with the payload's).
//
// Two independent adjustments, composable: (1) a resolved conflict (`conflictChoice` non-null on
// a `⚠` fate) re-derives a REAL directed fate via `rowFate` itself — never the frozen
// `turnsOn: false` the conflict branch always returns — so "Use theirs" on a plugin whose store
// switch-list state would turn it on genuinely stages that. (2) `fallbackTurnsOn` folds in the
// two carrier-unsynced fallback ladders' menu choice (After install / Enablement) —
// `Fate.turnsOn` is unconditionally `false` there by design (the sentence must stay free of
// enablement verbs), so the caller computes that choice separately and passes it
// through here rather than `rowFate` ever seeing it.
export function effectiveFate(fate: Fate, input: FateInput, conflictChoice: ConflictChoice | null, fallbackTurnsOn: boolean): Fate {
  const resolved = fate.glyph === "⚠" && conflictChoice !== null ? rowFate({ ...input, conflict: false, direction: conflictChoice }) : fate;
  return fallbackTurnsOn ? { ...resolved, turnsOn: true } : resolved;
}

// The panel answers two independent questions, and for a long time one field answered both: which
// RELATION is on screen (this device against the store, or the store against one remote) and which
// DESTINATION of the sidebar is selected (a slice of items, the run log, Config Sync's own entry).
// Selecting a remote used to silently change what the item categories meant, which is why they are
// two fields now.
export type PanelRelation = { kind: "device" } | { kind: "remote"; name: string };

export type PanelDestination =
  | { kind: "items"; cat: StorageSection | "beta" | "all" }
  | { kind: "history" }
  | { kind: "self" };

// Prefixed rather than bare: a remote may legitimately be named "beta" or "history", and an
// unprefixed key would collide with the destination of the same spelling.
export function relationKey(r: PanelRelation): string {
  return r.kind === "device" ? "device" : `remote:${r.name}`;
}

export function relationLabel(r: PanelRelation): string {
  return r.kind === "device" ? "This device ↔ store" : `store ↔ ${r.name}`;
}

export function destinationKey(d: PanelDestination): string {
  return d.kind === "items" ? `items:${d.cat}` : d.kind;
}

// Fold state is per relation AND per destination: the same section under two relations is two
// different lists, and a fold opened in one must not read as opened in the other.
export function foldStateKey(r: PanelRelation, d: PanelDestination, section: string, foldId: string): string {
  return `${relationKey(r)}::${destinationKey(d)}::${section}::${foldId}`;
}

// A relation's badge is a count of items when that relation's numbers are in hand, and its cheap
// whole-store state when they are not. The device side always counts; a remote counts only once a
// real comparison against it has run (this list is rebuilt on every render, and comparing is a
// network round trip), so both shapes stay.
export type ViewBadge = { kind: SyncAction; count: number } | { kind: "remote-state"; state: RemoteState };

export interface ViewOption {
  relation: PanelRelation;
  label: string;
  active: boolean;
  badges: ViewBadge[];
}

// The whole content of the View picker, as data. A `current` naming a remote that settings no
// longer has resolves to this device rather than to nothing — the picker always has exactly one
// active row, and a deleted remote is not a state the user can be left stranded in.
export function viewOptions(input: {
  current: PanelRelation;
  deviceCounts: { up: number; down: number };
  // `counts` is null for a remote no comparison has run against yet — that remote shows its
  // whole-store state instead, the answer the lock file gives for free.
  remotes: readonly { name: string; state: RemoteState; counts: { push: number; pull: number } | null }[];
}): ViewOption[] {
  const { current, deviceCounts, remotes } = input;
  // Read out to a local BEFORE the callback below: TypeScript does not carry a narrowing of
  // `input.current.kind` into a closure, so `input.current.name` there would not compile.
  const currentName = current.kind === "remote" ? current.name : null;
  const liveName = currentName !== null && remotes.some((r) => r.name === currentName) ? currentName : null;
  const deviceBadges: ViewBadge[] = [];
  if (deviceCounts.up > 0) deviceBadges.push({ kind: "capture", count: deviceCounts.up });
  if (deviceCounts.down > 0) deviceBadges.push({ kind: "apply", count: deviceCounts.down });
  const device: PanelRelation = { kind: "device" };
  const out: ViewOption[] = [{ relation: device, label: relationLabel(device), active: liveName === null, badges: deviceBadges }];
  for (const r of remotes) {
    const relation: PanelRelation = { kind: "remote", name: r.name };
    const badges: ViewBadge[] = [];
    if (r.counts === null) badges.push({ kind: "remote-state", state: r.state });
    else {
      // Zeroes drop, exactly as they do on the device row: a badge is a call to act.
      if (r.counts.push > 0) badges.push({ kind: "push", count: r.counts.push });
      if (r.counts.pull > 0) badges.push({ kind: "pull", count: r.counts.pull });
    }
    out.push({ relation, label: relationLabel(relation), active: liveName === r.name, badges });
  }
  return out;
}

// The two relations' state words, one for one (spec 5.1). The BUCKETS are the same five under both —
// what changes is only what they are called — so this is a lookup rather than a branch: the three
// surfaces that bucket by state (sidebar badges, filter pills, header pills) each read the table and
// none of them can drift from the others. `conflict` shares `apply`'s word under both relations, the
// same way the apply filter pill already counts conflicts. The device column reuses the existing
// fold-line functions rather than restating their copy, so the two can never disagree.
export interface RelationCopy {
  bucket: Record<FateBucket, string>;
  sentence: { push: string; pull: string; excluded: string; nothing: string };
  matchFold: (n: number) => string;
  excludedFold: (n: number) => string;
}

export function relationCopy(r: PanelRelation): RelationCopy {
  if (r.kind === "device") {
    return {
      bucket: { capture: "To capture", apply: "To apply", conflict: "To apply", ok: "In sync", excluded: "Not synced here", none: "No settings yet" },
      sentence: { push: "Captures settings", pull: "Applies settings", excluded: "Not synced on this device", nothing: NOTHING_YET_SENTENCE },
      matchFold: insyncLineText,
      excludedFold: excludedLineText,
    };
  }
  return {
    bucket: { capture: "To push", apply: "To pull", conflict: "To pull", ok: "In sync", excluded: "Doesn't sync with this remote", none: "Nothing captured yet" },
    sentence: { push: "Pushes settings", pull: "Pulls settings", excluded: "Doesn't sync with this remote", nothing: "Nothing to send" },
    matchFold: (n) => `${n} item${n === 1 ? " matches" : "s match"} this remote`,
    excludedFold: (n) => `${n} item${n === 1 ? " doesn't" : "s don't"} sync with this remote`,
  };
}
