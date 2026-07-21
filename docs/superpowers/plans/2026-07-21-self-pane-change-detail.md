# Self-Pane Change Detail + Config Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Config Sync self pane, replace the heavy "This device's configuration" block with a title-row ⚙ Settings button, and let a sync-list *membership* change reveal the exact `data.json` diff (not just item names).

**Architecture:** Both changes are view-local edits to `SyncCenterView.renderConfigSyncMode` and its helpers, reusing the existing `diffPair` + `renderDiffPanel` machinery. No host-interface change; verification is live.

**Tech Stack:** TypeScript, Obsidian API (`setIcon`), plain CSS (theme vars).

## Global Constraints

- Gates before "done": `npx tsc -noEmit -skipLibCheck` clean · `npm test` green · `npx eslint .` **0 errors / 67 warnings** · `./scripts/check-no-hardcoded-color.sh` OK · `npm run build` clean.
- CSS: theme vars only — `var(--…)` / `rgba(var(--…-rgb), α)`; no hex/rgb literals.
- Icons: Lucide via `setIcon` — no emoji (DESIGN.md §148).
- No host-interface additions; entirely view-local to `SyncCenterView.ts` + CSS.
- `setIcon`, `Direction`, `renderDiffPanel`, `SELF_GROUP_NAME`, `diffPair` (host) are already imported/available.
- "This device's configuration" stays a **jump to the settings panel**, not an in-pane data readout.
- Line numbers below are pre-edit references; anchor on method names — Task 1's deletions shift later lines, so re-read before Task 2.
- Commit messages: conventional, **no Claude/AI attribution**.

---

### Task 1: Title-row ⚙ Settings button; remove the config block

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `renderConfigSyncMode` title row (`:517-521`); add `openConfigSyncSettings` method; delete `renderSelfConfigSummary` (`:501-510`) and its two call sites (`:558`, `:594`).
- Modify: `styles.css` — add `.config-sync-self-title-sp` + `.config-sync-self-settings-btn`; remove the now-unused `.config-sync-self-link` (`:734`).

**Interfaces:**
- Consumes: `this.app.setting` (via the `unknown`-narrowed cast already used in `renderSelfConfigSummary`), `setIcon`.
- Produces: `private openConfigSyncSettings(): void` — opens the Config Sync settings tab (used by the title-row button).

- [ ] **Step 1: Add the `openConfigSyncSettings` method**

In `src/ui/SyncCenterView.ts`, add this method immediately above `renderConfigSyncMode` (just before `:512`):

```ts
private openConfigSyncSettings(): void {
  const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById("config-sync");
}
```

- [ ] **Step 2: Add the Settings button to the title row**

In `renderConfigSyncMode`, after the pill line (`:521`, `if (pill !== null) title.createSpan(...)`), append:

```ts
    title.createSpan({ cls: "config-sync-self-title-sp" });
    const cfgBtn = title.createEl("button", { cls: "config-sync-self-settings-btn", attr: { "aria-label": "Open Config Sync settings" } });
    const cfgIc = cfgBtn.createSpan({ cls: "config-sync-self-settings-ic" });
    setIcon(cfgIc, "settings-2");
    cfgBtn.createSpan({ text: "Settings" });
    cfgBtn.addEventListener("click", () => this.openConfigSyncSettings());
```

- [ ] **Step 3: Delete `renderSelfConfigSummary` and its calls**

Delete the entire `renderSelfConfigSummary` method (`:501-510`). Then delete its two invocations:
- in the `insync` branch — `this.renderSelfConfigSummary(pane);` (`:558`).
- at the end of the changed-state path — `this.renderSelfConfigSummary(pane);` (`:594`).

- [ ] **Step 4: Add / remove CSS**

In `styles.css`, delete the `.config-sync-self-link` rule (`:734`). Near the other `.config-sync-self-*` rules (e.g. after `.config-sync-self-pill.is-ok`, `:717`), add:

```css
.config-sync-self-title-sp { flex: 1; }
.config-sync-self-settings-btn { display: inline-flex; align-items: center; gap: 4px; font-size: var(--font-ui-smaller); color: var(--text-muted); background: var(--background-modifier-hover); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 2px 9px; cursor: pointer; box-shadow: none; height: auto; }
.config-sync-self-settings-btn:hover { color: var(--interactive-accent); border-color: rgba(var(--interactive-accent-rgb), 0.5); }
.config-sync-self-settings-btn .config-sync-self-settings-ic { display: inline-flex; }
.config-sync-self-settings-btn .config-sync-self-settings-ic svg { width: 13px; height: 13px; }
```

