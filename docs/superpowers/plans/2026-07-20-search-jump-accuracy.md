# Settings search jump accuracy + visible highlight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a settings-search result reliably scrolls the target row to center and flashes a prominent highlight, instead of silently failing to scroll or applying a highlight the user can't see.

**Architecture:** The bug is an async re-sort clobbering the scroll — `jumpTo` opts the tab into the sensitive-first re-sort (`sortedSections.delete`), whose `settleSensitiveOrder → refresh()` fires a *second* render when an async `detectSensitive` resolves *after* the scroll, resetting `scrollTop` and detaching the target (or the target is transiently absent → silent `null` bail). Fix: `jumpTo` **suppresses** that re-sort for the jump (`sortedSections.add`), so `rerender(0)` completes without a competing second render, the anchor is present, and the scroll sticks; the highlight CSS becomes a one-shot accent flash + lingering left-bar (定稿 option B). (An earlier settle-wait-via-rAF fix was tried and failed live verification — the gen-stable frame precedes the async re-sort — and was removed.)

**Tech Stack:** TypeScript, Obsidian API, CSS. One file of code (`src/ui/SettingTab.ts`) + one CSS rule (`styles.css`).

## Global Constraints

- Colors: theme vars only; the highlight uses `--interactive-accent` / `--interactive-accent-rgb` — no hex/rgb literals, no new color.
- The race is not unit-testable (rAF + Obsidian DOM + async re-render); correctness is verified live on the dev vault (Task 2). The existing test suite must stay green.
- Gates: `npx tsc -noEmit -skipLibCheck` clean, `npm test` green, `npx eslint .` **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.
- No Claude/AI attribution in any commit message.

---

### Task 1: Settle-aware jump + prominent highlight

**Files:**
- Modify: `src/ui/SettingTab.ts` — change the `jumpTo` method (currently the `private jumpTo(hit: SearchHit): void { ... }` block).
- Modify: `styles.css` — replace the `.config-sync-search-highlight` rule (currently near line 103).

**Interfaces:**
- Consumes: existing instance fields `this.containerEl`, `this.rerender`, `this.scopeTab`, `this.sortedSections`, `this.expanded`, `this.search`, `this.searchScope`; the `SearchHit` type.
- Produces: no new exports.

- [ ] **Step 1: Change `jumpTo` to suppress the re-sort on a jump.** Replace the entire existing `jumpTo` method:

```ts
  private jumpTo(hit: SearchHit): void {
    void (async () => {
      this.search = "";
      this.searchScope = "all";
      this.activeTab = this.scopeTab(hit.scope);
      this.sortedSections.delete(this.activeTab);
      if (hit.kind === "item" && hit.item !== undefined) this.expanded.add(hit.item.name);
      await this.rerender(0);
      const target = this.containerEl.querySelector(`[data-search-anchor="${CSS.escape(hit.anchorId)}"]`);
      if (target === null) return;
      target.scrollIntoView({ block: "center" });
      target.addClass("config-sync-search-highlight");
      window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1500);
    })();
  }
```

with:

```ts
  private jumpTo(hit: SearchHit): void {
    void (async () => {
      this.search = "";
      this.searchScope = "all";
      this.activeTab = this.scopeTab(hit.scope);
      // Suppress the sensitive-first re-sort for this jump: its async settleSensitiveOrder →
      // refresh() would fire a second render AFTER we scroll, resetting scrollTop and detaching
      // the target row. Guarded by sortedSections.has(activeTab), so adding it makes the re-sort
      // a no-op; the tab settles on the next normal render.
      this.sortedSections.add(this.activeTab);
      if (hit.kind === "item" && hit.item !== undefined) this.expanded.add(hit.item.name);
      await this.rerender(0);
      const target = this.containerEl.querySelector(`[data-search-anchor="${CSS.escape(hit.anchorId)}"]`);
      if (target === null) return;
      target.scrollIntoView({ block: "center" });
      target.addClass("config-sync-search-highlight");
      window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1800);
    })();
  }
```

(Changes vs current: `this.sortedSections.delete(this.activeTab)` → `this.sortedSections.add(this.activeTab)` with the new comment, and the highlight timeout `1500` → `1800`.)

> **NOTE (revision):** an earlier commit on this branch added a `waitForSettledAnchor` helper and
> called it from `jumpTo`. That approach failed live verification (see spec). If that helper is
> present, **delete the entire `waitForSettledAnchor` method** and restore `jumpTo`'s direct
> `this.containerEl.querySelector(...)` as shown above. The end state has **no** settle-wait helper.

- [ ] **Step 2: Replace the highlight CSS.** In `styles.css`, replace the existing rule:

```css
.config-sync-search-highlight {
  background: rgba(var(--interactive-accent-rgb), 0.12);
  transition: background 0.4s;
}
```

