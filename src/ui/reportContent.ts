import { Setting } from "obsidian";
import { GroupResult, hasChanges } from "../core/types";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";

export const REPORT_CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

export function chipTooltip(kind: "add" | "upd" | "del", n: number): string {
  const verb = kind === "add" ? "added" : kind === "upd" ? "updated" : "deleted";
  return `${n} file${n === 1 ? "" : "s"} ${verb}`;
}

export interface ReportContentOpts {
  labelFor(group: string): string;
  onReload(): void;
}

export function changedOf(results: GroupResult[]): { changed: GroupResult[]; unchanged: GroupResult[] } {
  const changed = results.filter((r) => r.status !== "ok" || hasChanges(r.changes) || r.stateNote !== undefined);
  return { changed, unchanged: results.filter((r) => !changed.includes(r)) };
}

export function renderReportPills(host: HTMLElement, results: GroupResult[]): void {
  const { changed, unchanged } = changedOf(results);
  const pills = host.createSpan({ cls: "config-sync-report-pills" });
  pills.createSpan({ cls: "config-sync-pill is-neutral", text: `${changed.length} changed` });
  if (unchanged.length > 0) pills.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${unchanged.length}` });
}

export function renderReportContent(container: HTMLElement, results: GroupResult[], opts: ReportContentOpts): void {
  const { changed, unchanged } = changedOf(results);
  container.createDiv({ cls: "config-sync-report-legend", text: "+ added · ~ updated · − deleted (files)" });
  for (const cat of REPORT_CATEGORY_ORDER) {
    const inCat = changed.filter((r) => r.group !== "" && categoryForGroup(r.group) === cat);
    if (inCat.length === 0) continue;
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: CATEGORY_LABELS[cat] });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: `${inCat.length}` });
    const block = container.createDiv({ cls: "config-sync-card" });
    for (const r of inCat) renderResultRow(block, r, opts.labelFor(r.group));
  }
  const meta = changed.find((r) => r.group === "");
  if (meta !== undefined) {
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: "Store metadata" });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: "1" });
    renderResultRow(container.createDiv({ cls: "config-sync-card" }), meta, "store metadata");
  }
  if (unchanged.length > 0) {
    const line = container.createDiv({
      cls: "config-sync-unchanged",
      text: `✓ ${unchanged.length} item${unchanged.length === 1 ? "" : "s"} unchanged ▸`,
    });
    line.addEventListener("click", () => {
      line.setText(`✓ ${unchanged.map((r) => opts.labelFor(r.group)).join(" · ")}`);
    });
  }
  if (results.some((r) => r.needsAppReload)) {
    new Setting(container)
      .setName("Some changes need an app reload to take effect")
      .addButton((b) => b.setCta().setButtonText("Reload app").onClick(() => opts.onReload()));
  }
}

function renderResultRow(block: HTMLElement, r: GroupResult, label: string): void {
  const isError = r.status !== "ok";
  const row = block.createDiv({ cls: "config-sync-report-row" });
  const chev = row.createSpan({ cls: "config-sync-row-chevron", text: isError ? "▾" : "▸" });
  row.createSpan({ cls: "config-sync-rule-name", text: label });
  if (r.stateNote !== undefined) {
    row.createSpan({
      cls: `config-sync-pill ${r.stateNote.kind === "warn" ? "is-warn" : "is-statenote"}`,
      text: r.stateNote.text,
    });
  } else if (isError) {
    row.createSpan({ cls: "config-sync-pill is-warn", text: r.status === "warning" ? "⚠" : "✗" });
  }
  row.createDiv({ cls: "config-sync-rule-spacer" });
  const chip = (kind: "add" | "upd" | "del", cls: string, glyph: string, n: number): void => {
    if (n > 0) row.createSpan({ cls: `config-sync-chip ${cls}`, text: `${glyph}${n}`, attr: { title: chipTooltip(kind, n) } });
  };
  chip("add", "is-add", "+", r.changes.added.length);
  chip("upd", "is-upd", "~", r.changes.updated.length);
  chip("del", "is-del", "−", r.changes.deleted.length);
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
