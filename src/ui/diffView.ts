import { Platform } from "obsidian";

// Shared git-style diff renderer (extracted from ConflictModal, 定稿 conflict-modal-v4):
// unified/split views, LCS line diff with a cap, session-level view preference. Consumed by
// the conflict modal and the Sync Center's inline change diffs.

export type DiffView = "unified" | "split";

// Session-level view preference: switching one diff makes later renders follow. Not persisted.
let sessionDiffView: DiffView = "unified";

// Session-level: collapse long unchanged runs to a gap marker. Not persisted. Default collapsed.
let sessionDiffCollapse = true;

export interface DiffOp {
  kind: "common" | "del" | "ins";
  text: string;
}

export const DIFF_LINE_CAP = 2000;

// Minimal LCS line diff — good enough for config-sized JSON; capped for pathological inputs.
export function diffLines(leftText: string, rightText: string): DiffOp[] | null {
  const a = leftText.split("\n");
  const b = rightText.split("\n");
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) return null;
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "common", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "ins", text: b[j++]! });
  return ops;
}

export type DiffRow = DiffOp | { kind: "gap"; count: number };

// Keeps every change and `context` common lines around each change; folds the remaining runs of
// common lines into a single gap row. A run shorter than `minGap` is shown inline rather than
// replaced by a same-height gap marker (no visual saving).
export function collapseUnchanged(ops: DiffOp[], context: number, minGap = 2): DiffRow[] {
  const shown = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind !== "common") {
      for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) shown[j] = true;
    }
  }
  const rows: DiffRow[] = [];
  let runStart = -1;
  let runLen = 0;
  const flush = (): void => {
    if (runLen === 0) return;
    if (runLen < minGap) for (let k = runStart; k < runStart + runLen; k++) rows.push(ops[k]!);
    else rows.push({ kind: "gap", count: runLen });
    runLen = 0;
  };
  for (let i = 0; i < ops.length; i++) {
    if (shown[i]) {
      flush();
      rows.push(ops[i]!);
    } else {
      if (runLen === 0) runStart = i;
      runLen++;
    }
  }
  flush();
  return rows;
}

function renderUnified(pane: HTMLElement, rows: DiffRow[], leftLabel: string, rightLabel: string): void {
  const box = pane.createDiv({ cls: "config-sync-cm-unified" });
  box.createDiv({ cls: "config-sync-cm-dline is-delhead", text: `--- ${leftLabel}` });
  box.createDiv({ cls: "config-sync-cm-dline is-inshead", text: `+++ ${rightLabel}` });
  for (const row of rows) {
    if (row.kind === "gap") {
      box.createDiv({ cls: "config-sync-cm-dgap", text: `⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"} ⋯` });
      continue;
    }
    const prefix = row.kind === "del" ? "- " : row.kind === "ins" ? "+ " : "  ";
    box.createDiv({ cls: `config-sync-cm-dline is-${row.kind}`, text: prefix + row.text });
  }
}

function renderSplit(pane: HTMLElement, rows: DiffRow[], leftLabel: string, rightLabel: string): void {
  const wrap = pane.createDiv({ cls: "config-sync-cm-split" });
  const left = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
  const right = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
  left.createDiv({ cls: "config-sync-cm-dline is-delhead", text: leftLabel });
  right.createDiv({ cls: "config-sync-cm-dline is-inshead", text: rightLabel });
  for (const row of rows) {
    if (row.kind === "gap") {
      const t = `⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"} ⋯`;
      left.createDiv({ cls: "config-sync-cm-dgap", text: t });
      right.createDiv({ cls: "config-sync-cm-dgap", text: t });
    } else if (row.kind === "common") {
      left.createDiv({ cls: "config-sync-cm-dline is-common", text: row.text });
      right.createDiv({ cls: "config-sync-cm-dline is-common", text: row.text });
    } else if (row.kind === "del") {
      left.createDiv({ cls: "config-sync-cm-dline is-del", text: row.text });
      right.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
    } else {
      left.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
      right.createDiv({ cls: "config-sync-cm-dline is-ins", text: row.text });
    }
  }
}

// Builds toolbar (meta + Unified⇄Split toggle) and the diff pane. Mobile forces unified.
export function renderDiffPanel(
  host: HTMLElement,
  leftText: string,
  rightText: string,
  leftLabel: string,
  rightLabel: string,
  meta: string
): void {
  const toolbar = host.createDiv({ cls: "config-sync-cm-difftools" });
  toolbar.createSpan({ cls: "config-sync-cm-diffmeta", text: meta });
  toolbar.createDiv({ cls: "config-sync-rule-spacer" });
  const pane = host.createDiv({ cls: "config-sync-cm-diffpane" });
  const render = (): void => {
    pane.empty();
    const ops = diffLines(leftText, rightText);
    if (ops === null) {
      pane.createDiv({ cls: "config-sync-cm-diffbig", text: "Content differs — too large to diff inline." });
      return;
    }
    const rows: DiffRow[] = sessionDiffCollapse ? collapseUnchanged(ops, 3) : ops;
    if (sessionDiffView === "unified" || Platform.isMobile) renderUnified(pane, rows, leftLabel, rightLabel);
    else renderSplit(pane, rows, leftLabel, rightLabel);
  };
  if (!Platform.isMobile) {
    const toggle = toolbar.createDiv({ cls: "config-sync-cm-viewseg" });
    const uni = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Unified" });
    const spl = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Split" });
    const paint = (): void => {
      uni.toggleClass("is-on", sessionDiffView === "unified");
      spl.toggleClass("is-on", sessionDiffView === "split");
    };
    uni.addEventListener("click", (e) => {
      e.stopPropagation();
      sessionDiffView = "unified";
      paint();
      render();
    });
    spl.addEventListener("click", (e) => {
      e.stopPropagation();
      sessionDiffView = "split";
      paint();
      render();
    });
    paint();
  }
  const collapseSeg = toolbar.createDiv({ cls: "config-sync-cm-viewseg" });
  const colBtn = collapseSeg.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Collapse" });
  const fullBtn = collapseSeg.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Full" });
  const paintCollapse = (): void => {
    colBtn.toggleClass("is-on", sessionDiffCollapse);
    fullBtn.toggleClass("is-on", !sessionDiffCollapse);
  };
  colBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sessionDiffCollapse = true;
    paintCollapse();
    render();
  });
  fullBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    sessionDiffCollapse = false;
    paintCollapse();
    render();
  });
  paintCollapse();
  render();
}
