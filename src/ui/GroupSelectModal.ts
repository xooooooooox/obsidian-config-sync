import { App, Modal, Setting } from "obsidian";
import { SyncGroup } from "../core/types";

export class GroupSelectModal extends Modal {
  private selected = new Set<string>();

  constructor(
    app: App,
    private groups: SyncGroup[],
    private modalTitle: string,
    private onSubmit: (names: string[]) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const group of this.groups) {
      new Setting(this.contentEl)
        .setName(group.name)
        .setDesc(`${group.path} · ${group.type} · ${group.devices}`)
        .addToggle((t) =>
          t.setValue(false).onChange((v) => {
            if (v) this.selected.add(group.name);
            else this.selected.delete(group.name);
          })
        );
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setCta()
        .setButtonText("Continue")
        .onClick(() => {
          this.close();
          this.onSubmit([...this.selected]);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
