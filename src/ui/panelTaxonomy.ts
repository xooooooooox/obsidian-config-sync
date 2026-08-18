import { AvailabilityFoldKind, FoldKind } from "./foldIcons";
import { PanelFilter, RowBucket, SectionKind, partitionSection, visibleUnderFilter } from "./panelModel";

// WHERE A ROW GOES, and which pill counts it — one declaration, read by every consumer.
//
// The panel answers three nested questions, and until 2.25.0 each was answered in a different
// place: which filter pills exist (renderPills), which sections a pill's view holds
// (renderTypeSection), and which fold inside a section a given row lands in (buildTypeSectionCard's
// inline filters). Nothing tied the three together, so they could — and did — disagree: a row could
// be COUNTED by the `Not synced here` pill while being FILED under `N not installed on this
// device`, leaving a user who clicked the pill's number with nothing in the list that said those
// words. This module is the single source of truth for all three, and tests/panelTaxonomy.test.ts
// pins the whole table plus the invariant that broke.
//
// Two orthogonal axes decide a row's home:
//
//   FATE (RowBucket)         what would happen to this row on the next run
//   AVAILABILITY (SectionKind)  whether this device can act on it at all
//
// A row has BOTH at once, so "which one files it" is a real decision, not an implementation
// detail — see FATE_FOLD_YIELDS_TO_AVAILABILITY below.

// The three folds that speak for a row's FATE. Same keys as FoldKind (foldIcons.ts) — the icon
// vocabulary and the filing vocabulary are deliberately the same three words.
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
// for the words the pill used, and the pill counts by fate. Filing it under `not installed on this
// device` hid a user's own choice behind a fact about the machine — the 2.25.0 report. The row
// keeps its `not installed here` chip either way, so the fact is not lost, only demoted.
export const FATE_FOLD_YIELDS_TO_AVAILABILITY: Record<FateFold, boolean> = {
  insync: true,
  excluded: false,
  nosettings: true,
};

// The one placement function. Total over both axes — every (bucket, availability) pair has an
// answer, and tests/panelTaxonomy.test.ts enumerates all of them.
// The fate half comes from partitionSection (panelModel) rather than a second copy of the
// active-bucket set — one bucket→fold vocabulary, and PartitionSection minus "active" IS FateFold.
export function placeRow(bucket: RowBucket, availability: SectionKind): RowPlacement {
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
};

// The count badges that render a fate fold's glyph + number outside the fold lines themselves:
// the sidebar per-section badges, the compact switcher, and the header status strip. They used to
// hand-write text glyphs (`✓`/`⊘`/`○`) while the fold lines drew fixed-size Lucide icons, so the
// SAME state wore two different marks depending on where you looked. Routing them through this map
// into renderFoldCount is what keeps the five surfaces on one glyph.
export const FATE_PILL_FOLD: Record<"ok" | "excluded" | "none", FateFold> = {
  ok: "insync",
  excluded: "excluded",
  none: "nosettings",
};

// Every fold a section can render, in render order: fate first (what would happen), availability
// after (what this device can't do about it). SyncCenterView renders exactly this order.
export const FATE_FOLD_ORDER: readonly FateFold[] = ["insync", "excluded", "nosettings"];
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
