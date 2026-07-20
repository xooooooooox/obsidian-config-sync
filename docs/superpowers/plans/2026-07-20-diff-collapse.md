# Diff changed-only collapse view — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a Collapse view to the Sync Center diff that shows changes plus 3 context lines and folds long unchanged runs into a `⋯ N unchanged lines ⋯` marker, toggleable against the current Full view.

**Architecture:** A pure `collapseUnchanged(ops, context)` transforms the existing `DiffOp[]` into `DiffRow[]` (op | gap). `renderDiffPanel` gains a session-level Collapse⇄Full toggle (default collapsed, both platforms); `renderUnified`/`renderSplit` render gap rows. All three diff surfaces share `renderDiffPanel`, so one change covers them.

**Tech Stack:** TypeScript, vitest. Files: `src/ui/diffView.ts`, `styles.css`, `tests/diffView.test.ts`.

## Global Constraints

- `context = 3`; toggle is session-level (not persisted), default **collapsed**; Collapse toggle on **both** mobile and desktop (Unified/Split stays desktop-only).
- Gap marker text: `⋯ ${count} unchanged line${count === 1 ? "" : "s"} ⋯`.
- No hardcoded colors — theme vars only (`./scripts/check-no-hardcoded-color.sh`).
- Gates: `npm test`, `npx eslint .` 0 errors / 67 warnings, color check OK, `npm run build` clean.
- `Full` mode is byte-identical to today; no change to `diffLines`, the 2000-line cap, or the three call sites.

---

### Task 1: `collapseUnchanged` transform + `DiffRow` type

**Files:**
- Modify: `src/ui/diffView.ts` (add `DiffRow` type + `collapseUnchanged`, after `diffLines`)
- Test: `tests/diffView.test.ts` (new)

**Interfaces:**
- Consumes: `DiffOp` (`{ kind: "common" | "del" | "ins"; text: string }`), `diffLines` — both already exported.
- Produces: `DiffRow = DiffOp | { kind: "gap"; count: number }`; `collapseUnchanged(ops: DiffOp[], context: number, minGap?: number): DiffRow[]`.

- [ ] **Step 1: Write the failing tests.** Create `tests/diffView.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffLines, collapseUnchanged, DiffOp } from "../src/ui/diffView";

const c = (n: number): DiffOp[] => Array.from({ length: n }, (_, i) => ({ kind: "common" as const, text: `c${i}` }));
const del = (t: string): DiffOp => ({ kind: "del", text: t });
const ins = (t: string): DiffOp => ({ kind: "ins", text: t });

describe("diffLines", () => {
  it("marks a single changed line as del+ins amid common", () => {
    const ops = diffLines("a\nb\nc", "a\nX\nc");
    expect(ops).not.toBeNull();
    expect(ops!.map((o) => o.kind)).toEqual(["common", "del", "ins", "common"]);
  });
});

describe("collapseUnchanged", () => {
  it("keeps `context` lines around a change and folds the far run into a gap", () => {
    // 10 common, one del, 10 common; context 3
    const ops = [...c(10), del("x"), ...c(10)];
    const rows = collapseUnchanged(ops, 3);
    // leading fold(7) + 3 common + del + 3 common + trailing fold(7)
    expect(rows.map((r) => (r.kind === "gap" ? `gap${r.count}` : r.kind))).toEqual([
      "gap7", "common", "common", "common", "del", "common", "common", "common", "gap7",
    ]);
  });
  it("does not fold a between-change run of 2*context or shorter", () => {
    const ops = [del("x"), ...c(6), ins("y")]; // 6 == 2*3
    const rows = collapseUnchanged(ops, 3);
    expect(rows.some((r) => r.kind === "gap")).toBe(false);
    expect(rows).toHaveLength(8);
  });
  it("renders a run shorter than minGap inline instead of a gap", () => {
    const ops = [del("x"), ...c(7), ins("y")]; // one non-context line in the middle → would be gap1
    const rows = collapseUnchanged(ops, 3, 2);
    expect(rows.some((r) => r.kind === "gap")).toBe(false); // gap of 1 < minGap 2 → shown inline
    expect(rows.filter((r) => r.kind === "common")).toHaveLength(7);
  });
  it("folds all-common input into one gap; all-changed input has no gap", () => {
    expect(collapseUnchanged(c(20), 3)).toEqual([{ kind: "gap", count: 20 }]);
    const changes = [del("a"), ins("b"), del("c")];
    expect(collapseUnchanged(changes, 3)).toEqual(changes);
  });
});
```

