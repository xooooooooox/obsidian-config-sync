import { App, Modal, Setting } from "obsidian";
import { GroupResult, hasChanges } from "../core/types";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";

interface AppWithCommands {
  commands: { executeCommandById(id: string): void };
}

const CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

export class ReportModal extends Modal {
  constructor(
    app: App,
    private modalTitle: string,
    private results: GroupResult[],
    private subtitle?: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.addClass("config-sync-report-title");
    this.titleEl.setText(this.modalTitle);
    const changed = this.results.filter((r) => r.status !== "ok" || hasChanges(r.changes));
    const unchanged = this.results.filter((r) => !changed.includes(r));
    const pills = this.titleEl.createSpan({ cls: "config-sync-report-pills" });
    pills.createSpan({ cls: "config-sync-pill is-neutral", text: `${changed.length} changed` });
    if (unchanged.length > 0) pills.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${unchanged.length}` });
    if (this.subtitle !== undefined) this.contentEl.createDiv({ cls: "config-sync-report-sub", text: this.subtitle });

    for (const cat of CATEGORY_ORDER) {
      const inCat = changed.filter((r) => r.group !== "" && categoryForGroup(r.group) === cat);
      if (inCat.length === 0) continue;
      this.contentEl.createDiv({ cls: "config-sync-sect", text: CATEGORY_LABELS[cat] });
      const block = this.contentEl.createDiv({ cls: "config-sync-card" });
      for (const r of inCat) this.renderRow(block, r);
    }
    const meta = changed.find((r) => r.group === "");
    if (meta !== undefined) {
      this.contentEl.createDiv({ cls: "config-sync-sect", text: "Store metadata" });
      this.renderRow(this.contentEl.createDiv({ cls: "config-sync-card" }), meta, "store metadata");
    }
    if (unchanged.length > 0) {
      const line = this.contentEl.createDiv({ cls: "config-sync-unchanged", text: `✓ ${unchanged.length} item${unchanged.length === 1 ? "" : "s"} unchanged ▸` });
      line.addEventListener("click", () => {
        line.setText(`✓ ${unchanged.map((r) => r.group).join(" · ")}`);
      });
    }
    if (this.results.some((r) => r.needsAppReload)) {
      new Setting(this.contentEl)
        .setName("Some changes need an app reload to take effect")
        .addButton((b) =>
          b.setCta().setButtonText("Reload app").onClick(() => {
            (this.app as unknown as AppWithCommands).commands.executeCommandById("app:reload");
          })
        );
    }
  }

  private renderRow(block: HTMLElement, r: GroupResult, label?: string): void {
    const isError = r.status !== "ok";
    const row = block.createDiv({ cls: "config-sync-report-row" });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: isError ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: label ?? r.group });
    if (isError) row.createSpan({ cls: "config-sync-pill is-warn", text: r.status === "warning" ? "⚠" : "✗" });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    const chip = (cls: string, text: string): void => {
      row.createSpan({ cls: `config-sync-chip ${cls}`, text });
    };
    if (r.changes.added.length > 0) chip("is-add", `+${r.changes.added.length}`);
    if (r.changes.updated.length > 0) chip("is-upd", `~${r.changes.updated.length}`);
    if (r.changes.deleted.length > 0) chip("is-del", `−${r.changes.deleted.length}`);
    const detail = block.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !isError;
    for (const m of r.messages) detail.createDiv({ cls: "config-sync-status-error", text: `• ${m}` });
    for (const f of r.changes.added) detail.createDiv({ cls: "is-add", text: `+ ${f}` });
    for (const f of r.changes.updated) detail.createDiv({ cls: "is-upd", text: `~ ${f}` });
    for (const f of r.changes.deleted) detail.createDiv({ cls: "is-del", text: `− ${f}` });
    row.addEventListener("click", () => {
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
