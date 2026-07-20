import { Platform } from "obsidian";

// Shared git-style diff renderer (extracted from ConflictModal, 定稿 conflict-modal-v4):
// unified/split views, LCS line diff with a cap, session-level view preference. Consumed by
// the conflict modal and the Sync Center's inline change diffs.

export type DiffView = "unified" | "split";

// Session-level view preference: switching one diff makes later renders follow. Not persisted.
let sessionDiffView: DiffView = "unified";

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

function renderUnified(pane: HTMLElement, ops: DiffOp[], leftLabel: string, rightLabel: string): void {
  const box = pane.createDiv({ cls: "config-sync-cm-unified" });
  box.createDiv({ cls: "config-sync-cm-dline is-delhead", text: `--- ${leftLabel}` });
  box.createDiv({ cls: "config-sync-cm-dline is-inshead", text: `+++ ${rightLabel}` });
  for (const op of ops) {
    const prefix = op.kind === "del" ? "- " : op.kind === "ins" ? "+ " : "  ";
    box.createDiv({ cls: `config-sync-cm-dline is-${op.kind}`, text: prefix + op.text });
  }
}

function renderSplit(pane: HTMLElement, ops: DiffOp[], leftLabel: string, rightLabel: string): void {
  const wrap = pane.createDiv({ cls: "config-sync-cm-split" });
  const left = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
  const right = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
  left.createDiv({ cls: "config-sync-cm-dline is-delhead", text: leftLabel });
  right.createDiv({ cls: "config-sync-cm-dline is-inshead", text: rightLabel });
  for (const op of ops) {
    if (op.kind === "common") {
      left.createDiv({ cls: "config-sync-cm-dline is-common", text: op.text });
      right.createDiv({ cls: "config-sync-cm-dline is-common", text: op.text });
    } else if (op.kind === "del") {
      left.createDiv({ cls: "config-sync-cm-dline is-del", text: op.text });
      right.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
    } else {
      left.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
      right.createDiv({ cls: "config-sync-cm-dline is-ins", text: op.text });
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
    if (sessionDiffView === "unified" || Platform.isMobile) renderUnified(pane, ops, leftLabel, rightLabel);
    else renderSplit(pane, ops, leftLabel, rightLabel);
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
  render();
}
