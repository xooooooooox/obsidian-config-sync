import { App, Modal, Setting } from "obsidian";
import { GroupResult } from "../core/types";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

export class ReportModal extends Modal {
  constructor(app: App, private modalTitle: string, private results: GroupResult[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const r of this.results) {
      const icon = r.status === "ok" ? "✓" : r.status === "warning" ? "⚠" : "✗";
      const block = this.contentEl.createDiv();
      block.createEl("strong", { text: `${icon} ${r.group}` });
      block.createEl("div", { text: `${r.filesWritten.length} written, ${r.filesDeleted.length} deleted` });
      for (const m of r.messages) {
        block.createEl("div", { text: `• ${m}` });
      }
    }
    if (this.results.some((r) => r.needsAppReload)) {
      new Setting(this.contentEl)
        .setName("Some changes need an app reload to take effect")
        .addButton((b) =>
          b
            .setCta()
            .setButtonText("Reload app")
            .onClick(() => {
              (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload");
            })
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
