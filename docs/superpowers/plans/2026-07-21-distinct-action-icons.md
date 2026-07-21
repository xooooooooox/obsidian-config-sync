# Distinct per-action icons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Capture / Apply / Push / Pull each a unique Lucide SVG icon (colors unchanged) so no glyph is ever shared, replacing the `↑`/`↓` arrows that today distinguish the four actions by color alone.

**Architecture:** One new pure module `src/ui/actionIcons.ts` is the single source of truth (icon + color-class maps + two render helpers). Every action-direction surface in `src/ui/SyncCenterView.ts` (state columns, buttons, count badges/pills, run-history, divergence prose, self-item badge) is retargeted to derive from it. Non-action status glyphs (`✓ ≠ — ○ ? ⊘ ⌫`) stay text.

**Tech Stack:** TypeScript, Obsidian API (`setIcon`, `ButtonComponent`), CSS, vitest.

## Global Constraints

- Icons: Lucide via `setIcon` only, no emoji (DESIGN.md §148). The four names: Capture `arrow-up-from-line`, Apply `arrow-down-to-line`, Push `cloud-upload`, Pull `cloud-download`. If any renders empty on the dev vault (Obsidian bundles a Lucide subset), fall back in the registry: `cloud-upload`→`upload-cloud`, `cloud-download`→`download-cloud`, `arrow-up-from-line`→`upload`, `arrow-down-to-line`→`download`.
- Colors unchanged: Capture orange (`is-up`), Apply accent (`is-down`), Push pink (`is-push`), Pull cyan (`is-pull`). Theme vars only; no hex/rgb literals; alpha via `rgba(var(--*-rgb), α)`. The no-hardcoded-color script is a release gate.
- No behavior change: actions, counts, labels, and copy are identical — only the leading glyph changes.
- Status glyphs `✓ ≠ — ○ ?` and removal glyphs `⊘ ⌫` remain text.
- Gates (every code task): `npx tsc -noEmit -skipLibCheck` clean, `npm test` green, `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No Claude/AI attribution in any commit message.
- The DOM-render changes are **not unit-testable** (Obsidian DOM + `setIcon`); only the pure registry (Task 1) has a unit test. Per-task gate = tsc/eslint/build; end-to-end correctness is the live matrix in Task 6.

---

### Task 1: Action-icon registry + CSS + unit test

**Files:**
- Create: `src/ui/actionIcons.ts`
- Create: `tests/actionIcons.test.ts`
- Modify: `styles.css` (add one rule block near the `.config-sync-state-icon` rules, ~line 451)

**Interfaces:**
- Produces:
  - `type SyncAction = "capture" | "apply" | "push" | "pull"`
  - `const ACTION_ICON: Record<SyncAction, string>`
  - `const ACTION_COLOR_CLASS: Record<SyncAction, "is-up" | "is-down" | "is-push" | "is-pull">`
  - `function renderActionIcon(parent: HTMLElement, action: SyncAction): HTMLSpanElement` — appends a `<span class="config-sync-action-icon">` with the icon, inheriting `currentColor`; returns it.
  - `function renderActionCount(parent: HTMLElement, action: SyncAction, count: number): void` — appends the icon, then the count as a text node when `count > 0`.

- [ ] **Step 1: Write the failing test** — `tests/actionIcons.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ACTION_ICON, ACTION_COLOR_CLASS, type SyncAction } from "../src/ui/actionIcons";

