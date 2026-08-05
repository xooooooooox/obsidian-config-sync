import { GroupState, GroupStatus } from "../core/status";
import { FileChanges, RuleScope } from "../core/types";
import { Availability, VersionDrift } from "../core/availability";
import { ApplyItem, CaptureItem, StateAction } from "../core/ConfigSyncCore";
import { ItemCategory } from "../core/catalog";
import { Fate } from "./fateModel";

// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
export type Direction = "capture" | "apply";

// Panel row filter. Buckets match core bucketCounts: capture = local-changed + not-captured,
// apply = store-newer + differs, ok = in-sync.
// "leftover" is a scope-level view (store orphans), not a row-state filter — the view renders
// a dedicated section for it and never routes rows through visibleUnderFilter with it.
export type PanelFilter = "all" | "capture" | "apply" | "ok" | "none" | "leftover";

export function visibleUnderFilter(state: GroupState, filter: PanelFilter): boolean {
  if (filter === "all" || filter === "leftover") return true;
  if (state === "locked") return false;
  if (filter === "capture") return state === "local-changed" || state === "not-captured";
  if (filter === "apply") return state === "store-newer" || state === "differs" || state === "never-synced";
  if (filter === "none") return state === "no-settings";
  return state === "in-sync";
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

export const SECTION_TITLES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Outdated on this device",
  disabled: "Disabled on this device",
  "not-installed": "Not installed on this device",
  "desktop-only": "Desktop-only",
};

export const SECTION_NOTES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Store settings were captured on a newer plugin version than this device runs — updating first is the safe path.",
  disabled: "Settings sync either way — choose whether applying also turns the plugin on.",
  "not-installed": "Settings sync either way — choose whether applying also installs the plugin (latest version, from the community catalog).",
  "desktop-only": "In your config but can't run on this device — nothing to do here.",
};

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

export function versionLine(a: Availability): { text: string; tone: "gray" | "amber" } | null {
  if (a.drift === null || a.localVersion === null || a.storeVersion === null) return null;
  if (a.anchor === "app") {
    return a.drift === "behind"
      ? { text: `captured on Obsidian ${a.storeVersion} — this device runs ${a.localVersion}; update Obsidian if settings look off`, tone: "amber" }
      : { text: `captured on Obsidian ${a.storeVersion} · this device runs ${a.localVersion}`, tone: "gray" };
  }
  if (a.drift === "ahead") {
    return { text: `this device ${a.localVersion} · store ${a.storeVersion} — newer here; capturing will refresh the store`, tone: "gray" };
  }
  const suffix = a.kind === "disabled" ? " — settings were captured on a newer version" : "";
  return { text: `this device ${a.localVersion} · store ${a.storeVersion}${suffix}`, tone: "gray" };
}

// "selected" wording (定稿 2026-07-17, replaces git-flavored "staged"); an empty selection
// renders NOTHING — the idle state needs no label.
// The lead number is the TOTAL staged across every section (matching the section heads and
// the Apply button); the non-main sections are a composition breakdown — subsets of the
// total, so no "+" (batch: footer consistency). `main` here is main-section staged rows.
// `disabled` is every staged disabled row (feeds the total, spec #5-B fix round 2); a
// carrier-synced or "Keep disabled" row stages settings-only and belongs in that total but not
// in the "to enable" phrase, so `disabledEnableCount` — a real resolved enable only — drives
// that qualifier separately.
export function footerSummary(main: number, outdated: number, disabled: number, toInstall: number, disabledEnableCount: number): string {
  const total = main + outdated + disabled + toInstall;
  if (total === 0) return "";
  const parts = [`${total} selected`];
  if (outdated > 0) parts.push(`${outdated} to update`);
  if (disabledEnableCount > 0) parts.push(`${disabledEnableCount} to enable`);
  if (toInstall > 0) parts.push(`${toInstall} to install`);
  return parts.join(" · ");
}

