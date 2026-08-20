/**
 * WHEN the Sync Center trades its sidebar for the compact switcher.
 *
 * The old answer was a magic number (`view width < 700`), which asks a question nobody has: what
 * decides is whether the sidebar column can show what it currently HAS. A vault whose rows all
 * agree renders one or two count badges per entry and reads fine in a narrow column; a vault
 * mid-sync renders five, and at 22% of any ordinary window that leaves the row's NAME under 20px —
 * squeezed past the ellipsis, to nothing. Same width, two different answers, so width alone cannot
 * be the question.
 *
 * The need is measured against what is rendered right now, badge by badge: a zero count draws no
 * badge (SyncCenterView's renderSectionEntries), so the widest row changes as the vault changes.
 *
 * Kept pure and DOM-free so the decision is unit-testable and so it can be asked BEFORE a render —
 * a DOM probe would have to measure a sidebar that, in compact, is not on screen to measure.
 */

// The sidebar column, as `styles.css` declares it:
//   .config-sync-shell { grid-template-columns: minmax(150px, 22%) minmax(0, 1fr) }
// A percentage smaller than the minimum loses to it, which is what `Math.max` says here.
// THESE TWO MUST MATCH. A drift makes entering and leaving compact asymmetric, and an asymmetric
// pair of thresholds oscillates: the stylesheet carries a comment pointing back here.
export const SIDE_COL_MIN_PX = 150;
export const SIDE_COL_PCT = 0.22;

// `.config-sync-side-item`: padding 6px 9px, gap 5px between the name and each badge.
export const SIDE_ITEM_PAD_X = 9;
export const SIDE_ITEM_GAP = 5;

// Below this the main pane has nothing left to be narrow INTO — the sidebar could still technically
// fit its own content while leaving the list a gutter. A floor, not the rule.
export const COMPACT_FLOOR_PX = 700;

// What a row's NAME must be left with. The badges are `flex: none` and never shrink, so the name is
// the only thing a narrow column can take from — and it took all of it: the reported case had five
// badges and 14px of name, an ellipsis with nothing before it. A floor rather than the name's full
// width, because the question is whether the row can show its BADGES; a long name ellipsised down
// to `Community…` is a row that still reads, and demanding every name in full would cost the
// sidebar at widths where it was doing its job. Roughly ten characters at `--font-ui-small`.
export const NAME_FLOOR_PX = 72;

// Leaving compact costs a full rebuild, so the two directions must not share one threshold. The
// need itself can differ slightly between the two states (the badge measured in the switcher is not
// always the one the sidebar would draw), and two states that disagree about the threshold
// oscillate. Entering is immediate — the sidebar is already visibly broken.
export const FIT_HYSTERESIS_PX = 16;

// A sidebar entry as far as WIDTH is concerned: its label, and how many count badges it actually
// draws. Not which badges — every badge reserves the same width by construction (they share one
// `min-width` so their icons line up as a column), which is the whole reason a count is enough.
export interface SidebarRowNeed {
  name: string;
  badges: number;
}

export function sidebarColumnWidth(viewWidth: number): number {
  return Math.max(SIDE_COL_MIN_PX, viewWidth * SIDE_COL_PCT);
}

// The width at which every row can draw all of its badges and still have a readable name. A short
// name asks only for itself; a long one asks for the floor and ellipsises past it. `nameWidth`
// measures text at the row's own font — the caller owns that, being the only one that knows the
// resolved font.
export function sidebarNeededWidth(rows: readonly SidebarRowNeed[], nameWidth: (name: string) => number, badgeWidth: number): number {
  let need = 0;
  for (const row of rows) {
    const badges = row.badges * (badgeWidth + SIDE_ITEM_GAP);
    const name = Math.min(Math.ceil(nameWidth(row.name)), NAME_FLOOR_PX);
    need = Math.max(need, SIDE_ITEM_PAD_X * 2 + name + badges);
  }
  return need;
}

// `forceNarrow` is the platform's own answer (a phone is narrow whatever it measures), folded in
// here rather than at the call site so there is one producer of "is this pane narrow".
export function nextCompact(input: { compact: boolean; forceNarrow: boolean; viewWidth: number; neededWidth: number }): boolean {
  if (input.forceNarrow) return true;
  if (input.viewWidth < COMPACT_FLOOR_PX) return true;
  const available = sidebarColumnWidth(input.viewWidth);
  return input.compact ? available < input.neededWidth + FIT_HYSTERESIS_PX : available < input.neededWidth;
}
