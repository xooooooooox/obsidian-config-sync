# Status Bar Sync Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the sync-status indicator to an Obsidian status-bar item (icon + ↑n ↓n ⇡n ⇣n segments), demote the ribbon dot to an opt-in toggle, and add a CSS-only mobile force-show toggle.

**Architecture:** A new pure module `src/ui/statusBar.ts` computes the segment list and aria-label from bucket counts + remote direction counts (unit-tested); `main.ts` renames `updateRibbonDot()` to `updateStatusIndicators()` which drives both surfaces; `SettingTab.ts` adds a "Status bar" heading with four registry-backed toggles.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild.

Spec: `docs/superpowers/specs/2026-07-24-status-bar-design.md` — read it for rationale. The mockup (candidate A, plain colored text segments) is binding for structure, copy, and colors.

## Global Constraints

- **No git commits.** All changes stay in the working tree; the user commits at cut time. Review packages are working-tree diffs.
- Gates for every task that touches code: `npm test` (all green), `npm run build`, `npm run lint` — lint must stay at the existing baseline (0 errors / 67 warnings); no new warnings, never inline eslint-disables.
- Copy is verbatim from this plan (sourced from the approved mockup). Segment glyphs exactly: `↑` up, `↓` down, `⇡` push, `⇣` pull.
- Segment colors exactly: up `var(--color-orange)`, down `var(--interactive-accent)`, push `var(--color-pink)`, pull `var(--color-cyan)` — same mapping as the Sync Center header pills.
- New settings defaults: `statusBarItem: true`, `statusBarRemote: true`, `ribbonDot: false`, `mobileStatusBar: false`.
- No behavior changes beyond the spec: no syncing/error states, no changes to `openSyncMenu`, `statusInMenu`, or the extra ribbon buttons.

---

### Task 1: Pure segment model (`statusBar.ts`)

**Files:**
- Create: `src/ui/statusBar.ts`
- Test: `tests/statusBar.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. `setIcon` from `obsidian` (mocked in tests like other `ui/` modules).
- Produces (Task 2 relies on these exact signatures):
  - `interface StatusBarSegment { kind: "up" | "down" | "push" | "pull"; count: number; text: string }`
  - `statusBarSegments(counts: { up: number; down: number }, remote: { push: number; pull: number }, showRemote: boolean): StatusBarSegment[]`
  - `statusBarAriaLabel(segments: StatusBarSegment[]): string`
  - `renderStatusBarItem(el: HTMLElement, segments: StatusBarSegment[]): void`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/statusBar.test.ts
import { describe, it, expect } from "vitest";
import { statusBarSegments, statusBarAriaLabel } from "../src/ui/statusBar";

describe("statusBarSegments", () => {
  it("renders all four segments when every count is non-zero and remote is shown", () => {
    expect(statusBarSegments({ up: 2, down: 1 }, { push: 1, pull: 3 }, true)).toEqual([
      { kind: "up", count: 2, text: "↑2" },
      { kind: "down", count: 1, text: "↓1" },
      { kind: "push", count: 1, text: "⇡1" },
      { kind: "pull", count: 3, text: "⇣3" },
    ]);
  });

  it("hides zero-count segments", () => {
    expect(statusBarSegments({ up: 3, down: 0 }, { push: 0, pull: 0 }, true)).toEqual([
      { kind: "up", count: 3, text: "↑3" },
    ]);
  });

  it("suppresses push/pull when showRemote is false despite non-zero counts", () => {
    expect(statusBarSegments({ up: 2, down: 1 }, { push: 1, pull: 1 }, false)).toEqual([
      { kind: "up", count: 2, text: "↑2" },
      { kind: "down", count: 1, text: "↓1" },
    ]);
  });

  it("returns an empty list when everything is zero (clean state)", () => {
    expect(statusBarSegments({ up: 0, down: 0 }, { push: 0, pull: 0 }, true)).toEqual([]);
  });
});

describe("statusBarAriaLabel", () => {
  it("lists only the segments present, in panel-pill terms", () => {
    expect(
      statusBarAriaLabel([
        { kind: "up", count: 2, text: "↑2" },
        { kind: "down", count: 1, text: "↓1" },
        { kind: "push", count: 1, text: "⇡1" },
      ])
    ).toBe("Config Sync — 2 to capture · 1 to apply · push 1");
  });

  it("includes pull when present", () => {
    expect(statusBarAriaLabel([{ kind: "pull", count: 2, text: "⇣2" }])).toBe("Config Sync — pull 2");
  });

  it("reports all in sync for the empty list", () => {
    expect(statusBarAriaLabel([])).toBe("Config Sync — all in sync");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/statusBar.test.ts`