(Confirm `.config-sync-self-title` is a flex row so the spacer works; it renders the icon + name + pill inline. If it is not `display: flex`, add `display: flex; align-items: center;` to its rule.)

- [ ] **Step 5: Run the gates**

```bash
cd ~/local/coding/open/obsidian-config-sync
npx tsc -noEmit -skipLibCheck            # clean
npm test                                  # green
npx eslint .                              # 0 errors / 67 warnings
./scripts/check-no-hardcoded-color.sh     # OK
npm run build                             # exit 0
```

- [ ] **Step 6: Live-verify**

Sync Center → click the "Config Sync" sidebar entry (the self pane):
- The title row shows the state icon + "Config Sync" + state pill, and a right-aligned "⚙ Settings" button.
- Clicking "Settings" opens the Config Sync settings tab.
- The old bottom "This device's configuration" block is gone.
- The button is present in every self state — check at least the current state and the in-sync state (no stray empty block below).

- [ ] **Step 7: Commit**

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(ui): self pane — title-row Settings button, drop config block"
```

---

### Task 2: Membership-change clarifier + collapsible data.json diff

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — add `selfDiffOpen` field (near `:176`); factor `renderSelfDataJsonDiff` out of `renderSelfContentDetail` (`:599-628`); add `renderSelfViewChange`; wire both membership branches (adopt `:571`, capture `:582`).
- Modify: `styles.css` — add `.config-sync-self-viewchange`.

**Interfaces:**
- Consumes: `this.host.diffPair(SELF_GROUP_NAME, "", dir)` → `{ base: string; produced: string } | null`; `renderDiffPanel`; `this.renderSelfDelta`; `Direction`.
- Produces: `private renderSelfDataJsonDiff(holder: HTMLElement, dir: Direction): void`; `private renderSelfViewChange(block: HTMLElement, dir: Direction): void`; `private selfDiffOpen: Set<Direction>`.

- [ ] **Step 1: Add the expansion-state field**

In `src/ui/SyncCenterView.ts`, after `private selfInfo: SelfSyncInfo | null = null;` (`:176`), add:

```ts
  private selfDiffOpen = new Set<Direction>(); // which self data.json diffs are expanded
```

- [ ] **Step 2: Factor out `renderSelfDataJsonDiff`; rewrite `renderSelfContentDetail`'s tail**

In `renderSelfContentDetail`, replace the diff body (`:618-628`):

```ts
    block.createDiv({ cls: "config-sync-self-block-s", text: "Config Sync's own settings changed:" });
    const holder = block.createDiv({ cls: "config-sync-inline-diff" });
    void this.host.diffPair(SELF_GROUP_NAME, "", dir).then((pair) => {
      if (pair === null) {
        holder.createDiv({ cls: "config-sync-expand-note", text: "no diff available" });
        return;
      }
      const leftLabel = dir === "capture" ? "store" : "this device";
      const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
      renderDiffPanel(holder, pair.base, pair.produced, leftLabel, rightLabel, "data.json");
    });
  }
```

with (the loop body now ends after the helper call, and the extracted method follows):

```ts
    block.createDiv({ cls: "config-sync-self-block-s", text: "Config Sync's own settings changed:" });
    this.renderSelfDataJsonDiff(block.createDiv({ cls: "config-sync-inline-diff" }), dir);
  }

  private renderSelfDataJsonDiff(holder: HTMLElement, dir: Direction): void {
    void this.host.diffPair(SELF_GROUP_NAME, "", dir).then((pair) => {
      if (pair === null) {
        holder.createDiv({ cls: "config-sync-expand-note", text: "no diff available" });
        return;
      }
      const leftLabel = dir === "capture" ? "store" : "this device";
      const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
      renderDiffPanel(holder, pair.base, pair.produced, leftLabel, rightLabel, "data.json");
    });
  }

  private renderSelfViewChange(block: HTMLElement, dir: Direction): void {
    const open = this.selfDiffOpen.has(dir);
    const link = block.createDiv({ cls: "config-sync-self-viewchange", text: open ? "▾ hide change (data.json)" : "▸ view change (data.json)" });
    link.addEventListener("click", () => {
      if (open) this.selfDiffOpen.delete(dir);
      else this.selfDiffOpen.add(dir);
      this.render(this.renderGen);
    });
    if (open) this.renderSelfDataJsonDiff(block.createDiv({ cls: "config-sync-inline-diff" }), dir);
  }