- [ ] **Step 2: Run, verify failure.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/diffView.test.ts` — Expected: FAIL (`collapseUnchanged` / `DiffOp` export missing for the new import).

- [ ] **Step 3: Implement.** In `src/ui/diffView.ts`, immediately after the `diffLines` function (before `renderUnified`), add:

```ts
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
```

- [ ] **Step 4: Run tests.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/diffView.test.ts` — Expected: ALL PASS. Also `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` — Expected: clean.

- [ ] **Step 5: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/diffView.ts tests/diffView.test.ts && git commit -m "feat: add collapseUnchanged diff transform"
```

---

### Task 2: Collapse toggle + gap rendering

**Files:**
- Modify: `src/ui/diffView.ts` (`renderUnified`, `renderSplit`, `renderDiffPanel`; add `sessionDiffCollapse`)
- Modify: `styles.css` (add `.config-sync-cm-dgap` and adjacent-seg spacing)

**Interfaces:**
- Consumes: `collapseUnchanged`, `DiffRow` (Task 1).
- Produces: no new exports; `renderUnified`/`renderSplit` now take `DiffRow[]`.

- [ ] **Step 1: Add the session preference.** In `src/ui/diffView.ts`, right after `let sessionDiffView: DiffView = "unified";`, add:

```ts
// Session-level: collapse long unchanged runs to a gap marker. Not persisted. Default collapsed.
let sessionDiffCollapse = true;
```

- [ ] **Step 2: `renderUnified` takes rows and renders gaps.** Replace the whole `renderUnified` function with:

```ts
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
```

- [ ] **Step 3: `renderSplit` takes rows and renders gaps (one per pane, aligned).** Replace the whole `renderSplit` function with:

```ts
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
```

- [ ] **Step 4: `renderDiffPanel` — compute rows + add the toggle.** In `renderDiffPanel`, replace the `render` closure body's diff section:

```ts
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
```

Then, AFTER the existing `if (!Platform.isMobile) { ...Unified/Split toggle... }` block and BEFORE the final `render();` call, add the Collapse/Full toggle (unconditional — both platforms):

```ts
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
```

- [ ] **Step 5: CSS.** In `styles.css`, find the `.config-sync-cm-dline` block (the diff line styles). Add near it:

```css
.config-sync-cm-dgap { padding: 0 10px; color: var(--text-faint); font-style: italic; border-top: 1px dashed var(--background-modifier-border); border-bottom: 1px dashed var(--background-modifier-border); }
```

If the two `.config-sync-cm-viewseg` toggles sit flush together in the toolbar (check whether `.config-sync-cm-difftools` already sets a `gap`), add spacing:

```css
.config-sync-cm-difftools .config-sync-cm-viewseg + .config-sync-cm-viewseg { margin-left: var(--size-4-2); }
```

(If `.config-sync-cm-difftools` already has a `gap`, skip this rule — verify in Step 7.)

- [ ] **Step 6: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` (clean), `npm test` (green), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK), `npm run build` (clean).

- [ ] **Step 7: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/diffView.ts styles.css && git commit -m "feat: Collapse/Full toggle folds unchanged diff runs into gap markers"
```

---

### Task 3: Live verification (dev vault)

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`; reload the plugin.
- [ ] **Step 2: Produce a multi-line diff.** Forge or find an item whose data.json differs by a line or two amid many unchanged lines (e.g. `obsidian-cli eval` to expand an item with a diff, or open the config-sync self pane after forging a small data.json change).
- [ ] **Step 3: Verify collapse.** Confirm the diff defaults to Collapse: long unchanged runs render `⋯ N unchanged lines ⋯` with 3 context lines around the change; clicking **Full** shows every line; the Collapse/Full toggle is present on mobile (force `body.is-mobile`) as well as desktop. Screenshot for the 定稿 match. Restore any forged state.

---

## Self-Review

**Spec coverage:** collapse transform → Task 1; session pref + toggle (both platforms) → Task 2 Steps 1,4; gap rendering (unified + split) → Task 2 Steps 2-3; CSS → Task 2 Step 5; live → Task 3. `diffLines` sanity test → Task 1 Step 1. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full before/after code. The Step 5 conditional (skip seg-spacing if toolbar has gap) is a concrete verify-then-apply instruction, not a gap. ✓

**Type consistency:** `DiffRow = DiffOp | { kind: "gap"; count: number }` (Task 1) is consumed by `renderUnified`/`renderSplit` (`DiffRow[]`, Task 2) and produced by `collapseUnchanged` (Task 1) / assigned from `ops: DiffOp[]` in `render` (Task 2 Step 4 — `DiffOp[]` is assignable to `DiffRow[]`). `sessionDiffCollapse: boolean` defined Task 2 Step 1, read in Step 4. Gap text string identical in unified (Step 2) and split (Step 3). ✓
