import { setIcon } from "obsidian";
import { RuleScope } from "../core/types";
import { nextScope, SCOPE_ICONS, scopeCycleTooltip } from "./itemCard";

// Commander-style scope control (round-6 定稿, extracted from SettingTab 2026-08-04): a clickable
// icon whose glyph IS the current scope (SCOPE_ICONS); a click advances to the next option in
// `options` and hands the caller the new value — the caller owns the write AND re-rendering this
// cell with the fresh scope. Default "all" renders dim, any narrower scope renders accented,
// mirroring the ghost-rail idle/active language. Shared by the Settings card's "Enabled on" chip
// and the Sync Center's per-plugin rule rows so both teach one gesture.
export function renderScopeCycle<T extends RuleScope>(
  cell: HTMLElement,
  opts: { scope: T; options: readonly T[]; disabled: boolean; note?: string; onChange: (v: T) => void }
): void {
  const icon = cell.createSpan({ cls: `config-sync-scopeicon${opts.scope !== "all" ? " is-set" : ""}` });
  setIcon(icon, SCOPE_ICONS[opts.scope]);
  // aria-label alone: Obsidian renders its own tooltip for [aria-label] elements — adding
  // `title` too stacks a second (native) tooltip on hover (round-8 feedback ①).
  icon.setAttribute("aria-label", scopeCycleTooltip(opts.scope, opts.note));
  if (opts.disabled) {
    icon.addClass("config-sync-dim");
    return;
  }
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  const advance = (): void => opts.onChange(nextScope(opts.scope, opts.options));
  icon.addEventListener("click", advance);
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      advance();
    }
  });
}
