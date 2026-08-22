import { setIcon } from "obsidian";
import { ACTION_ICON } from "./actionIcons";

// THE conflict choice control, painted once for both places that offer it.
//
// A conflicted row can be resolved from the card's `Resolve` row or from the toolbar of any diff it
// has open, and for a while those were two different-looking controls: one spelled its directions
// as TEXT arrows (`Use theirs ↓`), the other as Lucide icons; different resting colours, different
// paddings, different fills, hover on one and not the other. Same decision, two visual languages —
// which is the exact class of drift the merged two-layer control (mergedControl.ts) exists to
// prevent, so this file exists for the same reason.
//
// The merge takes ICONS from the toolbar copy (the row's fate column finished migrating off text
// glyphs this same release — foldIcons.ts's opening note). Resting colour was re-decided in
// acceptance AC/T2: the box wears the card's quiet menuchip family, and the direction colour
// lives on the ICON alone until a side is hovered or chosen — the pair had become the one control
// on the card that shouted before anything was decided.

export type ResolveSide = "apply" | "capture";

// `theirs` = the store's, `mine` = this device's. Neither says "apply"/"capture", because at the
// moment of choosing the user is not picking a verb, they are picking a side.
export const RESOLVE_LABEL: Record<ResolveSide, string> = {
  apply: "Use theirs",
  capture: "Keep mine",
};

export const RESOLVE_SIDES: readonly ResolveSide[] = ["apply", "capture"];

// Marks the segment with the group it decides for, so an in-place update can find every copy
// currently on screen without either caller registering itself somewhere.
export function renderResolveSegment(
  host: HTMLElement,
  opts: { group: string; chosen: ResolveSide | null; onPick: (side: ResolveSide) => void }
): HTMLElement {
  const seg = host.createDiv({ cls: "config-sync-resolveseg", attr: { "data-cs-resolve": opts.group } });
  for (const side of RESOLVE_SIDES) {
    const btn = seg.createEl("button", { cls: `config-sync-resolvebtn is-${side}`, attr: { "data-cs-side": side } });
    setIcon(btn.createSpan({ cls: "config-sync-resolveic" }), ACTION_ICON[side === "apply" ? "apply" : "capture"]);
    btn.createSpan({ text: RESOLVE_LABEL[side] });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onPick(side);
    });
  }
  paintResolveSegment(seg, opts.chosen);
  return seg;
}

// Repaints an already-rendered segment. Separated from the builder so a choice can be reflected
// without rebuilding anything — see SyncCenterView's pickConflictSide, which cannot afford a
// re-render while the user is reading the diff the control sits on top of.
export function paintResolveSegment(seg: Element, chosen: ResolveSide | null): void {
  for (const side of RESOLVE_SIDES) {
    const btn = seg.querySelector(`[data-cs-side="${side}"]`);
    if (btn === null) continue;
    btn.toggleClass("is-on", chosen === side);
    btn.setAttribute("aria-pressed", chosen === side ? "true" : "false");
  }
}