Expected: FAIL — cannot resolve `../src/ui/statusBar`.

- [ ] **Step 3: Implement**

```ts
// src/ui/statusBar.ts
import { setIcon } from "obsidian";

// The status-bar item's content model. Same sources and color semantics as the Sync Center
// header pills: ↑ to capture, ↓ to apply, ⇡ push / ⇣ pull are per-remote direction counts.
export type StatusBarSegmentKind = "up" | "down" | "push" | "pull";

export interface StatusBarSegment {
  kind: StatusBarSegmentKind;
  count: number;
  text: string;
}

const GLYPH: Record<StatusBarSegmentKind, string> = { up: "↑", down: "↓", push: "⇡", pull: "⇣" };

// Zero-count segments are hidden; push/pull additionally require the remote sub-toggle.
export function statusBarSegments(
  counts: { up: number; down: number },
  remote: { push: number; pull: number },
  showRemote: boolean
): StatusBarSegment[] {
  const seg = (kind: StatusBarSegmentKind, count: number): StatusBarSegment => ({ kind, count, text: `${GLYPH[kind]}${count}` });
  const out: StatusBarSegment[] = [];
  if (counts.up > 0) out.push(seg("up", counts.up));
  if (counts.down > 0) out.push(seg("down", counts.down));
  if (showRemote && remote.push > 0) out.push(seg("push", remote.push));
  if (showRemote && remote.pull > 0) out.push(seg("pull", remote.pull));
  return out;
}

export function statusBarAriaLabel(segments: StatusBarSegment[]): string {
  if (segments.length === 0) return "Config Sync — all in sync";
  const phrase = (s: StatusBarSegment): string =>
    s.kind === "up" ? `${s.count} to capture` : s.kind === "down" ? `${s.count} to apply` : `${s.kind} ${s.count}`;
  return `Config Sync — ${segments.map(phrase).join(" · ")}`;
}

// Thin DOM shell: rebuilds the item in place. Not unit-tested (repo policy: vitest covers pure
// logic only; DOM is stubbed) — verified via the dev-vault smoke.
export function renderStatusBarItem(el: HTMLElement, segments: StatusBarSegment[]): void {
  el.empty();
  el.toggleClass("is-clean", segments.length === 0);
  setIcon(el.createSpan({ cls: "config-sync-sb-icon" }), "refresh-cw");
  for (const s of segments) el.createSpan({ cls: `config-sync-sb-seg is-${s.kind}`, text: s.text });
  el.setAttribute("aria-label", statusBarAriaLabel(segments));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/statusBar.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Gates**

Run: `npm test && npm run build && npm run lint`
Expected: all tests green, build clean, lint at baseline (0 errors / 67 warnings).

### Task 2: Wire `main.ts` + CSS

**Files:**
- Modify: `src/main.ts` — settings interface/defaults (~lines 48-84), `onload` (~line 152), `onunload` (~line 217), `updateRibbonDot` (~line 309) and its three call sites (~lines 257, 298, 361)
- Modify: `styles.css` — append after the `.config-sync-dot-*` block (~line 450)

**Interfaces:**
- Consumes (Task 1): `statusBarSegments`, `renderStatusBarItem` from `./ui/statusBar`; existing `remoteDirectionCounts` from `./core/status` and `bucketCounts` (already imported).
- Produces (Task 3 relies on): public methods `updateStatusIndicators(): void` and `applyMobileStatusBar(): void` on the plugin, and settings fields `statusBarItem` / `statusBarRemote` / `ribbonDot` / `mobileStatusBar` (all `boolean`).

- [ ] **Step 1: Settings fields and defaults**

In `interface ConfigSyncSettings`, after `statusInMenu: boolean;` add:

```ts
  statusBarItem: boolean; // master toggle for the status-bar item
  statusBarRemote: boolean; // include per-remote ⇡ push / ⇣ pull segments
  ribbonDot: boolean; // legacy corner dot on the ribbon icon (off by default since the status bar took over)
  mobileStatusBar: boolean; // force-show Obsidian's status bar on phones (CSS class only)
