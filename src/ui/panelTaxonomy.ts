import { AvailabilityFoldKind, FoldKind } from "./foldIcons";
import { PanelFilter, RowBucket, SectionKind, partitionSection, visibleUnderFilter } from "./panelModel";

// WHERE A ROW GOES, and which pill counts it — one declaration, read by every consumer.
//
// The panel answers three nested questions: which filter pills exist (renderPills), which sections
// a pill's view holds (renderTypeSection), and which fold inside a section a row lands in
// (buildTypeSectionCard). Answer them in three places and they drift: a row gets COUNTED by the
// `Not synced here` pill while being FILED under `N not installed on this device`, so clicking the
// pill's number lands on a list with none of those words in it. tests/panelTaxonomy.test.ts pins
// the whole table plus that invariant.
//
// Two orthogonal axes decide a row's home:
//
//   FATE (RowBucket)         what would happen to this row on the next run
//   AVAILABILITY (SectionKind)  whether this device can act on it at all
//
// A row has BOTH at once, so "which one files it" is a real decision, not an implementation
// detail — see FATE_FOLD_YIELDS_TO_AVAILABILITY below.

// The folds that speak for a row's FATE. Same keys as FoldKind (foldIcons.ts) — the icon
// vocabulary and the filing vocabulary are deliberately the same words.
export type FateFold = FoldKind;

// Where a row lands in the All view (no filter, no search). Exactly one of these, always.
export type RowPlacement =
  | { zone: "active" }
  | { zone: "fate"; fold: FateFold }
  | { zone: "availability"; fold: AvailabilityFoldKind };

// THE DECISION, stated once: when a row is non-active AND this device can't act on it, does its
// fate fold hand it over to the availability fold?
//
// `insync` / `nosettings` YIELD. Both mean "nothing to do here", and the availability fold says
// something strictly more useful about the same nothing — WHY there is nothing to do — plus a note
// on what applying would mean. That is the whole reason the availability folds exist.
//
// `excluded` NEVER yields. It is not an environment fact; it is a decision the user made about
// this device ("don't sync this here"). Someone who set it and comes back looking for it searches
// for the words the pill uses, and the pill counts by fate. Filing it under `not installed on this
// device` would hide a user's own choice behind a fact about the machine. The row keeps its
// `not installed here` chip either way, so the fact is not lost, only demoted.
// `locked` never yields either, and never has to: the availability axis is the device relation's
// alone, and this fold only exists under a remote.
export const FATE_FOLD_YIELDS_TO_AVAILABILITY: Record<FateFold, boolean> = {
  insync: true,
  excluded: false,
  nosettings: true,
  locked: false,
};

// The one placement function. Total over both axes — every (bucket, availability) pair has an
// answer, and tests/panelTaxonomy.test.ts enumerates all of them.
// The fate half comes from partitionSection (panelModel) rather than a second copy of the
// active-bucket set — one bucket→fold vocabulary, and PartitionSection minus "active" IS FateFold.
// `foldLocked` is the remote relation's answer to one question the device relation answers the
// other way: does an item nobody can open fold away, or stay in the list? Under a remote it folds —
// it is not actionable and a vault full of encrypted items would otherwise flood the active list.
// Under the device relation it keeps its long-standing place among the active rows, unchanged.
// Explicit rather than defaulted: a forgotten argument would silently move rows under a relation
// that never asked for it.
export function placeRow(bucket: RowBucket, availability: SectionKind, opts: { foldLocked: boolean }): RowPlacement {
  if (bucket === "locked" && opts.foldLocked) return { zone: "fate", fold: "locked" };
  const fold = partitionSection(bucket);
  if (fold === "active") return { zone: "active" };
  if (availability !== "main" && FATE_FOLD_YIELDS_TO_AVAILABILITY[fold]) {
    return { zone: "availability", fold: availability };
  }
  return { zone: "fate", fold };
}

// The fate fold each fold-owning pill speaks for. The pill's LABEL and the fold's LABEL describe
// the same set in the same words, so this mapping is what makes "click the number, find the rows"
// true. Action pills (`capture`/`apply`) own no fold — their rows stay active — and `all`/
// `leftover` are views, not buckets.
export const PILL_FATE_FOLD: Partial<Record<PanelFilter, FateFold>> = {
  ok: "insync",
  excluded: "excluded",
  none: "nosettings",
  locked: "locked",
};

// The count badges that render a fate fold's glyph + number outside the fold lines themselves:
// the sidebar per-section badges, the compact switcher, and the header status strip. They used to
// hand-write text glyphs (`✓`/`⊘`/`○`) while the fold lines drew fixed-size Lucide icons, so the
// SAME state wore two different marks depending on where you looked. Routing them through this map
// into renderFoldCount is what keeps the five surfaces on one glyph.
export const FATE_PILL_FOLD: Record<"ok" | "excluded" | "none" | "locked", FateFold> = {
  ok: "insync",
  excluded: "excluded",
  none: "nosettings",
  locked: "locked",
};

// Every fold a section can render, in render order: fate first (what would happen), availability
// after (what this device can't do about it). SyncCenterView renders exactly this order.
// `locked` last: from nothing-to-do, to my own rule, to nothing captured yet, to we cannot tell.
export const FATE_FOLD_ORDER: readonly FateFold[] = ["insync", "excluded", "nosettings", "locked"];
export const AVAILABILITY_FOLD_ORDER: readonly AvailabilityFoldKind[] = [
  "outdated",
  "disabled",
  "not-installed",
  "desktop-only",
];

// Does `filter` count a row with this bucket? Re-exported through the taxonomy so a test can walk
// pills and placements against ONE import, and so the "pill counts it ⟺ some fold or the active
// zone shows it" invariant has a single place to be asserted from.
export function pillCounts(bucket: RowBucket, filter: PanelFilter): boolean {
  return visibleUnderFilter(bucket, filter);
}