with:

```css
.config-sync-search-highlight {
  animation: config-sync-jump-flash 1.8s ease-in-out;
}
@keyframes config-sync-jump-flash {
  0%   { background: rgba(var(--interactive-accent-rgb), 0.30); box-shadow: inset 3px 0 0 var(--interactive-accent); }
  60%  { background: rgba(var(--interactive-accent-rgb), 0.10); box-shadow: inset 3px 0 0 var(--interactive-accent); }
  100% { background: transparent; box-shadow: inset 3px 0 0 rgba(var(--interactive-accent-rgb), 0); }
}
```

- [ ] **Step 3: Gates.** Run: `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npm test && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build` — Expected: tsc clean, all tests green (unchanged suite), eslint 0 errors / 67 warnings, color check OK, build clean.

- [ ] **Step 4: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/SettingTab.ts styles.css && git commit -m "fix: settings-search jump suppresses re-sort so the scroll sticks; stronger highlight"
```

---

### Task 2: Live verification (dev vault)

**Files:** none (verification only).

The race is not unit-testable; reproduce with the same instrumentation that diagnosed it. The dev vault is at `dev/vault/`; drive it with `obsidian-cli` (routes by CWD, so run from `dev/vault/`). `obsidian-cli` binary: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`; `eval` needs `code=<js>` and top-level `await` must be wrapped in `(async()=>{ ... })()`.

- [ ] **Step 1: Deploy + reload.** `cd ~/local/coding/open/obsidian-config-sync && npm run build && cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`, then reload the plugin: from `dev/vault/`, `obsidian-cli eval code="(async()=>{await app.plugins.disablePlugin('config-sync');await app.plugins.enablePlugin('config-sync');return 'reloaded';})()"`.

- [ ] **Step 2: Measure the jump lands visibly (cold path).** Focus Obsidian first (`open -a Obsidian`, else a backgrounded window throttles rendering). Open settings + the config-sync tab, **clear the detections cache** to force the cold path, then drive a `jumpTo` to a plugin item and check the target is present, on-screen, and highlighted. Via `obsidian-cli eval` (from `dev/vault/`):

```js
(async()=>{
  app.setting.open(); app.setting.openTabById('config-sync');
  await new Promise(r=>setTimeout(r,300));
  const tab=app.setting.activeTab, ce=tab.containerEl;
  tab.detections.clear();
  const hit=(await tab.buildSearchIndex(tab.renderGen)).find(h=>h.kind==='item'&&h.scope==='plugins'&&h.item);
  tab.jumpTo(hit);
  await new Promise(r=>setTimeout(r,600));
  const el=ce.querySelector('[data-search-anchor="'+CSS.escape(hit.anchorId)+'"]');
  if(!el) return JSON.stringify({bail:true});
  const cr=ce.getBoundingClientRect(), er=el.getBoundingClientRect();
  return JSON.stringify({hit:hit.name, headerTopFromViewTop:Math.round(er.top-cr.top), headerVisible: er.top>=cr.top-4 && er.top<cr.bottom, highlighted: el.classList.contains('config-sync-search-highlight')});
})()
```

Expected: `bail` absent, `headerVisible: true`, `highlighted: true` (pre-fix: the anchor was `null`/off-screen 809px below and un-highlighted).

- [ ] **Step 3: No-regression on a non-re-sorting tab.** Repeat for a General-tab hit (`h.scope==='general'`): assert `headerVisible: true` and `highlighted: true` — a tab with no sensitive re-sort still lands visible.

- [ ] **Step 4: Reset.** Close settings (`obsidian-cli eval code="(async()=>{app.setting.close();return 'closed';})()"`).

---

## Self-Review

**Spec coverage:**
- Root-cause fix (suppress the clobbering re-sort on a jump: `sortedSections.delete`→`add`) → Task 1 Step 1. ✓
- Highlight option B → Task 1 Step 2 (CSS). ✓
- `1500`→`1800` timeout alignment → Task 1 Step 1. ✓
- "not unit-testable, verify live (cold path)" → Task 2 (header visible + highlighted + General-tab no regression). ✓
- Non-goals (no change to search index/match/re-sort pipeline) → respected: only `jumpTo` (one field-op + comment + timeout) + one CSS rule change. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after with complete code; the eval scripts are complete. ✓

**Type consistency:** `jumpTo` uses `const target = this.containerEl.querySelector<...>(...)` and, after the `null` guard, `.scrollIntoView`/`.addClass`/`.removeClass` on the `HTMLElement`. No new helper is introduced (the earlier `waitForSettledAnchor` is removed per the revision note). CSS class `config-sync-search-highlight` and keyframe `config-sync-jump-flash` match between Steps 1 and 2. ✓