```

- [ ] **Step 3: Wire the adopt block**

In the adopt/both branch, replace (`:571-572`):

```ts
      if (info.delta.added.length > 0 || info.delta.removed.length > 0) this.renderSelfDelta(block, info.delta.added, info.delta.removed);
      else this.renderSelfContentDetail(block, info, "apply"); // store's config-sync settings changed, not the list
```

with:

```ts
      if (info.delta.added.length > 0 || info.delta.removed.length > 0) {
        this.renderSelfDelta(block, info.delta.added, info.delta.removed);
        this.renderSelfViewChange(block, "apply");
      } else {
        this.renderSelfContentDetail(block, info, "apply"); // store's config-sync settings changed, not the list
      }
```

- [ ] **Step 4: Wire the capture block**

In the capture/both branch, replace (`:582-583`):

```ts
      if (info.delta.removed.length > 0) this.renderSelfDelta(block, info.delta.removed, []); // your local-only groups
      else this.renderSelfContentDetail(block, info, "capture"); // config-sync's own settings/version changed, not the list
```

with:

```ts
      if (info.delta.removed.length > 0) {
        this.renderSelfDelta(block, info.delta.removed, []); // your local-only groups
        block.createDiv({ cls: "config-sync-self-block-s", text: "These are in this device's sync list but not the store's — Capture publishes their definitions." });
        this.renderSelfViewChange(block, "capture");
      } else {
        this.renderSelfContentDetail(block, info, "capture"); // config-sync's own settings/version changed, not the list
      }
```

- [ ] **Step 5: Add CSS**

In `styles.css`, near the other `.config-sync-self-*` rules, add:

```css
.config-sync-self-viewchange { color: var(--interactive-accent); font-size: var(--font-ui-smaller); cursor: pointer; margin-top: var(--size-4-1); }
```

- [ ] **Step 6: Run the gates**

```bash
cd ~/local/coding/open/obsidian-config-sync
npx tsc -noEmit -skipLibCheck            # clean
npm test                                  # green
npx eslint .                              # 0 errors / 67 warnings
./scripts/check-no-hardcoded-color.sh     # OK
npm run build                             # exit 0
```

- [ ] **Step 7: Live-verify**

Sync Center → the "Config Sync" self pane, in the capture state (the dev vault has `+ Enabled CSS snippets` — this device tracks `enabled-css-snippets`, the store doesn't):
- The "Local changes not yet in the store" block shows `+ Enabled CSS snippets`, then the clarifier line "These are in this device's sync list but not the store's — Capture publishes their definitions.", then `▸ view change (data.json)`.
- Click `▸ view change` → a `data.json` diff appears (left = store, right = this device / what capture writes) whose added `groups[]` entry is the snippet group; the toggle reads `▾ hide change`. Click again → it collapses.
- Capture still works from this block.
- If you can force an adopt-side list change, confirm `▸ view change` also appears under the adopted items (apply-direction diff). (Optional — the capture case is the required check.)

- [ ] **Step 8: Commit**

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(ui): self pane — reveal data.json diff for sync-list membership changes"
```

---

## Self-Review

- **Spec coverage:** Issue 2 title-row button + block removal + settings-open reuse (Task 1) ✅; Issue 1 clarifier + collapsible diff reusing diffPair/renderDiffPanel (Task 2) ✅; membership branches wired for both adopt and capture (Task 2 §3/§4) ✅; content-change path behavior preserved (Task 2 §2) ✅; jump-not-readout non-goal respected ✅.
- **Placeholders:** none — full before/after code in each step.
- **Type consistency:** `selfDiffOpen: Set<Direction>`; `renderSelfDataJsonDiff(holder, dir)` and `renderSelfViewChange(block, dir)` signatures used consistently; `renderSelfDelta(block, added, removed)` matches its definition (`:489`); `diffPair` returns `{base, produced}` as consumed.
- **Note:** Task 1 and Task 2 both edit `renderConfigSyncMode` / `styles.css` but in disjoint regions; Task 1's method/line deletions shift Task 2's reference lines, so Task 2's implementer must re-read the file (flagged in Global Constraints).