// The busy-button label during a capture/apply run — arrow-prefixed to match the idle
// "↑ Capture N items" / "↓ Apply N items" buttons. Rendered from the view's activeRun state so a
// mid-run rebuild shows live progress instead of the stale staged count.
export function runProgressLabel(verb: "Capturing" | "Applying", done: number, total: number): string {
  return `${verb === "Capturing" ? "↑" : "↓"} ${verb} ${done}/${total}…`;
}

// ── In-place "where it runs" guidance (spec 2026-07-28 §4) ────────────────────────────────────

export const MEMBER_PUBLISH_NOTE = "Your choices are saved on this device — capture Settings so your other devices pick them up.";

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

export function memberDecisionText(m: MemberDecision): string {
  return m.scope === "local" ? `${m.id} — this device keeps its own on/off state` : `${m.id} — runs on ${m.scope} only`;
}

export type MemberScopeWrite =
  | { kind: "enabledOn"; scope: "desktop" | "mobile" }
  | { kind: "local" }
  | { kind: "clear" };

// Maps a scope-cycle target to the host write that realizes it (semantics unchanged from the old
// where-it-runs menu): desktop/mobile → setMemberEnabledOn; this-device → addSwitchExceptions;
// all → clearMemberLocal (which clears both a prior enabledOn and a prior this-device exception).
export function memberScopeWrite(scope: RuleScope): MemberScopeWrite {
  if (scope === "desktop" || scope === "mobile") return { kind: "enabledOn", scope };
  if (scope === "local") return { kind: "local" };
  return { kind: "clear" };
}

// Direction groups for the per-plugin rule list. One-sided → a single unlabeled group (the
// summary line above already states the direction); two-sided → two labeled groups, store side
// first (matching the summary's apply-first order), so no row needs a per-row direction tag.
export interface RuleGroup {
  dir: Direction;
  label: string | null;
  ids: string[];
}

export function ruleGroups(
  d: { captureRemoves: string[]; applyDisables: string[] },
  device: "desktop" | "mobile"
): RuleGroup[] {
  const here = device === "mobile" ? "this phone" : "this computer";
  if (d.captureRemoves.length > 0 && d.applyDisables.length > 0) {
    return [
      { dir: "apply", label: `Off ${here} · ${d.captureRemoves.length}`, ids: d.captureRemoves },
      { dir: "capture", label: `On ${here} only · ${d.applyDisables.length}`, ids: d.applyDisables },
    ];
  }
  if (d.captureRemoves.length > 0) return [{ dir: "apply", label: null, ids: d.captureRemoves }];
  if (d.applyDisables.length > 0) return [{ dir: "capture", label: null, ids: d.applyDisables }];
  return [];
}

// Current scope of a switch-list member: its device rule if it has one, else "all" (no rule).
export function memberCurrentScope(decisions: MemberDecision[], id: string): RuleScope {
  return decisions.find((m) => m.id === id)?.scope ?? "all";
}

export interface SummaryLine {
  dir: Direction;
  text: string;
}

// Directional summary lines that replace the per-member flood. One-sided → one line; both-sided
// → both, apply line first (Apply is the primary action on a never-synced item). `here` is
// device-aware; `noun` is the member kind the list carries (plugin lists vs the CSS-snippet
// list). Replaces the old single-line switchSummaryLine, which bailed to null on both-ways.
export function switchSummaryLines(
  d: { captureRemoves: string[]; applyDisables: string[] },
  device: "desktop" | "mobile",
  noun: "plugin" | "snippet"
): SummaryLine[] {
  const here = device === "mobile" ? "this phone" : "this computer";
  const out: SummaryLine[] = [];
  if (d.captureRemoves.length > 0) {
    const n = d.captureRemoves.length;
    out.push({
      dir: "apply",
      text:
        n === 1
          ? `1 ${noun} is on for your other devices but off ${here} — Apply turns it on.`
          : `${n} ${noun}s are on for your other devices but off ${here} — Apply turns them on.`,
    });
  }
  if (d.applyDisables.length > 0) {
    const n = d.applyDisables.length;
    out.push({
      dir: "capture",
      text:
        n === 1
          ? `1 ${noun} is on ${here} but off on your other devices — Capture shares it.`
          : `${n} ${noun}s are on ${here} but off on your other devices — Capture shares them.`,
    });
  }
  return out;
}

