import { App, Modal, Setting } from "obsidian";

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private modalTitle: string,
    private lines: string[],
    private onDone: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const line of this.lines) {
      this.contentEl.createEl("p", { text: line });
    }
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Continue anyway")
          .onClick(() => {
            this.confirmed = true;
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone(this.confirmed);
  }
}

export function confirmWarnings(app: App, title: string, lines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, lines, resolve).open();
  });
}

// Companion-folder / custom-path preset-change guard (the modal copy is
// character-exact contract text). Reused verbatim for both zone ② (Settings file custom path)
// and zone ③ (Companion folders) whenever the path being changed away from is a registry PRESET
// (an item's default settingsFile path, or a presetCompanions entry) — never for a plain
// user-added companion, which has no preset identity to warn about.
const PRESET_PATH_CHANGE_TITLE = "Change a preset folder?";

function presetPathChangeBody(itemLabel: string): string {
  return `This folder is part of ${itemLabel}'s built-in setup. If you change it, the old folder stops syncing (it's cleaned up automatically) and the new path syncs as its own item.`;
}

class PresetPathChangeModal extends Modal {
  private confirmed = false;

  constructor(app: App, private itemLabel: string, private onDone: (confirmed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(PRESET_PATH_CHANGE_TITLE);
    this.contentEl.createEl("p", { text: presetPathChangeBody(this.itemLabel) });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setCta()
          .setButtonText("Change")
          .onClick(() => {
            this.confirmed = true;
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone(this.confirmed);
  }
}

export function confirmPresetPathChange(app: App, itemLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    new PresetPathChangeModal(app, itemLabel, resolve).open();
  });
}
