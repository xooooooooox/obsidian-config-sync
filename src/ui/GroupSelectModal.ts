import { App, ButtonComponent, Modal, Setting } from "obsidian";
import { GroupStatus } from "../core/status";
import { SyncGroup } from "../core/types";
import { STATE_BADGES } from "./StatusModal";

export interface GroupPickItem {
  group: SyncGroup;
  resolvedPath: string;
  meta: string; // description, or "folder · all devices"-style line
  status: GroupStatus | null; // null = status display disabled
}

export class GroupSelectModal extends Modal {
  private selected = new Set<string>();
  private cta: ButtonComponent | null = null;

  constructor(
    app: App,
    private items: GroupPickItem[],
    private modalTitle: string,
    private onSubmit: (names: string[]) => void
  ) {
    super(app);
    for (const item of this.items) {
      if (item.status?.state === "store-newer") this.selected.add(item.group.name);
    }
  }

  onOpen(): void {
    this.titleEl.setText(this.modalTitle);
    for (const item of this.items) {
      const state = item.status?.state ?? null;
      const parts = [item.resolvedPath, item.meta];
      if (state !== null) parts.push(STATE_BADGES[state]);
      if (state === "local-changed" || state === "differs") parts.push("applying overwrites local changes");
      const row = new Setting(this.contentEl).setName(item.group.name).setDesc(parts.join(" · "));
      if (state === "in-sync") row.settingEl.addClass("config-sync-picker-insync");
      row.addToggle((t) => {
        t.setValue(this.selected.has(item.group.name));
        t.setDisabled(state === "not-captured");
        t.onChange((v) => {
          if (v) this.selected.add(item.group.name);
          else this.selected.delete(item.group.name);
          this.updateCta();
        });
      });
    }
    new Setting(this.contentEl).addButton((b) => {
      this.cta = b;
      b.setCta().onClick(() => {
        this.close();
        this.onSubmit([...this.selected]);
      });
      this.updateCta();
    });
  }

  private updateCta(): void {
    const n = this.selected.size;
    this.cta?.setButtonText(n === 1 ? "Apply 1 group" : `Apply ${n} groups`);
    this.cta?.setDisabled(n === 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
