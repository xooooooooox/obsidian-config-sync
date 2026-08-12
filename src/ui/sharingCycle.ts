import { setIcon } from "obsidian";
import { Sharing } from "../core/types";
import { nextSharing, sharingCycleTooltip, sharingIcon } from "./itemCard";

// Commander-style sharing control (round-6 定稿, extracted from SettingTab 2026-08-04): a clickable
// icon whose glyph IS the current sharing (sharingIcon); a click advances to the next option in
// `options` and hands the caller the new value — the caller owns the write AND re-rendering this
// cell with the fresh value. Everywhere renders dim, any narrower sharing renders accented,
// mirroring the ghost-rail idle/active language. Shared by the Settings card's "Enabled on" chip
// and the Sync Center's per-plugin rule rows so both teach one gesture.
export function renderSharingCycle(
  cell: HTMLElement,
  opts: { sharing: Sharing; options: readonly Sharing[]; disabled: boolean; note?: string; onChange: (v: Sharing) => void }
): void {
  const icon = cell.createSpan({ cls: `config-sync-sharingicon${opts.sharing.kind !== "everywhere" ? " is-set" : ""}` });
  setIcon(icon, sharingIcon(opts.sharing));
  // aria-label alone: Obsidian renders its own tooltip for [aria-label] elements — adding
  // `title` too stacks a second (native) tooltip on hover (round-8 feedback ①).
  icon.setAttribute("aria-label", sharingCycleTooltip(opts.sharing, opts.note));
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
