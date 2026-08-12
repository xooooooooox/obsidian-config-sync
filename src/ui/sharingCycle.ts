import { setIcon } from "obsidian";
import { Sharing } from "../core/types";
import { nextSharing, sharingCycleTooltip, sharingIcon } from "./itemCard";

// Commander-style sharing control (round-6 定稿, extracted from SettingTab 2026-08-04): a clickable
// icon whose glyph IS the current sharing (sharingIcon); a click advances to the next option in
// `options` and hands the caller the new value — the caller owns the write AND re-rendering this
// cell with the fresh value. Everywhere renders dim, any narrower sharing renders accented,
// mirroring the ghost-rail idle/active language. Shared by the Settings card's "Enabled on" chip
// and the Sync Center's per-plugin rule rows so both teach one gesture.
//
// `iconFor` / `labelFor` / `ariaLabel` exist because the SAME control now serves two vocabularies.
// `sharingIcon`/`sharingCycleTooltip` speak about where a FILE syncs — "Where it syncs (currently:
// This device)", `airplay` for this-device — and the enablement row asks a different question of the
// same `Sharing` union: which devices turn a plugin ON, whose fourth value is `Each device decides`
// and whose glyph must not be `airplay` (spec §7 reserves it, and it reads as screen mirroring).
// Rather than a second copy of this control, the vocabulary is a parameter: absent, every existing
// call site renders byte-identically (icon only, sharingIcon, sharingCycleTooltip).
export function renderSharingCycle(
  cell: HTMLElement,
  opts: {
    sharing: Sharing;
    options: readonly Sharing[];
    disabled: boolean;
    note?: string;
    iconFor?: (s: Sharing) => string;
    labelFor?: (s: Sharing) => string; // set ⇒ a visible text label joins the glyph (spec §6.1)
    ariaLabel?: string;
    onChange: (v: Sharing) => void;
  }
): void {
  const icon = cell.createSpan({ cls: `config-sync-sharingicon${opts.sharing.kind !== "everywhere" ? " is-set" : ""}` });
  setIcon(icon, (opts.iconFor ?? sharingIcon)(opts.sharing));
  if (opts.labelFor !== undefined) icon.createSpan({ cls: "config-sync-sharingicon-label", text: opts.labelFor(opts.sharing) });
  // aria-label alone: Obsidian renders its own tooltip for [aria-label] elements — adding
  // `title` too stacks a second (native) tooltip on hover (round-8 feedback ①).
  icon.setAttribute("aria-label", opts.ariaLabel ?? sharingCycleTooltip(opts.sharing, opts.note));
  if (opts.disabled) {
    icon.addClass("config-sync-dim");
    return;
  }
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  const advance = (): void => opts.onChange(nextSharing(opts.sharing, opts.options));
  icon.addEventListener("click", advance);
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      advance();
    }
  });
}
