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
