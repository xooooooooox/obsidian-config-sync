import { App, Modal } from "obsidian";
import { renderDiffPanel } from "./diffView";

/**
 * The diff, again, in a window big enough to read it in.
 *
 * An inline diff lives inside a card inside a scrolling pane, so a long change is read through a
 * letterbox. This is the same diff with the pane's constraints removed — and it is the SAME
 * renderer, not a second one: `renderDiffPanel` was already "draw into this element", so the modal
 * is the element and nothing about how a diff looks can drift between the two.
 *
 * The view/collapse toggles are module-level session state in `diffView.ts`, so they are shared by
 * construction: switch to split here, close, and the inline panel is split too. That is the
 * intent — it is one preference about how you read diffs, not a per-surface setting.
 */
class DiffModal extends Modal {
  constructor(
    app: App,
    private left: string,
    private right: string,
    private leftLabel: string,
    private rightLabel: string,
    private meta: { name: string; sorted: boolean }
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.meta.name);
    this.modalEl.addClass("config-sync-diffmodal");
    // No expand button here — this IS the bigger window.
    renderDiffPanel(this.contentEl, this.left, this.right, this.leftLabel, this.rightLabel, this.meta, null);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function openDiffModal(
  app: App,
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
  meta: { name: string; sorted: boolean }
): void {
  new DiffModal(app, left, right, leftLabel, rightLabel, meta).open();
}
