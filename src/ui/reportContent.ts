import { Setting } from "obsidian";
import { GroupResult, StorageSection } from "../core/types";
import { isChanged } from "../core/runHistory";
import { SECTION_LABELS, sectionForGroup } from "../core/catalog";

export const REPORT_CATEGORY_ORDER: StorageSection[] = ["obsidian", "core", "community", "custom"];

export function chipTooltip(kind: "add" | "upd" | "del", n: number): string {
  const verb = kind === "add" ? "added" : kind === "upd" ? "updated" : "deleted";
  return `${n} file${n === 1 ? "" : "s"} ${verb}`;
}

export interface ReportContentOpts {
  labelFor(group: string): string;
  onReload(): void;
}

export function changedOf(results: GroupResult[]): { changed: GroupResult[]; unchanged: GroupResult[] } {
  const changed = results.filter(isChanged);
  return { changed, unchanged: results.filter((r) => !changed.includes(r)) };
}

// Severity split (spec 2026-08-09-c-livetest-batch16 §2, C-#35): GroupResult.status alone
// can't tell a genuine failure from a benign success-side note — both today land on
// "warning" (e.g. "⚠ install failed" and the version-fallback note are both status
// "warning"; core.test.ts pins that mapping, so it stays as-is). The stateNote's own kind
// carries the real signal: "warn" means the action itself didn't fully succeed (an issue),
// while "ok" (or no note) alongside messages means an FYI on an otherwise-successful group
// (a note). This is presentation-only — it never touches GroupResult.status.
export type ResultLevel = "error" | "warning" | "ok";

export function resultLevel(r: GroupResult): ResultLevel {
  if (r.status === "error" || r.stateNote?.kind === "warn") return "error";
  if (r.status === "warning") return "warning";
  return "ok";
}

const MESSAGE_LEVEL_CLS: Record<ResultLevel, string> = {
  error: "config-sync-status-error",
  warning: "config-sync-status-warn",
  ok: "config-sync-status-note",
};

export interface StripHeader {
  issues: number; // resultLevel "error" groups — the only tally that flips the strip to issue tone
  notes: number; // resultLevel "warning" groups — success-side FYI notes (e.g. the version fallback)
  tone: "issue" | "note" | "clean";
}

// Run-strip header derivation (spec 2026-08-09-c-livetest-batch16 §2, C-#35): any genuine
// failure renders "✗ Applied with N issue(s)" in issue tone; otherwise any success-side note
// renders "Applied · N note(s)" in success tone; a run with neither is today's plain clean strip.
export function stripHeader(results: GroupResult[]): StripHeader {
  const issues = results.filter((r) => resultLevel(r) === "error").length;
  const notes = results.filter((r) => resultLevel(r) === "warning").length;
  const tone = issues > 0 ? "issue" : notes > 0 ? "note" : "clean";
  return { issues, notes, tone };
}

export function renderReportPills(host: HTMLElement, results: GroupResult[]): void {
  const { changed, unchanged } = changedOf(results);
  // Failures must be visible without expanding details (real-vault finding 2026-07-17: a
  // failed update read as "nothing happened" because only counts showed). Counted by
  // resultLevel (not raw status) so a genuine failure lands in the ✗ bucket even though its
  // GroupResult.status is "warning" — see resultLevel's doc comment.
  const errors = results.filter((r) => resultLevel(r) === "error").length;
  const warnings = results.filter((r) => resultLevel(r) === "warning").length;
  const pills = host.createSpan({ cls: "config-sync-report-pills" });
  pills.createSpan({ cls: "config-sync-pill is-neutral", text: `${changed.length} changed` });
  if (errors > 0) pills.createSpan({ cls: "config-sync-pill is-error", text: `✗ ${errors}` });
  if (warnings > 0) pills.createSpan({ cls: "config-sync-pill is-warn", text: `⚠ ${warnings}` });
  if (unchanged.length > 0) pills.createSpan({ cls: "config-sync-pill is-ok", text: `✓ ${unchanged.length}` });
}

export function renderReportContent(container: HTMLElement, results: GroupResult[], opts: ReportContentOpts): void {
  const { changed, unchanged } = changedOf(results);
  container.createDiv({ cls: "config-sync-report-legend", text: "+ added · ~ updated · − deleted (files)" });
  for (const cat of REPORT_CATEGORY_ORDER) {
    const inCat = changed.filter((r) => r.group !== "" && sectionForGroup(r.group) === cat);
    if (inCat.length === 0) continue;
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: SECTION_LABELS[cat] });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: `${inCat.length}` });
    const block = container.createDiv({ cls: "config-sync-card" });
    for (const r of inCat) renderResultRow(block, r, opts.labelFor(r.group));
  }
  const meta = changed.find((r) => r.group === "");
  if (meta !== undefined) {
    const sect = container.createDiv({ cls: "config-sync-sect" });
    sect.createSpan({ text: "Sync setup" });
    sect.createSpan({ cls: "config-sync-pill is-neutral config-sync-sect-count", text: "1" });
    renderResultRow(container.createDiv({ cls: "config-sync-card" }), meta, "Sync setup");
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
  const messageCls = MESSAGE_LEVEL_CLS[resultLevel(r)];
  for (const m of r.messages) detail.createDiv({ cls: messageCls, text: `• ${m}` });
  for (const f of r.changes.added) detail.createDiv({ cls: "is-add", text: `+ ${f}` });
  for (const f of r.changes.updated) detail.createDiv({ cls: "is-upd", text: `~ ${f}` });
  for (const f of r.changes.deleted) detail.createDiv({ cls: "is-del", text: `− ${f}` });
  row.addEventListener("click", () => {
    detail.hidden = !detail.hidden;
    chev.setText(detail.hidden ? "▸" : "▾");
  });
}