// Shown only when the divergence is two-sided — a bulk Apply/Capture is not a no-op there.
// The snippet variant points at the Appearance card because per-snippet device scope lives
// there (no per-snippet rule list in the Sync Center).
export function switchBothWaysCaption(noun: "plugin" | "snippet"): string {
  return noun === "snippet"
    ? "Bulk Apply or Capture resolves every snippet one way. Pin per-snippet devices on the Appearance card in Settings."
    : "Bulk Apply or Capture resolves every plugin one way. Pin the ones that differ on purpose below.";
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

export type MemberFate = "turns-on" | "stays-off" | "rule";

// Pure derivation from the carrier's existing divergence data: masked (a per-plugin rule or
// This-device pin) always wins — it excludes the member from applySide already, but a fate
// still needs to say WHY the member stays off rather than blaming "off everywhere".
export function memberFate(element: string, applySide: readonly string[], masked: boolean): MemberFate {
  if (masked) return "rule";
  return applySide.includes(element) ? "turns-on" : "stays-off";
}

const ENABLEMENT_CARRIER_LABEL: Record<EnablementCarrier, string> = {
  "core-plugins": "Core plugins on/off",
  "community-plugins": "Community plugins on/off",
};

// Collapsed-row pill — turns-on members only (copy final, spec #5-B).
export function fatePillText(carrier: EnablementCarrier): string {
  return `⏻ turns on with ${ENABLEMENT_CARRIER_LABEL[carrier]}`;
}

// Expanded-card static line replacing the On-apply policy row (copy final, spec #5-B).
export function fateLineText(carrier: EnablementCarrier, fate: MemberFate): string {
  if (fate === "turns-on") return `enablement follows ${ENABLEMENT_CARRIER_LABEL[carrier]}`;
  if (fate === "rule") return "follows its per-plugin rule";
  return "stays off — off on your other devices too";
}

// Disabled-section note when the section holds at least one carrier-synced row (copy final,
// spec #5-B); fallback contexts keep SECTION_NOTES.disabled.
export const DISABLED_CARRIER_SYNCED_NOTE = "Settings sync either way — whether a plugin turns on follows the on/off card.";

// The footer's "N to enable" must count only a REAL policy enable — a carrier-synced disabled
// row always resolves to "none" (fix round 1 #1) and must never contribute to that count.
export function isEnableAction(action: StateAction): boolean {
  return action === "enable" || action === "update-enable";
}

// Fix round 1 #3 (verbatim copy): the pre-existing "applying just turns the plugin on" /
// "enables the plugin only" notes lie once the carrier owns enablement — carrier-unsynced rows
// keep the old note byte-identical.
export function disabledInSyncNote(carrierSynced: boolean): string {
  return carrierSynced ? "identical to the store — nothing to apply here" : "identical to the store — applying just turns the plugin on";
}

export function disabledNoSettingsNote(carrierSynced: boolean): string {
  return carrierSynced ? "no settings to sync yet" : "no settings to apply — enables the plugin only";
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

// Section header count pill: "· 31" when nothing narrows the section, "· 6 of 31" once a state
// filter or a search query hides some of its rows.
export function sectionCountLabel(total: number, visible: number, filtered: boolean): string {
  return filtered ? `· ${visible} of ${total}` : `· ${total}`;
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

    if (dir === "apply") apply.push({ name: row.itemName, action: stagedAction(row.availability, row.fate.turnsOn) });
    else capture.push({ name: row.itemName, action: "none" });
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