```

In `DEFAULT_SETTINGS`, after `statusInMenu: true,` add:

```ts
  statusBarItem: true,
  statusBarRemote: true,
  ribbonDot: false,
  mobileStatusBar: false,
```

(`loadSettings` merges over `DEFAULT_SETTINGS`, so existing installs pick these up without migration.)

- [ ] **Step 2: Create the item in `onload`, clean up in `onunload`**

Add a field next to `mainRibbonEl`:

```ts
  private statusBarEl: HTMLElement | null = null;
```

In `onload`, directly after `this.refreshRibbons();`:

```ts
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("config-sync-statusbar", "mod-clickable");
    this.registerDomEvent(this.statusBarEl, "click", () => void this.openSyncCenter());
    this.updateStatusIndicators();
    this.applyMobileStatusBar();
```

In `onunload`, add as the last line:

```ts
    document.body.removeClass("config-sync-mobile-statusbar");
```

- [ ] **Step 3: Rename `updateRibbonDot` → `updateStatusIndicators`, drive both surfaces**

Replace the whole `updateRibbonDot` method with:

```ts
  updateStatusIndicators(): void {
    const s = this.presentedStatuses ?? this.localStatuses ?? [];
    const { up, down } = bucketCounts(s);
    const remoteStates = [...this.remoteChecks.values()].map((v) => v.check.state);
    const el = this.mainRibbonEl;
    if (el !== null) {
      const remoteNewer = remoteStates.some((st) => st === "remote-newer");
      el.toggleClass("config-sync-dot-capture", this.settings.ribbonDot && up > 0);
      el.toggleClass("config-sync-dot-apply", this.settings.ribbonDot && up === 0 && (down > 0 || remoteNewer));
      // aria-label stays "Config Sync" from addRibbonIcon — no pending-count suffix.
    }
    const sb = this.statusBarEl;
    if (sb !== null) {
      sb.toggle(this.settings.statusBarItem);
      renderStatusBarItem(sb, statusBarSegments({ up, down }, remoteDirectionCounts(remoteStates), this.settings.statusBarRemote));
    }
  }

  applyMobileStatusBar(): void {
    document.body.toggleClass("config-sync-mobile-statusbar", Platform.isMobile && this.settings.mobileStatusBar);
  }
