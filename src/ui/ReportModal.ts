import { App, Modal } from "obsidian";
import { GroupResult } from "../core/types";
import { renderReportContent, renderReportPills } from "./reportContent";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

export class ReportModal extends Modal {
  constructor(
    app: App,
    private modalTitle: string,
    private results: GroupResult[],
    private subtitle: string | undefined,
    private labelFor: (group: string) => string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.addClass("config-sync-report-title");
    this.titleEl.setText(this.modalTitle);
    renderReportPills(this.titleEl, this.results);
    if (this.subtitle !== undefined) this.contentEl.createDiv({ cls: "config-sync-report-sub", text: this.subtitle });
    renderReportContent(this.contentEl, this.results, {
      labelFor: this.labelFor,
      onReload: () => (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload"),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
