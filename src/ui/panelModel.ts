import { GroupState } from "../core/status";
import { FileChanges } from "../core/types";
import { Availability, VersionDrift } from "../core/availability";
import { StateAction } from "../core/ConfigSyncCore";

// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
export type Direction = "capture" | "apply";

// Panel row filter. Buckets match core bucketCounts: capture = local-changed + not-captured,
// apply = store-newer + differs, ok = in-sync.
export type PanelFilter = "all" | "capture" | "apply" | "ok" | "none";

export function visibleUnderFilter(state: GroupState, filter: PanelFilter): boolean {
  if (filter === "all") return true;
  if (state === "locked") return false;
  if (filter === "capture") return state === "local-changed" || state === "not-captured";
  if (filter === "apply") return state === "store-newer" || state === "differs";
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

export type SectionKind = "main" | "outdated" | "disabled" | "not-installed";

// Unified rule (spec 2026-07-17, closes the install-only/enable-only/update-only family): in
// the non-main sections the state ACTION is the payload, so every row stages except locked —
// an empty settings transfer (no-settings, in-sync) no longer gates interaction. Main-section
// rows keep the plain stageability (there is no action to run there).
export function stageableRow(state: GroupState, section: SectionKind): boolean {
  if (section !== "main") return state !== "locked";
  return stageableState(state);
}

export const SECTION_TITLES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Outdated on this device",
  disabled: "Disabled on this device",
  "not-installed": "Not installed on this device",
};

export const SECTION_NOTES: Record<Exclude<SectionKind, "main">, string> = {
  outdated: "Store settings were captured on a newer plugin version than this device runs — updating first is the safe path.",
  disabled: "Settings sync either way — choose whether applying also turns the plugin on.",
  "not-installed": "Settings sync either way — choose whether applying also installs the plugin (latest version, from the community catalog).",
};

export function sectionForItem(a: Availability): SectionKind {
  if (a.kind === "not-installed") return "not-installed";
  if (a.kind === "disabled") return "disabled";
  if (a.anchor === "plugin" && a.drift === "behind") return "outdated";
  return "main";
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
      { action: "none", label: "Stage only", pill: null },
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
    return [
      { action: "update", label: "⤓ Update to latest", pill: "⤓ update" },
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

export function footerSummary(staged: number, outdated: number, disabled: number, toInstall: number): string {
  const parts = [`${staged} staged`];
  if (outdated > 0) parts.push(`+${outdated} outdated`);
  if (disabled > 0) parts.push(`+${disabled} disabled`);
  if (toInstall > 0) parts.push(`+${toInstall} to install`);
  return parts.join(" · ");
}