```

Imports: add `remoteDirectionCounts` to the existing `./core/status` import; add `import { renderStatusBarItem, statusBarSegments } from "./ui/statusBar";`.

Rename the three call sites (`refreshLocalStatus`, `refreshRemoteChecks`, and `computeStatuses` inside `syncCenterHost()`) from `this.updateRibbonDot()` to `this.updateStatusIndicators()`. `git grep -n "updateRibbonDot" src/` must return nothing afterwards.

Note the deliberate semantic split (spec section A): the dot keeps its old combined logic (remote-newer folds into the apply dot), while the status bar mirrors the panel pills exactly (remote-newer appears as `⇣` pull, not `↓`).

- [ ] **Step 4: CSS**

Append to `styles.css` directly after the `.config-sync-dot-apply::after` rule:

```css
.config-sync-statusbar { display: inline-flex; align-items: center; gap: var(--size-2-2); }
.config-sync-statusbar .config-sync-sb-icon { display: inline-flex; --icon-size: 13px; }
.config-sync-statusbar .svg-icon { flex: none; }
.config-sync-statusbar.is-clean .config-sync-sb-icon { color: var(--text-faint); }
.config-sync-sb-seg { font-variant-numeric: tabular-nums; font-weight: 500; }
.config-sync-sb-seg.is-up { color: var(--color-orange); }
.config-sync-sb-seg.is-down { color: var(--interactive-accent); }
.config-sync-sb-seg.is-push { color: var(--color-pink); }
.config-sync-sb-seg.is-pull { color: var(--color-cyan); }

/* Opt-in mobile force-show: CSS class only — no MutationObserver, no inline styles, so it
   cannot fight Remotely Save's mechanism (whichever is enabled wins its own lane). */
body.is-mobile.config-sync-mobile-statusbar .status-bar {
  display: flex;
  margin-bottom: var(--mobile-toolbar-height, 52px);
}
```

(`.svg-icon { flex: none; }` guards against the flex-shrink squash that hit the quick-menu buttons in 1.6.0.)

- [ ] **Step 5: Gates**

Run: `npm test && npm run build && npm run lint`
Expected: all green, lint at baseline. `npm run lint` must not add a sentence-case warning (all new user-visible strings live in Task 1/Task 3 copy, already sentence-cased with the existing brands "Config Sync" / "Sync Center").

- [ ] **Step 6: Dev-vault smoke (controller may run this instead of the implementer)**

Build, then from the dev vault (obsidian-cli routes by CWD — `cd dev/vault` in the same shell invocation as each call):

```bash
npm run build
cd dev/vault && obsidian-cli command id=app:reload
```

Then eval checks (adapt selector output by hand):

```bash
cd dev/vault && obsidian-cli eval 'const el = document.querySelector(".status-bar .config-sync-statusbar"); JSON.stringify({ found: el !== null, aria: el?.getAttribute("aria-label"), segs: [...(el?.querySelectorAll(".config-sync-sb-seg") ?? [])].map(s => [s.className, s.textContent]), clean: el?.classList.contains("is-clean") })'
```

Expected: `found: true`; with pending items, `segs` lists `is-up`/`is-down` entries whose text matches the Sync Center pills; with none, `clean: true` and aria `Config Sync — all in sync`. Click check: `el.click()` then confirm a `config-sync-sync-center` leaf opened (`app.workspace.getLeavesOfType("config-sync-sync-center").length === 1` — verify the exact view type string against `SYNC_CENTER_VIEW_TYPE` in `src/ui/SyncCenterView.ts` before asserting). Ribbon check: `document.querySelector(".side-dock-ribbon-action[aria-label='Config Sync']").className` contains no `config-sync-dot-*` class (dot default off).

### Task 3: Settings toggles

**Files:**
- Modify: `src/ui/SettingTab.ts` — `SettingsHost` interface (~line 35), `GENERAL_SETTINGS` (~line 133), General-tab render order (~lines 348-351), new method next to `renderRibbonToggles` (~line 1450)

**Interfaces:**
- Consumes (Task 2): `host.settings.statusBarItem` / `statusBarRemote` / `ribbonDot` / `mobileStatusBar` (`boolean`); `host.updateStatusIndicators(): void`; `host.applyMobileStatusBar(): void`.
- Produces: nothing downstream.

- [ ] **Step 1: Extend `SettingsHost`**

In the `settings` object type, after `statusInMenu: boolean;` add:

```ts
    statusBarItem: boolean;
    statusBarRemote: boolean;
    ribbonDot: boolean;
    mobileStatusBar: boolean;
```

After `refreshRibbons(): void;` add:

```ts
  updateStatusIndicators(): void;
  applyMobileStatusBar(): void;
