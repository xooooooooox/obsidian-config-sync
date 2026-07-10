import { App, ButtonComponent, Modal } from "obsidian";
import { GroupState, GroupStatus, RemoteCheck } from "../core/status";
import { Remote } from "../core/types";

export const STATE_BADGES: Record<GroupState, string> = {
  "in-sync": "✓ in sync",
  "local-changed": "↑ changed on this device (likely)",
  "store-newer": "↓ store is newer (likely)",
  differs: "≠ differs",
  "not-captured": "— not captured yet",
};

export function remoteCheckText(check: RemoteCheck): string {
  const when = check.remoteCapturedAt === null ? "" : ` (captured ${check.remoteCapturedAt})`;
  switch (check.state) {
    case "no-store":
      return "no store at the remote yet — Push will initialize it";
    case "same":
      return `same as local${when}`;
    case "remote-newer":
      return `remote is newer${when} — consider Pull`;
    case "remote-older":
      return `remote is older${when} — consider Push`;
    case "unknown":
      return "cannot compare (missing or unreadable lock)";
  }
}

export interface StatusEntry {
  status: GroupStatus;
  resolvedPath: string;
}

export class StatusModal extends Modal {
  constructor(
    app: App,
    private entries: StatusEntry[],
    private remotes: Remote[],
    private onCheck: (remote: Remote) => Promise<string>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Config Sync: status");
    for (const e of this.entries) {
      const row = this.contentEl.createDiv({ cls: "config-sync-status-row" });
      row.createSpan({ cls: "config-sync-rule-name", text: e.status.group });
      row.createSpan({ cls: "config-sync-row-path", text: e.resolvedPath });
      row.createDiv({ cls: "config-sync-rule-spacer" });
      row.createSpan({ cls: `config-sync-state is-${e.status.state}`, text: STATE_BADGES[e.status.state] });
      if (e.status.message !== undefined) {
        this.contentEl.createDiv({ cls: "config-sync-status-error", text: e.status.message });
      }
    }
    if (this.remotes.length > 0) {
      this.contentEl.createEl("h5", { text: "Remotes" });
      for (const remote of this.remotes) {
        const row = this.contentEl.createDiv({ cls: "config-sync-status-row" });
        row.createSpan({ cls: "config-sync-rule-name", text: remote.name });
        const result = row.createSpan({ cls: "config-sync-row-path", text: "" });
        row.createDiv({ cls: "config-sync-rule-spacer" });
        new ButtonComponent(row).setButtonText("Check").onClick(async () => {
          result.setText("checking…");
          try {
            result.setText(await this.onCheck(remote));
          } catch (e) {
            result.setText(`cannot compare: ${(e as Error).message}`);
          }
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
