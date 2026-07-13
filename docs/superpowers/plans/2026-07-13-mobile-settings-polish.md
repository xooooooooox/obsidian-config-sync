# Mobile Settings Polish & Capture Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone settings rows stack instead of shattering, `author` stops tripping the sensitive-key detector, capture/apply show live `n/N` progress on the footer buttons, and mode/fields edits update their row in place without a full-tab flash.

**Architecture:** Core: scanner precision (`auth(?!or)`) and an optional `onProgress` callback threaded through `capture`/`apply`. UI: `SyncCenterView` progress button states (host signature gains the callback); `SettingTab` per-row in-place re-render + `body.is-phone` stacked CSS.

**Tech Stack:** TypeScript, CSS, vitest, obsidian-cli (`emulateMobile`).

**Specs/mockups:** `docs/superpowers/specs/2026-07-13-mobile-settings-polish-design.md`; `.superpowers/brainstorm/39264-1783912450/content/iter22-mobile-settings.html` + `iter22-progress.html`.

## Global Constraints

- Gate per task: `npm test && npm run build && npm run lint` — 0 lint errors (68-warning baseline acceptable).
- Copy verbatim: `Capturing {done}/{total}…` / `Applying {done}/{total}…` (ellipsis character `…`).
- Detection: `auth` matches via `auth(?!or)` case-insensitive; all other patterns unchanged (substring).
- Progress callback signature exactly: `(done: number, total: number, current: string) => void`, invoked BEFORE each group is processed; no behavior change when omitted.
- Phone layout under `body.is-phone` only; desktop/tablet unchanged.
- Mode-segment + fields-editor edits re-render ONLY the affected item row; enable/disable toggle, device-class change, type change keep the full refresh.
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Core — scanner precision + progress callbacks

**Files:**
- Modify: `src/core/modes.ts` (~line 29), `src/core/ConfigSyncCore.ts` (`capture` ~line 124, `apply` ~line 265)
- Test: `tests/modes.test.ts`, `tests/core.test.ts`

**Interfaces:**
- Produces: `export type ProgressFn = (done: number, total: number, current: string) => void` (in `ConfigSyncCore.ts`); `capture(ctx, names?, onProgress?)`; `apply(ctx, groupNames, onProgress?)`. Task 2 threads these through the host.

- [ ] **Step 1: Failing tests**

`tests/modes.test.ts` — append to the `scanSensitive` describe:

```ts
  it("auth does not match author*, still matches real auth keys", () => {
    const s = scanSensitive(JSON.stringify({ author: "x", authorUrl: "y", authors: ["a"], oauth: "t", authToken: "z", auth_key: "k" }));
    expect(s.keys.sort()).toEqual(["authToken", "auth_key", "oauth"]);
  });
```

`tests/core.test.ts` — append (reuse `seededAndCaptured`/`setup` fixtures):

```ts
describe("progress callbacks", () => {
  it("capture reports done/total/current before each selected group", async () => {
    const { ctx } = await seededAndCaptured();
    const calls: Array<[number, number, string]> = [];
    await capture(ctx, ["hotkeys", "snippets"], (d, t, c) => calls.push([d, t, c]));
    expect(calls).toEqual([
      [0, 2, "hotkeys"],
      [1, 2, "snippets"],
    ]);
  });

  it("apply reports the same shape", async () => {
    const { ctx } = await seededAndCaptured();
    const calls: Array<[number, number, string]> = [];
    await apply(ctx, ["hotkeys"], (d, t, c) => calls.push([d, t, c]));
    expect(calls).toEqual([[0, 1, "hotkeys"]]);
  });
});
```