```

- [ ] **Step 2: Registry entries**

In `GENERAL_SETTINGS`, insert directly before the `"Ribbon buttons"` entry (registry order feeds the search index only; UI order comes from the render calls):

```ts
  {
    name: "Show status bar item",
    desc: "Sync status in the status bar: ↑ to capture, ↓ to apply. Click opens the Sync Center.",
    anchorId: "general-status-bar-item",
  },
  {
    name: "Show remote push/pull in status bar",
    desc: "Include per-remote push ⇡ and pull ⇣ counts. Desktop only — remote checks don't run on mobile.",
    anchorId: "general-status-bar-remote",
  },
  {
    name: "Ribbon icon status dot",
    desc: "Colored corner dot on the ribbon icon — the old indicator, now off by default (invisible when the icon sits inside a ribbon group).",
    anchorId: "general-ribbon-dot",
  },
  {
    name: "Show status bar on mobile",
    desc: "Force the status bar visible on phones (Obsidian hides it by default). Leave off if another plugin or snippet already shows it.",
    anchorId: "general-mobile-status-bar",
  },
```

Copy is verbatim from the approved mockup — do not rephrase. (The mobile entry stays in the index on desktop even though its row only renders on mobile; conditional rows already exist in this tab.)

- [ ] **Step 3: Render method**

Add after `renderRibbonToggles` (same file section):

```ts
  private renderStatusBarToggles(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Status bar").setHeading();
    const toggleRow = (anchorId: string, get: () => boolean, set: (v: boolean) => void, after: () => void): void => {
      const def = this.generalSetting(anchorId);
      this.anchor(new Setting(containerEl).setName(def.name).setDesc(def.desc), anchorId).addToggle((t) =>
        t.setValue(get()).onChange(async (v) => {
          set(v);
          await this.host.saveSettings();
          after();
        })
      );
    };
    toggleRow("general-status-bar-item", () => this.host.settings.statusBarItem, (v) => (this.host.settings.statusBarItem = v), () => this.host.updateStatusIndicators());
    toggleRow("general-status-bar-remote", () => this.host.settings.statusBarRemote, (v) => (this.host.settings.statusBarRemote = v), () => this.host.updateStatusIndicators());
    toggleRow("general-ribbon-dot", () => this.host.settings.ribbonDot, (v) => (this.host.settings.ribbonDot = v), () => this.host.updateStatusIndicators());
    if (Platform.isMobile) {
      toggleRow("general-mobile-status-bar", () => this.host.settings.mobileStatusBar, (v) => (this.host.settings.mobileStatusBar = v), () => this.host.applyMobileStatusBar());
    }
  }
```

Wire it into the General tab render order so the block sits directly above Ribbon buttons — change:

```ts
        this.renderStatusToggles(containerEl);
        this.renderPassphrase(containerEl);
        this.renderRibbonToggles(containerEl);
```

to:

```ts
        this.renderStatusToggles(containerEl);
        this.renderPassphrase(containerEl);
        this.renderStatusBarToggles(containerEl);
        this.renderRibbonToggles(containerEl);
