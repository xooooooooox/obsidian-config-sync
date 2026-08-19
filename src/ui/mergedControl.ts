/**
 * THE merged two-layer control, painted once for both surfaces.
 *
 * A row's shared answer and this device's own answer are ONE control: both glyphs, one
 * `chevrons-up-down`, one click target, one Tab stop, one menu whose two labelled sections carry
 * the two layers. Two controls with a divider and an eyebrow between them would spend a permanent
 * column on a layer that is almost always "no exception", and on a phone that column does not fit.
 *
 * The Settings panel and the Sync Center each own their row SHELL (a scrow vs a card row), but the
 * control inside is the same markup and the same menu shape, so it lives here rather than being
 * spelled twice — the two surfaces disagreeing about what a row offers is exactly the class of bug
 * this file exists to prevent.
 */
import { Menu, setIcon } from "obsidian";
import { MenuSectionModel, RowSegment } from "./enablementRow";

// Section headers are the whole point of the merge. Flatten the two questions into one list with
// nothing saying they ARE two questions and "no shared value" reads the same as "this device opts
// out". `setIsLabel` renders a header row that cannot be picked.
export function buildSectionedMenu(sections: readonly MenuSectionModel[]): Menu {
  const menu = new Menu();
  sections.forEach((section, i) => {
    if (i > 0) menu.addSeparator();
    const header = section.header;
    if (header !== null) menu.addItem((item) => item.setTitle(header).setIsLabel(true));
    for (const entry of section.items) {
      // One more separator can precede a stop INSIDE a section: the shared half's last stop answers
      // a different question from the three above it (is there a shared value at all, rather than
      // who gets it), and the line says so without splitting the radio group in two.
      if (entry.separatorBefore === true) menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(entry.title);
        if (entry.icon !== null) item.setIcon(entry.icon);
        // A state line states; it does not offer. `setIsLabel` drops the checkmark slot and the
        // hover/pick affordance, which is exactly the difference that was missing.
        if (entry.isLabel === true) {
          item.setIsLabel(true);
          return;
        }
        item.setChecked(entry.checked).onClick(entry.action);
      });
    }
  });
  return menu;
}

export interface MergedControlOpts {
  shared: RowSegment;
  // `null` when the row HAS no local layer — a key governed by per-item rules, a key shared with no
  // one, a snippet whose exceptions no run would honour. Then the control is one glyph and the menu
  // one section: the glyph count IS how many things the row can be told, so the two cannot disagree.
  local: RowSegment | null;
  localIsException: boolean;
  sections: () => readonly MenuSectionModel[];
  // Each surface wires its own menu trigger (click, keyboard, and the open-state class it tracks),
  // so the shape is shared here while the wiring stays where it already lives.
  wire: (trigger: HTMLElement, menu: () => Menu) => void;
}

export function paintMergedControl(host: HTMLElement, opts: MergedControlOpts): void {
  // One control, so one sentence: the shared answer's consequence, then this device's own state.
  const tooltip = opts.local === null ? opts.shared.tooltip : `${opts.shared.tooltip} ${opts.local.tooltip}`;
  const trigger = host.createSpan({
    cls: `config-sync-mergedctl${opts.localIsException ? " is-set" : ""}`,
    attr: { "aria-label": tooltip },
  });
  if (opts.shared.icon !== null) setIcon(trigger.createSpan({ cls: "config-sync-tworow-ic" }), opts.shared.icon);
  if (opts.local !== null && opts.local.icon !== null) {
    trigger.createSpan({ cls: "config-sync-mergedctl-sep", text: "·" });
    setIcon(trigger.createSpan({ cls: "config-sync-tworow-ic config-sync-mergedctl-local" }), opts.local.icon);
  }
  setIcon(trigger.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
  opts.wire(trigger, () => buildSectionedMenu(opts.sections()));
}