(Import `capture`/`apply` if not already; the fixture's manifest order is hotkeys, snippets, plugin-demo — selected groups preserve manifest order.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/modes.test.ts tests/core.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement**

`src/core/modes.ts` — replace the matching line (~29):

```ts
      const lower = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => (p === "auth" ? /auth(?!or)/i.test(k) : lower.includes(p)))) found.add(k);
```

`src/core/ConfigSyncCore.ts`:

```ts
export type ProgressFn = (done: number, total: number, current: string) => void;
```

`capture(ctx: CoreContext, names?: string[], onProgress?: ProgressFn)`: compute the selected group list first (`const toProcess = manifest.groups.filter((g) => selected === null || selected.has(g.name));` — the existing loop already skips unselected groups with the carry-forward branch; keep that loop structure and add a `done` counter: before processing each SELECTED group, call `onProgress?.(done, toProcess.length, group.name); done++;`. The carry-forward branch for unselected groups is untouched.

`apply(ctx, groupNames, onProgress?)`: same pattern over its group loop (`onProgress?.(done, groupNames.length, group.name); done++;` before each processed group).

- [ ] **Step 4: Verify pass**, then full `npm test`.
- [ ] **Step 5: Gate + commit**

```bash
git add src/core/modes.ts src/core/ConfigSyncCore.ts tests/modes.test.ts tests/core.test.ts
git commit -m "feat: auth detection precision and capture/apply progress callbacks"
```

---

### Task 2: UI — progress buttons, in-place row updates, phone stacking

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (host interface + `renderActionBar` ~line 598), `src/main.ts` (host implementation), `src/ui/SettingTab.ts` (item row builder ~lines 255-380), `styles.css`

**Interfaces:**
- Consumes: Task 1's `ProgressFn`, `capture(ctx, names?, onProgress?)`, `apply(ctx, names, onProgress?)`.
- Produces: `SyncCenterHost.captureItems(names: string[], onProgress?: ProgressFn): Promise<void>` and `applyItems(names: string[], onProgress?: ProgressFn): Promise<void>` (widened signatures; existing callers unaffected).

- [ ] **Step 1: Host plumbing** — in `SyncCenterView.ts`, widen the two host-interface signatures as above (import `ProgressFn` type from `../core/ConfigSyncCore`). In `main.ts`'s `syncCenterHost()`, thread the parameter through: `captureItems: async (names, onProgress) => { ... await capture(ctx, names, onProgress); ... }` and likewise `applyItems` → `apply(ctx, names, onProgress)`. Nothing else in those handlers changes.

- [ ] **Step 2: Progress button states** — rewrite `renderActionBar`'s click handlers (per mockup `iter22-progress.html`):

```ts
  private renderActionBar(macro: HTMLElement): void {
    const bar = macro.createDiv({ cls: "config-sync-actionbar" });
    bar.createSpan({ cls: "config-sync-staged-count", text: `${this.selected.size} staged` });
    bar.createDiv({ cls: "config-sync-rule-spacer" });
    const capNames = this.captureNames();
    const applyNames = this.applyNames();

    const run = (
      btn: ButtonComponent,
      other: ButtonComponent,
      verb: "Capturing" | "Applying",
      names: string[],
      exec: (names: string[], onProgress: ProgressFn) => Promise<void>
    ): void => {
      btn.setDisabled(true);
      other.setDisabled(true);
      const wrap = btn.buttonEl.parentElement; // the .config-sync-btnwrap span
      const barEl = wrap?.querySelector(".config-sync-progress") as HTMLElement | null;
      const fill = barEl?.querySelector("div") ?? null;
      if (barEl !== null) barEl.show();
      btn.buttonEl.addClass("is-busy");
      void (async () => {
        await exec(names, (done, total, current) => {
          btn.setButtonText(`${verb} ${done}/${total}…`);
          btn.buttonEl.setAttribute("aria-label", current);
          if (fill !== null) (fill as HTMLElement).style.width = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
        });
        await this.reload(); // re-render restores the idle footer
      })();
    };

    const mkWrapped = (): { wrap: HTMLElement; btn: ButtonComponent } => {
      const wrap = bar.createSpan({ cls: "config-sync-btnwrap" });
      const btn = new ButtonComponent(wrap);
      const prog = wrap.createDiv({ cls: "config-sync-progress" });
      prog.createDiv();
      prog.hide();
      return { wrap, btn };
    };

    const capW = mkWrapped();
    capW.btn.setButtonText(`↑ Capture ${capNames.length} item${capNames.length === 1 ? "" : "s"}`);
    capW.btn.buttonEl.addClass("config-sync-btn-capture");
    capW.btn.setDisabled(capNames.length === 0);

    const applyW = mkWrapped();
    applyW.btn.setCta();
    applyW.btn.setButtonText(`↓ Apply ${applyNames.length} item${applyNames.length === 1 ? "" : "s"}`);
    applyW.btn.setDisabled(applyNames.length === 0);

    capW.btn.onClick(() => run(capW.btn, applyW.btn, "Capturing", this.captureNames(), (n, p) => this.host.captureItems(n, p)));
    applyW.btn.onClick(() => run(applyW.btn, capW.btn, "Applying", this.applyNames(), (n, p) => this.host.applyItems(n, p)));
  }
```

(Adapt naming to taste but keep classes `config-sync-btnwrap`, `config-sync-progress`, `is-busy`, and the verbatim labels; the old click handlers are fully replaced. The spinner is CSS on `.is-busy::before`.)

- [ ] **Step 3: Progress CSS**

```css
.config-sync-btnwrap { display: inline-flex; flex-direction: column; }

.config-sync-progress { height: 2px; margin-top: 3px; background: rgba(var(--color-orange-rgb), 0.25); border-radius: 1px; overflow: hidden; }

.config-sync-progress > div { height: 100%; width: 0; background: var(--color-orange); }

.config-sync-btnwrap:has(button.mod-cta) .config-sync-progress { background: rgba(var(--color-purple-rgb), 0.25); }

.config-sync-btnwrap:has(button.mod-cta) .config-sync-progress > div { background: var(--color-purple); }

button.is-busy::before { content: ""; width: 11px; height: 11px; margin-right: 6px; border: 2px solid rgba(255, 255, 255, 0.3); border-top-color: currentColor; border-radius: 50%; display: inline-block; animation: config-sync-spin 0.9s linear infinite; }

@keyframes config-sync-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: In-place row updates (SettingTab)** — the item builder (~line 255) creates a `wrap` div per item containing the `Setting` row (line 260), mode segment (284), and fields editor (308). Refactor so the whole per-item build lives in one method `private renderItemInto(wrap: HTMLElement, item: CatalogItem, group: SyncGroup | undefined, ...)` (match the actual local signature) that first `wrap.empty()`s. The mode-segment click handlers and every fields-editor mutation (add/remove/action toggle/prefill) then call `saveGroups()` followed by `this.renderItemInto(wrap, ...)` for THAT wrap only — no `this.refresh()`. The enable/disable toggle, device dropdown, and everything outside the item wrap keep calling `refresh()` as today.

- [ ] **Step 5: Phone stacked rows CSS** — per mockup `iter22-mobile-settings.html`, under `body.is-phone` scope (adjust selectors to the real DOM after Step 4; the item wrap has a stable class — add `config-sync-item-wrap` to it if it lacks one):

```css
body.is-phone .config-sync-item-wrap .setting-item { flex-direction: column; align-items: stretch; }

body.is-phone .config-sync-item-wrap .setting-item-info { width: 100%; }

body.is-phone .config-sync-item-wrap .setting-item-control { width: 100%; justify-content: flex-start; flex-wrap: wrap; gap: 9px; margin-top: 10px; }

body.is-phone .config-sync-item-wrap .setting-item-control .checkbox-container { margin-left: auto; }

body.is-phone .config-sync-detect-badge { white-space: nowrap; }

body.is-phone .config-sync-field-pattern { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

(Verify the real class names — `setting-item-info`/`setting-item-control` are Obsidian's; the badge/field-pattern class names come from the existing SettingTab code; adapt if they differ, keeping the stacking semantics from the mockup.)

- [ ] **Step 6: Gate + commit**

```bash
git add src/ui/SyncCenterView.ts src/main.ts src/ui/SettingTab.ts styles.css
git commit -m "feat: capture/apply progress buttons, in-place settings rows, phone stacking"
```

---

### Task 3: Live smoke (controller) + release

1. Guard (standalone); `npm run smoke:install`; reload.
2. Desktop: stage several items (create a few local snippet files to get 5+ capture-side items) → click Capture → observe `Capturing n/N…` ticking + progress bar + both buttons disabled + aria-label showing current group → report modal → footer restored. Repeat once for Apply direction (single item is fine).
3. Settings: click a mode segment on an enabled item → NO full-tab flash (only the row rebuilds; verify by marking a DOM node above it and checking identity preserved). Fields editor add/remove — same.
4. Detection: an item whose file contains `author`/`authorUrl` only → no badge; `authToken` → badge.
5. `emulateMobile(true)` + narrow (phone): settings item rows stacked per mockup (info full-width, controls row below, badge single pill, nothing clipped); exit emulation.
6. Cleanup staging; `dev:errors` clean; ledger.
7. Final whole-branch review (opus) → fix wave if needed → merge --no-ff → cut **0.18.0** (pre-authorized) → CI draft → release notes.