```

- [ ] **Step 4: Gates**

Run: `npm test && npm run build && npm run lint`
Expected: all green, lint at baseline (watch sentence-case: the four names above are sentence case; "Sync Center" / "Config Sync" / "Obsidian" are existing brands).

- [ ] **Step 5: Dev-vault smoke (controller may run this instead of the implementer)**

```bash
npm run build
cd dev/vault && obsidian-cli command id=app:reload
cd dev/vault && obsidian-cli eval 'app.setting.open(); app.setting.openTabById("config-sync"); const names = [...document.querySelectorAll(".vertical-tab-content .setting-item-name")].map(e => e.textContent); JSON.stringify(names.filter(n => /status bar|Ribbon icon|Status bar/i.test(n ?? "")))'
```

Expected: `["Status bar", "Show status bar item", "Show remote push/pull in status bar", "Ribbon icon status dot"]` — no "Show status bar on mobile" on desktop. Flip "Show status bar item" off via the DOM toggle and confirm the status-bar item hides without a reload; flip back on.

### Task 4: Docs (docs-currency gate)

**Files:**
- Modify: `README.md`, `README.zh.md` (keep 1:1), `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md`

Read each file first and place the additions in the section where sibling features already live (features list / status-flow prose / component library). Content to add:

- [ ] **Step 1: README.md — feature bullet**

Add to the features list, matching the sibling bullets' voice:

```markdown
- **Status bar**: sync status at a glance — ↑ to capture, ↓ to apply, plus per-remote ⇡ push / ⇣ pull counts; click opens the Sync Center. All in sync shows just a dimmed icon. The old ribbon-icon dot is now opt-in (off by default), and a mobile-only toggle can force Obsidian's hidden status bar visible on phones.
```

If the README documents the ribbon dot anywhere, update that sentence to say the dot is opt-in and the status bar is the primary indicator.

- [ ] **Step 2: README.zh.md — 1:1 mirror**

```markdown
- **状态栏**:同步状态一目了然——↑ 待捕获、↓ 待应用,以及每个 remote 的 ⇡ push / ⇣ pull 计数;点击直接打开 Sync Center。全部同步时只显示置灰图标。原 ribbon 图标圆点改为可选(默认关闭);另有仅手机端的开关,可强制显示被 Obsidian 隐藏的状态栏。
```

Mirror any ribbon-dot sentence updates from Step 1. Verify section-by-section 1:1 with the EN file.

- [ ] **Step 3: docs/ARCHITECTURE.md**

Where the status flow is described (the `updateRibbonDot` / awareness-runtime prose), update to:

- `updateRibbonDot()` is now `updateStatusIndicators()` and drives two surfaces: the opt-in ribbon dot (unchanged classes, gated by `settings.ribbonDot`) and the status-bar item (`src/ui/statusBar.ts`).
- Add `ui/statusBar.ts` to the module list: "pure segment model (`statusBarSegments`, `statusBarAriaLabel`) + thin DOM renderer for the status-bar item; segments mirror the Sync Center header pills (↑/↓ from presented bucket counts, ⇡/⇣ from `remoteDirectionCounts`)".
- Note the split: the dot folds remote-newer into its apply state (legacy behavior); the status bar shows remote-newer as ⇣ pull, matching the panel.

- [ ] **Step 4: docs/design/DESIGN.md**

Add a component-library entry for the status-bar item: plain colored text segments (no pill backgrounds — mockup candidate A), colors identical to the header pills (`is-up` orange, `is-down` accent, `is-push` pink, `is-pull` cyan), clean state = dimmed `refresh-cw` icon only (`--text-faint`), `mod-clickable`, aria-label lists non-zero parts (`Config Sync — 2 to capture · 1 to apply · push 1`).

- [ ] **Step 5: Cross-check**

Verify every claim added here against the Task 1-3 code (glyphs, defaults, toggle names, click target). Run `npm run lint` once more if any code comments changed (docs-only edits don't need gates).

---

## Verification (whole feature)

1. All gates green: `npm test`, `npm run build`, `npm run lint` at baseline.
2. Dev-vault smoke from Tasks 2-3 passed (item DOM, click-to-open, toggle effects, no dot by default).
3. Mobile numeric check (controller): in mobile emulation with the toggle forced on, `getComputedStyle(document.querySelector(".status-bar")).display === "flex"` and `marginBottom` equals the resolved `--mobile-toolbar-height`. Visual verification is explicitly out of scope for the dev vault (renders at desktop size); final look is the user's phone.
4. EN/zh READMEs 1:1; ARCHITECTURE and DESIGN updated in the same working tree.
5. Everything uncommitted; release note reminder for the cut: **ribbon dot is now off by default** — "Ribbon icon status dot" restores it.
