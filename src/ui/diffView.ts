import { Platform, setIcon } from "obsidian";

// Shared git-style diff renderer (extracted from ConflictModal):
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
//
// `meta.sorted` used to print as a trailing ` · sorted view`, which spent the toolbar's most
// readable slot on a caveat while pushing the filename — the thing being diffed — off to the left.
// The caveat is still true and still needed (the rows are NOT in file order), so it moves into the
// meta's own accessible name instead of vanishing.
// `onExpand` renders the "open this in a bigger window" button. `null` where there is nowhere
// bigger to go — inside the modal that button opens, and inside the pull-conflict modal.
//
// `resolve` puts the `Use theirs` / `Keep mine` choice IN the toolbar, for a row whose two sides
// both moved. It belongs here rather than only on the card because of what a diff in this plugin
// IS: `diffPair`'s `produced` has already been through captureTransform/applyTransform, so a diff
// never shows "how these two files differ" — it shows "what THIS choice would do". Direction is not
// a parameter for viewing the difference; it is the thing being viewed. So the control that picks a
// side and the control that picks a preview are the same control, and asking someone to choose on
// the card and then look somewhere else got the order backwards: the evidence arrived after the
// decision.
export interface DiffResolveControl {
  chosen: "apply" | "capture" | null;
  // Set only when this file is not the whole story — a folder item or one with companions, where
  // the run writes every file together and picking a side here settles them all. Null on a
  // single-file item, where the file IS the item and there is nothing to disclose.
  scopeNote: string | null;
  onPick: (choice: "apply" | "capture") => void;
}

export function renderDiffPanel(
  host: HTMLElement,
  leftText: string,
  rightText: string,
  leftLabel: string,
  rightLabel: string,
  meta: { name: string; sorted: boolean },
  onExpand: (() => void) | null,
  resolve: DiffResolveControl | null
): void {
  const toolbar = host.createDiv({ cls: "config-sync-cm-difftools" });
  const metaEl = toolbar.createSpan({ cls: "config-sync-cm-diffmeta", text: meta.name });
  if (meta.sorted) {
    metaEl.setAttribute("aria-label", `${meta.name} — both sides are shown with their keys in the same sorted order, not the order they appear in the file.`);
  }
  toolbar.createDiv({ cls: "config-sync-rule-spacer" });
  // Before the view controls: this one changes WHAT you are looking at (and what will happen);
  // those change how it is drawn.
  if (resolve !== null) {
    const seg = toolbar.createDiv({ cls: "config-sync-cm-resolveseg" });
    const opt = (choice: "apply" | "capture", label: string, icon: string): void => {
      const on = resolve.chosen === choice;
      const b = seg.createEl("button", { cls: `config-sync-cm-resolvebtn is-${choice}${on ? " is-on" : ""}` });
      setIcon(b.createSpan({ cls: "config-sync-cm-resolveic" }), icon);
      b.createSpan({ text: label });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        resolve.onPick(choice);
      });
    };
    opt("apply", "Use theirs", "arrow-down-to-line");
    opt("capture", "Keep mine", "arrow-up-from-line");
  }
  if (onExpand !== null) {
    // Left of the view toggles: this button changes WHERE you read the diff, they change HOW.
    const expand = toolbar.createEl("button", { cls: "config-sync-cm-viewbtn", attr: { "aria-label": "Open in a bigger window" } });
    setIcon(expand, "maximize-2");
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      onExpand();
    });
  }
  if (resolve !== null && resolve.scopeNote !== null) {
    host.createDiv({ cls: "config-sync-cm-resolvescope", text: resolve.scopeNote });
  }
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
    const uni = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", attr: { "aria-label": "Unified diff" } });
    setIcon(uni, "rows-2");
    const spl = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", attr: { "aria-label": "Split diff" } });
    setIcon(spl, "columns-2");
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
  const colBtn = collapseSeg.createEl("button", { cls: "config-sync-cm-viewbtn", attr: { "aria-label": "Collapse unchanged lines" } });
  setIcon(colBtn, "fold-vertical");
  const fullBtn = collapseSeg.createEl("button", { cls: "config-sync-cm-viewbtn", attr: { "aria-label": "Show all lines" } });
  setIcon(fullBtn, "unfold-vertical");
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