describe("action icon registry", () => {
  const actions: SyncAction[] = ["capture", "apply", "push", "pull"];

  it("maps every action to an icon and a color class", () => {
    for (const a of actions) {
      expect(ACTION_ICON[a]).toBeTruthy();
      expect(ACTION_COLOR_CLASS[a]).toBeTruthy();
    }
  });

  it("uses a distinct icon per action (no glyph reuse)", () => {
    const icons = actions.map((a) => ACTION_ICON[a]);
    expect(new Set(icons).size).toBe(actions.length);
  });

  it("keeps the established per-action colors", () => {
    expect(ACTION_COLOR_CLASS).toEqual({
      capture: "is-up", apply: "is-down", push: "is-push", pull: "is-pull",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/actionIcons.test.ts`
Expected: FAIL — cannot resolve `../src/ui/actionIcons`.

- [ ] **Step 3: Create the registry** — `src/ui/actionIcons.ts`:

```ts
import { setIcon } from "obsidian";

export type SyncAction = "capture" | "apply" | "push" | "pull";

// Lucide names. If any renders empty on the installed Obsidian, swap to the fallback
// noted in the plan's Global Constraints — this map is the only place it lives.
export const ACTION_ICON: Record<SyncAction, string> = {
  capture: "arrow-up-from-line",
  apply: "arrow-down-to-line",
  push: "cloud-upload",
  pull: "cloud-download",
};

// Existing state-icon color classes, one per action. The SVG inherits the color via
// currentColor from a parent carrying one of these.
export const ACTION_COLOR_CLASS: Record<SyncAction, "is-up" | "is-down" | "is-push" | "is-pull"> = {
  capture: "is-up",
  apply: "is-down",
  push: "is-push",
  pull: "is-pull",
};

// Append an action icon to `parent`. No color class — inherits currentColor from the
// parent (a colored badge/state span, or a button's foreground). Returns the span so a
// caller on an uncolored parent can add `ACTION_COLOR_CLASS[action]` itself.
export function renderActionIcon(parent: HTMLElement, action: SyncAction): HTMLSpanElement {
  const span = parent.createSpan({ cls: "config-sync-action-icon" });
  setIcon(span, ACTION_ICON[action]);
  return span;
}

// Append an action icon followed by `count` (omitted when 0). For count badges/pills;
// `parent` carries the color class.
export function renderActionCount(parent: HTMLElement, action: SyncAction, count: number): void {
  renderActionIcon(parent, action);
  if (count > 0) parent.appendText(String(count));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/actionIcons.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add CSS** — in `styles.css`, immediately after the `.config-sync-state-icon svg` rule (line 451), add:

```css
.config-sync-action-icon { display: inline-flex; align-items: center; vertical-align: -0.12em; }
.config-sync-action-icon svg { width: 1em; height: 1em; }
.config-sync-side-badge .config-sync-action-icon,
.config-sync-pill .config-sync-action-icon,
.config-sync-fpill-short .config-sync-action-icon { margin-right: 2px; }
```

(The state-column path reuses the existing `.config-sync-state-icon svg { width:13px; height:13px }` — the icon there is set directly on the state span, not wrapped.)

- [ ] **Step 6: Gates**

Run: `npx tsc -noEmit -skipLibCheck && npm test && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build`
Expected: tsc clean; tests green (suite +3); eslint 0 errors / 67 warnings; color-check OK; build clean.

- [ ] **Step 7: Commit**

```bash
git add src/ui/actionIcons.ts tests/actionIcons.test.ts styles.css && git commit -m "feat(ui): action-icon registry + render helpers + icon CSS"
```

---

### Task 2: State-icon columns (local + remote)

Retargets the shared `stateIcon`/`remoteIcon` producers and the three `config-sync-state-icon` render sites so action states show their SVG while status states stay text.

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `stateIcon` (`:1354`), `remoteIcon` (`:1838`), render sites `:707`, `:749`, `:1308-1313`; add a private `paintStateIcon` helper.

**Interfaces:**
- Consumes: `ACTION_ICON`, `SyncAction` from Task 1.
- Produces: `stateIcon`/`remoteIcon` return type gains `action?: SyncAction`; private `paintStateIcon(el: HTMLElement, icon: { glyph: string; cls: string; action?: SyncAction }): void`.

- [ ] **Step 1: Import the registry.** At the top of `src/ui/SyncCenterView.ts`, add to the existing `./actionIcons` import needs — insert:

```ts
import { ACTION_ICON, type SyncAction } from "./actionIcons";
```

- [ ] **Step 2: Add `action` to `stateIcon`.** Replace the `stateIcon` method (`:1354-1372`) return type and the two action branches:

```ts
  private stateIcon(state: GroupState): { glyph: string; cls: string; tip: string; action?: SyncAction } {
    switch (state) {
      case "local-changed":
        return { glyph: "↑", cls: "is-up", tip: "changed on this device (likely)", action: "capture" };
      case "store-newer":
        return { glyph: "↓", cls: "is-down", tip: "store is newer (likely)", action: "apply" };
      case "differs":
        return { glyph: "≠", cls: "is-neq", tip: "differs from store — direction unknown" };
      case "not-captured":
        return { glyph: "—", cls: "is-miss", tip: "not yet captured" };
      case "no-settings":
        return { glyph: "○", cls: "is-none", tip: "no settings yet — nothing on this device or in the store" };
      case "locked":
        return { glyph: "🔒", cls: "is-locked", tip: "encrypted — set the passphrase in settings to compare" };
      case "in-sync":
      default:
        return { glyph: "✓", cls: "is-ok", tip: "in sync" };
    }
  }
```

(The `glyph` text is kept — the inert-note at `:1316` still uses it, and action states are never inert.)

- [ ] **Step 3: Add `action` to `remoteIcon`.** Replace `remoteIcon` (`:1838-1853`) return type and the two action branches:

```ts
  private remoteIcon(check: RemoteCheck | undefined): { glyph: string; cls: string; tip: string; action?: SyncAction } {
    const state = check?.state ?? "unknown";
    switch (state) {
      case "remote-newer":
        return { glyph: "↓", cls: "is-pull", tip: "remote captured later — Pull would update your store", action: "pull" };
      case "remote-older":
        return { glyph: "↑", cls: "is-push", tip: "remote is older — Push would update the remote", action: "push" };
      case "same":
        return { glyph: "✓", cls: "is-ok", tip: "remote matches your store" };
      case "no-store":
        return { glyph: "—", cls: "is-miss", tip: "no store at this remote yet" };
      case "unknown":
      default:
        return { glyph: "?", cls: "is-neq", tip: "remote state unknown" };
    }
  }
```

- [ ] **Step 4: Add `paintStateIcon` helper.** Insert directly above `stateIcon` (before `:1354`):

```ts
  // Paint a state-icon span: an action shows its SVG, locked shows the key SVG, everything
  // else stays a text glyph. The span already carries its `is-*` color class.
  private paintStateIcon(el: HTMLElement, icon: { glyph: string; cls: string; action?: SyncAction }): void {
    if (icon.action !== undefined) setIcon(el, ACTION_ICON[icon.action]);
    else if (icon.cls === "is-locked") setIcon(el, "key-round");
    else el.setText(icon.glyph);
  }
```

- [ ] **Step 5: Retarget the local state-column site** (`:1308-1313`). Replace:

```ts
    const icon = this.stateIcon(pres);
    const stateEl = row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } });
    // locked pairs the mode badge's lock with a key — "needs the passphrase" — instead of a
    // second identical lock (and the emoji ignored the state column's theme color).
    if (icon.cls === "is-locked") setIcon(stateEl, "key-round");
    else stateEl.setText(icon.glyph);
```

with:

```ts
    const icon = this.stateIcon(pres);
    const stateEl = row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } });
    // locked pairs the mode badge's lock with a key — "needs the passphrase"; actions show
    // their own icon; the rest stay text glyphs.
    this.paintStateIcon(stateEl, icon);
```

- [ ] **Step 6: Retarget the remote sidebar site** (`:706-707`). Replace:

```ts
        const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
        item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
```

with:

```ts
        const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
        this.paintStateIcon(item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } }), icon);
```

- [ ] **Step 7: Retarget the switcher remote site** (`:748-749`). Replace:

```ts
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
      sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph });
```

with:

```ts
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
      this.paintStateIcon(sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}` }), icon);
```

- [ ] **Step 8: Gates.** Run the full gate command (Task 1 Step 6). Expected: all clean; test suite unchanged (no new tests — DOM render). If `setIcon` is not already imported in this file, confirm it is (it is used at `:1312`, `:696`, etc.).

- [ ] **Step 9: Commit**

```bash
git add src/ui/SyncCenterView.ts && git commit -m "feat(ui): state columns show distinct action icons (capture/apply/push/pull)"
```

---

### Task 3: Action buttons (action bar + remote + segmented)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — segmented `segBtn` (`:1627-1647`), action-bar buttons (`:1802-1820`), remote buttons (`:1927-1943`).

**Interfaces:**
- Consumes: `renderActionIcon`, `ACTION_ICON` from Task 1; `Direction = "capture" | "apply"` (already imported from `./panelModel`).

- [ ] **Step 1: Import the count/icon helpers.** Ensure the file imports `renderActionIcon` (and `renderActionCount`, used in Task 4) from `./actionIcons`. Update the Task 2 import line to:

```ts
import { ACTION_ICON, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";
```

- [ ] **Step 2: Segmented per-item buttons.** In `renderDirectionToggle`, replace the `segBtn` body's button creation (`:1629-1633`) and the two calls (`:1646-1647`).

Replace:

```ts
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-${d}${on ? " is-on" : ""}`,
        text: label,
        attr: { "aria-label": aria },
      });
```

with:

```ts
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-${d}${on ? " is-on" : ""}`,
        attr: { "aria-label": aria },
      });
      renderActionIcon(b, d);
      b.appendText(` ${label}`);
```

and replace the two calls:

```ts
    segBtn("capture", "↑ Capture", "Capture this (keep local)");
    segBtn("apply", "↓ Apply store", "Apply store version (overwrites local)");
```

with:

```ts
    segBtn("capture", "Capture", "Capture this (keep local)");
    segBtn("apply", "Apply store", "Apply store version (overwrites local)");
```

(`d` is `Direction` = `"capture" | "apply"`, a subset of `SyncAction`, so `renderActionIcon(b, d)` type-checks. The seg button's foreground colors the icon — unchanged from the old text arrow.)

- [ ] **Step 3: Action-bar Capture button** (`:1806-1808`). Replace the else branch:

```ts
    } else {
      capW.btn.setButtonText(`↑ Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
    }
```

with:

```ts
    } else {
      renderActionIcon(capW.btn.buttonEl, "capture");
      capW.btn.buttonEl.appendText(` Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
    }
```

- [ ] **Step 4: Action-bar Apply button** (`:1817-1819`). Replace the else branch:

```ts
    } else {
      applyW.btn.setButtonText(`↓ Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
    }
```

with:

```ts
    } else {
      renderActionIcon(applyW.btn.buttonEl, "apply");
      applyW.btn.buttonEl.appendText(` Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
    }
```

(The busy branches keep `setButtonText(runProgressLabel(...))` — no icon during progress. Each button is freshly created by `mkWrapped()` so `buttonEl` starts empty; the icon inherits the solid button's foreground, not the accent color.)

- [ ] **Step 5: Remote Pull button** (`:1927-1928`). Replace:

```ts
    const pull = new ButtonComponent(bar);
    pull.setButtonText(`↓ Pull from ${remote.name}`);
```

with:

```ts
    const pull = new ButtonComponent(bar);
    renderActionIcon(pull.buttonEl, "pull");
    pull.buttonEl.appendText(` Pull from ${remote.name}`);
```

- [ ] **Step 6: Remote Push button** (`:1941-1942`). Replace:

```ts
    const push = new ButtonComponent(bar);
    push.setButtonText(`↑ Push to ${remote.name}`);
```

with:

```ts
    const push = new ButtonComponent(bar);
    renderActionIcon(push.buttonEl, "push");
    push.buttonEl.appendText(` Push to ${remote.name}`);
```

- [ ] **Step 7: Gates.** Run the full gate command. Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/ui/SyncCenterView.ts && git commit -m "feat(ui): action buttons carry distinct action icons"
```

---

### Task 4: Count badges, pills & self-item badge

Every aggregate count that showed `↑N`/`↓N` now renders icon + count via `renderActionCount`. Status pills (`✓`, `○`) are untouched.

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `selfBadge` (`:428-444`) + its consumer (`:418-419`), sidebar count badges (`:665-667`), switcher badges (`:737-739`), header pills (`:768-781`), mobile filter-pill defs + short render (`:1029-1039`).

**Interfaces:**
- Consumes: `renderActionCount`, `SyncAction` from Task 1.

- [ ] **Step 1: Restructure `selfBadge`.** Replace the method (`:428-444`):

```ts
  private selfBadge(info: SelfSyncInfo): { cls: string; action?: SyncAction; count?: number; text?: string } | null {
    // Count the sync-list delta; when the change is config-sync's own content/version (no list
    // delta), show a bare icon rather than a misleading "↑0"/"↓0".
    const n = info.delta.added.length + info.delta.removed.length;
    switch (info.state) {
      case "coldstart":
        return { cls: "is-down", text: "setup" };
      case "adopt":
        return { cls: "is-down", action: "apply", count: n };
      case "capture":
        return { cls: "is-up", action: "capture", count: n };
      case "both":
        return { cls: "is-up", text: "⚠" };
      case "insync":
        return null;
    }
  }
```

- [ ] **Step 2: Update the `selfBadge` consumer** (`:418-419`). Replace:

```ts
      const b = this.selfBadge(info);
      if (b !== null) item.createSpan({ cls: `config-sync-side-badge ${b.cls}`, text: b.text });
```

with:

```ts
      const b = this.selfBadge(info);
      if (b !== null) {
        const badge = item.createSpan({ cls: `config-sync-side-badge ${b.cls}` });
        if (b.action !== undefined) renderActionCount(badge, b.action, b.count ?? 0);
        else badge.setText(b.text ?? "");
      }
```

- [ ] **Step 3: Sidebar count badges** (`:665-667`). Replace:

```ts
        const c = this.presentedCounts(rows);
        if (c.up > 0) item.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
        if (c.down > 0) item.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
```

with:

```ts
        const c = this.presentedCounts(rows);
        if (c.up > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
        if (c.down > 0) renderActionCount(item.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
```

(The `✓${c.ok}` / `○${c.none}` lines just below stay unchanged.)

- [ ] **Step 4: Switcher badges** (`:737-739`). Replace:

```ts
      const c = this.presentedCounts(this.scopedRows().filter((r) => this.sectionOf(r.group.name) === "main"));
      if (c.up > 0) sw.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) sw.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
```

with:

```ts
      const c = this.presentedCounts(this.scopedRows().filter((r) => this.sectionOf(r.group.name) === "main"));
      if (c.up > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
      if (c.down > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
```

- [ ] **Step 5: Header pills** (`:768-781`). Replace:

```ts
    if (up > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-up",
        text: `↑ ${up}`,
        attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` },
      });
    }
    if (down > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-down",
        text: `↓ ${down}`,
        attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` },
      });
    }
```

with:

```ts
    if (up > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-up", attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` } }),
        "capture", up,
      );
    }
    if (down > 0) {
      renderActionCount(
        pills.createSpan({ cls: "config-sync-pill is-down", attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` } }),
        "apply", down,
      );
    }
```

(The `✓ ${ok}` / `○ ${none}` pills just below stay unchanged.)

- [ ] **Step 6: Mobile filter-pill defs** (`:1029-1034`). Replace:

```ts
      const defs: { key: PanelFilter; label: string; short: string }[] = [
        { key: "all", label: allLabel, short: allLabel },
        { key: "capture", label: `To capture ${counts.up}`, short: `↑ ${counts.up}` },
        { key: "apply", label: `To apply ${counts.down}`, short: `↓ ${counts.down}` },
        { key: "ok", label: `In sync ${counts.ok}`, short: `✓ ${counts.ok}` },
        { key: "none", label: `No settings yet ${counts.none}`, short: `○ ${counts.none}` },
      ];
```

with:

```ts
      const defs: { key: PanelFilter; label: string; short: string; action?: SyncAction; count?: number }[] = [
        { key: "all", label: allLabel, short: allLabel },
        { key: "capture", label: `To capture ${counts.up}`, short: "", action: "capture", count: counts.up },
        { key: "apply", label: `To apply ${counts.down}`, short: "", action: "apply", count: counts.down },
        { key: "ok", label: `In sync ${counts.ok}`, short: `✓ ${counts.ok}` },
        { key: "none", label: `No settings yet ${counts.none}`, short: `○ ${counts.none}` },
      ];
```

- [ ] **Step 7: Mobile filter-pill short render** (`:1039`). Replace:

```ts
        pill.createSpan({ cls: "config-sync-fpill-short", text: d.short });
```

with:

```ts
        const shortEl = pill.createSpan({ cls: "config-sync-fpill-short" });
        if (d.action !== undefined) renderActionCount(shortEl, d.action, d.count ?? 0);
        else shortEl.setText(d.short);
```

(Icon inherits the pill's foreground — the short glyphs were uncolored before, so this preserves today's look.)

- [ ] **Step 8: Gates.** Run the full gate command. Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git add src/ui/SyncCenterView.ts && git commit -m "feat(ui): count badges, pills, and self-item badge use action icons"
```

---

### Task 5: Run-history action cell + divergence prose + DESIGN.md

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `actionCell` (`:874-881`) + its glyph render (`:928-930`), divergence lines (`:1495-1502`).
- Modify: `styles.css` — add `.config-sync-hglyph` action colors + svg sizing.
- Modify: `docs/design/DESIGN.md` — §2.1, §2.3, §2.4.

**Interfaces:**
- Consumes: `renderActionIcon`, `ACTION_COLOR_CLASS`, `ACTION_ICON`, `SyncAction` from Task 1.

- [ ] **Step 1: Extend the import** to include `ACTION_COLOR_CLASS`:

```ts
import { ACTION_ICON, ACTION_COLOR_CLASS, renderActionIcon, renderActionCount, type SyncAction } from "./actionIcons";
```

- [ ] **Step 2: `actionCell` returns an action.** Replace (`:874-881`):

```ts
  private actionCell(rec: RunRecord): { glyph: string; dir: "in" | "out" | "remove"; label: string } {
    if (rec.kind === "stop-sync") return { glyph: "⊘", dir: "remove", label: "Stop syncing" };
    if (rec.kind === "delete-leftover") return { glyph: "⌫", dir: "remove", label: "Delete leftover" };
    const out = rec.kind === "capture" || rec.kind === "push";
    const base = rec.kind.charAt(0).toUpperCase() + rec.kind.slice(1);
    const label = rec.remote !== null ? `${base} · ${rec.remote}` : base;
    return { glyph: out ? "↑" : "↓", dir: out ? "out" : "in", label };
  }
```

with:

```ts
  private actionCell(rec: RunRecord): { glyph: string; dir: "in" | "out" | "remove"; label: string; action?: SyncAction } {
    if (rec.kind === "stop-sync") return { glyph: "⊘", dir: "remove", label: "Stop syncing" };
    if (rec.kind === "delete-leftover") return { glyph: "⌫", dir: "remove", label: "Delete leftover" };
    const out = rec.kind === "capture" || rec.kind === "push";
    const base = rec.kind.charAt(0).toUpperCase() + rec.kind.slice(1);
    const label = rec.remote !== null ? `${base} · ${rec.remote}` : base;
    // rec.kind is exactly one of the four actions here — split the old out/in glyph into
    // per-action icons so history matches the panel's vocabulary.
    return { glyph: out ? "↑" : "↓", dir: out ? "out" : "in", label, action: rec.kind };
  }
```

(`rec.kind` at this point is one of `"capture" | "apply" | "push" | "pull"` — all valid `SyncAction`. If `RunRecord["kind"]` is a wider union, narrow with an explicit map instead: `const action = ({capture:"capture",apply:"apply",push:"push",pull:"pull"} as const)[rec.kind]` — but the two removal kinds already returned above, so a direct assignment type-checks against the remaining union.)

- [ ] **Step 3: Render the history glyph as an icon.** Replace (`:928-930`):

```ts
      const act = this.actionCell(rec);
      const td = ...; // keep the existing surrounding line that creates the cell
      td.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
```

with (change only the glyph span line — keep the `const act` and the cell `td` creation exactly as they are):

```ts
      if (act.action !== undefined) setIcon(td.createSpan({ cls: `config-sync-hglyph ${ACTION_COLOR_CLASS[act.action]}` }), ACTION_ICON[act.action]);
      else td.createSpan({ cls: `config-sync-hglyph is-${act.dir}`, text: act.glyph });
```

(Read `:924-931` in the file to place this exactly — the surrounding `const act = this.actionCell(rec)` and `td` creation stay; only the `td.createSpan({... text: act.glyph})` line is replaced by the `if/else` above. Removal rows keep `is-remove` + text.)

- [ ] **Step 4: Divergence prose leading icons** (`:1495-1502`). Replace:

```ts
      box.createDiv({
        cls: "config-sync-divergence-line",
        text: `↑ Capture removes ${d.captureRemoves.length} from the shared list — other devices will turn them off: ${d.captureRemoves.join(", ")}`,
      });
      box.createDiv({
        cls: "config-sync-divergence-line",
        text: `↓ Apply turns off ${d.applyDisables.length} on this device — exclude them first to keep them: ${d.applyDisables.join(", ")}`,
      });
```

with:

```ts
      const capLine = box.createDiv({ cls: "config-sync-divergence-line" });
      renderActionIcon(capLine, "capture").addClass(ACTION_COLOR_CLASS.capture);
      capLine.appendText(` Capture removes ${d.captureRemoves.length} from the shared list — other devices will turn them off: ${d.captureRemoves.join(", ")}`);
      const applyLine = box.createDiv({ cls: "config-sync-divergence-line" });
      renderActionIcon(applyLine, "apply").addClass(ACTION_COLOR_CLASS.apply);
      applyLine.appendText(` Apply turns off ${d.applyDisables.length} on this device — exclude them first to keep them: ${d.applyDisables.join(", ")}`);
```

(The line divs are uncolored, so here the icon carries its own color class.)

- [ ] **Step 5: History glyph CSS.** In `styles.css`, after the existing `.config-sync-hglyph.is-remove` rule (line ~634), add:

```css
.config-sync-hglyph.is-up { color: var(--color-orange); }
.config-sync-hglyph.is-down { color: var(--interactive-accent); }
.config-sync-hglyph.is-push { color: var(--color-pink); }
.config-sync-hglyph.is-pull { color: var(--color-cyan); }
.config-sync-hglyph svg { width: 13px; height: 13px; vertical-align: -0.12em; }
```

- [ ] **Step 6: Update DESIGN.md.** In `docs/design/DESIGN.md`:
  - §2.1 (`:75-78`): replace the shared-arrow axis sentence. New text — "Action states carry dedicated Lucide icons (via `setIcon`): capture `arrow-up-from-line`/orange, apply `arrow-down-to-line`/accent, push `cloud-upload`/pink, pull `cloud-download`/cyan (`src/ui/actionIcons.ts` is the single source). Status glyphs stay text: `≠` differs/faint · `—` miss/faint · `○` no-settings/faint · `✓` ok/green · `?` unknown · **key** (`key-round`) locked/cyan." Remove the "deliberately … 定稿 2026-07-18" shared-arrow note.
  - §2.3 (`:87-93`): add to the Lucide-usage list: `arrow-up-from-line` / `arrow-down-to-line` / `cloud-upload` / `cloud-download` (the four sync-action icons).
  - §2.4 (`:95-100`): change the "Direction/count vocabulary `↑ ↓ ✓ ○`" line to note that direction *actions* now use dedicated icons (`actionIcons.ts`) while count badges embed those icons + a number; `✓ ○` remain text.

- [ ] **Step 7: Gates.** Run the full gate command. Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/ui/SyncCenterView.ts styles.css docs/design/DESIGN.md && git commit -m "feat(ui): run-history + divergence use action icons; update DESIGN.md"
```

---

### Task 6: Live verification (desktop + mobile)

**Files:** none (verification only; a one-line registry swap if a Lucide name is empty).

The dev vault is at `dev/vault/`; drive it with `obsidian-cli` (routes by CWD, run from `dev/vault/`). Binary: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`. `eval` needs `code=<js>`; wrap top-level `await` in `(async()=>{ ... })()`. Focus Obsidian first (`open -a Obsidian`) — a backgrounded window throttles rendering.

- [ ] **Step 1: Deploy + reload.** `cd ~/local/coding/open/obsidian-config-sync && npm run build && cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`, then from `dev/vault/`: `obsidian-cli eval code="(async()=>{await app.plugins.disablePlugin('config-sync');await app.plugins.enablePlugin('config-sync');return 'reloaded';})()"`.

- [ ] **Step 2: Confirm the four icons render (name check).** From `dev/vault/`, open the Sync Center and probe that action state icons produced non-empty `<svg>`:

```js
(async()=>{
  const leaf = app.workspace.getLeavesOfType('config-sync-center')[0] ?? app.workspace.getLeaf(true);
  // Open the view if needed, then read the DOM.
  await new Promise(r=>setTimeout(r,300));
  const svgs = document.querySelectorAll('.config-sync-state-icon svg, .config-sync-action-icon svg, .config-sync-hglyph svg').length;
  const empties = [...document.querySelectorAll('.config-sync-action-icon')].filter(e=>!e.querySelector('svg')).length;
  return JSON.stringify({ svgs, emptyActionIcons: empties });
})()
```

Expected: `svgs` > 0, `emptyActionIcons: 0`. If any `.config-sync-action-icon` is empty, a Lucide name is unavailable — swap it in `src/ui/actionIcons.ts` per the Global Constraints fallbacks, rebuild, redeploy, re-probe.

- [ ] **Step 3: Desktop visual pass.** With the Sync Center open on desktop, confirm by eye/screenshot: action-bar Capture (orange up-from-line) / Apply (accent down-to-line); a remote's Pull (cyan cloud-down) / Push (pink cloud-up) buttons and state icon; per-item state column shows the right icon per direction; header pills and sidebar badges show icon + count; `✓ ≠ — ○` still render as text. Expand an item with a two-way divergence and confirm the two prose lines lead with colored capture/apply icons. Open History and confirm each run row shows its per-action icon (capture orange, push pink, apply accent, pull cyan) with the text label intact, and `⊘`/`⌫` rows stay text.

- [ ] **Step 4: Mobile pass (390×844).** Emulate a phone (or real device). Confirm the mobile filter-pill row shows icon + count for capture/apply and does not overflow/wrap the phone width in the common case; count badges align icon and number cleanly (this was the mobile decision point — 变体 1). Screenshot desktop + mobile.

- [ ] **Step 5: Finish.** Announce and use superpowers:finishing-a-development-branch to complete the work (verify tests, present merge/PR/keep options). Do **not** cut a release — versioning/publish is a separate owner-driven step.

---

## Self-Review

**Spec coverage:**
- Registry single-source (spec §Architecture) → Task 1. ✓
- Four icons + colors unchanged (spec Decision table) → Task 1 maps; asserted in unit test. ✓
- Surfaces 1-2 state columns → Task 2. Buttons (3) → Task 3. Aggregate counts 6-9 + self-badge 12 → Task 4. Run-history 11 + divergence 10 → Task 5. ✓ (Surface numbering per spec; selfBadge is both the "badge helper" #9 and #12 — handled once in Task 4.)
- Status glyphs untouched (spec) → every task leaves `✓ ≠ — ○ ? ⊘ ⌫` as text. ✓
- CSS `.config-sync-action-icon` sizing + no hardcoded color → Task 1 Step 5 (theme vars only); history colors reuse theme vars → Task 5 Step 5. ✓
- Lucide-availability risk + fallbacks → Global Constraints + Task 6 Step 2. ✓
- DESIGN.md §2.1/§2.3/§2.4 → Task 5 Step 6. ✓
- Testing: unit for the pure registry (spec) → Task 1; live desktop+mobile (spec §Testing) → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after; the one "read to place exactly" note (Task 5 Step 3) still gives the exact replacement lines. ✓

**Type consistency:** `SyncAction`, `ACTION_ICON`, `ACTION_COLOR_CLASS`, `renderActionIcon` (returns `HTMLSpanElement`), `renderActionCount` (returns `void`) are defined in Task 1 and used with matching signatures in Tasks 2-5. `stateIcon`/`remoteIcon`/`actionCell`/`selfBadge` return-type extensions each add `action?: SyncAction` (or the selfBadge discriminated shape) consistently with their consumers. `Direction = "capture" | "apply"` ⊆ `SyncAction`. ✓
