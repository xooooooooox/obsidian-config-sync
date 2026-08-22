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

// Bulk leftover cleanup (DESIGN.md's Leftover section): the per-row delete stays one-click; the
// Delete-all gesture confirms, because its consequence crosses devices — the modal copy is
// character-exact contract text.
class DeleteLeftoversModal extends Modal {
  private confirmed = false;

  constructor(app: App, private count: number, private onDone: (confirmed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    const files = `${this.count} file${this.count === 1 ? "" : "s"}`;
    this.titleEl.setText(`Delete ${this.count} leftover file${this.count === 1 ? "" : "s"}?`);
    this.contentEl.createEl("p", { text: "Removes these files from the store on this device." });
    this.contentEl.createEl("p", {
      cls: "config-sync-modal-warn",
      text: "After your next sync or Push, they are gone from your other devices too. This cannot be undone.",
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setWarning()
          .setButtonText(`Delete ${files}`)
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

export function confirmDeleteLeftovers(app: App, count: number): Promise<boolean> {
  return new Promise((resolve) => {
    new DeleteLeftoversModal(app, count, resolve).open();
  });
}

// The two Advanced-form gestures that silently destroyed configuration confirm now
// (DESIGN.md's Advanced rule editor) — the modal copy is character-exact contract text.
class DestructiveEditModal extends Modal {
  private confirmed = false;

  constructor(app: App, private heading: string, private body: string, private cta: string, private onDone: (confirmed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { cls: "config-sync-modal-warn", text: this.body });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setWarning()
          .setButtonText(this.cta)
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

export function confirmDropKeyRules(app: App, count: number): Promise<boolean> {
  const rules = `${count} key rule${count === 1 ? "" : "s"}`;
  return new Promise((resolve) => {
    new DestructiveEditModal(app, "Switch mode?", `This removes ${rules}; each key's sharing and encryption choices are lost.`, "Remove rules and switch", resolve).open();
  });
}

export function confirmTypeFlip(app: App, to: "file" | "folder"): Promise<boolean> {
  return new Promise((resolve) => {
    new DestructiveEditModal(app, `Change to ${to}?`, "This removes its key rules and encryption settings.", "Change type", resolve).open();
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
