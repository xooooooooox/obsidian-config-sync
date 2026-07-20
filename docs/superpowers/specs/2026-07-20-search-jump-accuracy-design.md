# Settings search: accurate jump-to-result + visible highlight

## Bug

In the settings panel's "Search all settings…" box, clicking a result switches to the
correct tab but **does not land on the target row**, and the highlight is so faint the
user must eye-scan to find it.

## Root cause (confirmed on the dev vault)

`jumpTo(hit)` (`src/ui/SettingTab.ts`) does:

```ts
this.activeTab = this.scopeTab(hit.scope);
this.sortedSections.delete(this.activeTab);
if (hit.kind === "item" && hit.item !== undefined) this.expanded.add(hit.item.name);
await this.rerender(0);
const target = this.containerEl.querySelector(`[data-search-anchor="${CSS.escape(hit.anchorId)}"]`);
if (target === null) return;
target.scrollIntoView({ block: "center" });
target.addClass("config-sync-search-highlight");
window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1500);
```

`jumpTo` calls `this.sortedSections.delete(this.activeTab)`, which **enables** the tab's
sensitive-first re-sort for this render. When an item's `detectSensitive` scan resolves
(asynchronously, on a cold panel), `renderDetection → settleSensitiveOrder → refresh()` fires a
**second render** that re-sorts the section. On a cold panel the scan resolves *after*
`await this.rerender(0)` has returned and `jumpTo` has already scrolled — so the second render:

1. queries against a mid-rebuild DOM where the anchor is transiently **`null`** →
   `if (target === null) return` silently bails: **no scroll, no highlight** at all; or
2. finishes with `containerEl.scrollTop = <captured 0>` and a re-ordered section, **clobbering**
   the scroll `scrollIntoView` performed — the target is detached/moved and ends up ~809px
   below center, past the 998px fold (invisible).

Verified on the dev vault: with detections warm (re-sort already settled before `jumpTo`) the
scroll lands correctly (offset 0); with detections **cold** (the real first-use case) the same
`jumpTo` leaves the target 809px off-center and un-highlighted. So the defect is the
**asynchronous re-sort clobbering the just-performed scroll**, not `scrollIntoView` itself. The
faint-highlight symptom is the same race (target off-screen, or highlight never applied),
compounded by the weak highlight style below.

> A first fix attempt (waiting for `renderGen` to be stable for one frame before scrolling) was
> implemented and **failed live verification**: the gen-stable frame occurs *before* the async
> `detectSensitive` fires the re-sort, so the wait resolves too early and the clobber still
> happens. It was removed in favor of the fix below.

## Fix

### 1. Suppress the sensitive-first re-sort on a jump

The clobbering second render is the sensitive-first re-sort, which `jumpTo` itself opts into via
`sortedSections.delete(...)`. `settleSensitiveOrder` is guarded by `sortedSections.has(activeTab)`,
so **adding** the active tab instead suppresses that re-sort for this jump: `rerender(0)` then
completes without a competing second render, the anchor is present immediately, and the scroll is
never reset. A jumped-to tab needn't re-sort on arrival — it settles on the next normal render,
and not reshuffling the list the instant you land on a searched item is better behavior anyway.

`jumpTo` becomes (only `delete`→`add`, the `1500`→`1800` timeout, and the comment change; no
settle-wait helper):

```ts
private jumpTo(hit: SearchHit): void {
  void (async () => {
    this.search = "";
    this.searchScope = "all";
    this.activeTab = this.scopeTab(hit.scope);
    // Suppress the sensitive-first re-sort for this jump: its async settleSensitiveOrder →
    // refresh() would fire a second render AFTER we scroll, resetting scrollTop and detaching
    // the target row. Guarded by sortedSections.has(activeTab), so adding it makes the re-sort a
    // no-op; the tab settles on the next normal render.
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

Verified live (dev vault, **cold** detections): the target is present after `rerender(0)`
(no bail), the scroll runs and sticks (no second render), the header is on-screen and carries
`config-sync-search-highlight` — for a near-top item (`offset ≈ 0`, scroll clamped) and a
far-down item (scrolls into view, header visible, highlighted; a last-row item clamps at the
scroll end but stays fully visible). The `1500`→`1800` timeout aligns with the highlight
animation duration.

### 2. Prominent highlight (定稿: option B)

Replace the faint tint with a one-shot flash that leaves a lingering accent left-bar, so the
target is caught at first glance and still findable a beat later. Theme accent only — no new
color:

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

The base class carries no static background, so after the animation (and the `removeClass`)
the row returns to normal.

## Testing

- This is a render-timing + CSS fix; the behavior is not unit-testable (Obsidian DOM +
  async re-render + `scrollIntoView`). Verify **live on the dev vault** with the same
  instrumentation that diagnosed it, with detections **cleared first** (`tab.detections.clear()`)
  to exercise the cold path:
  - Drive `jumpTo` to a plugin item (a tab that has a sensitive re-sort): after `rerender(0)`
    the anchor is present (no `null` bail), the row's header is on-screen
    (`getBoundingClientRect().top` within the scroll container), and it carries
    `config-sync-search-highlight`. A near-top item lands at offset ≈0; a far-down item scrolls
    into view and stays (a last-row item clamps at the scroll end but is fully visible) — never
    the pre-fix 809px-below-fold + un-highlighted state.
  - Confirm a General-tab hit (no re-sort) still lands visible/centered (no regression) and the
    highlight animation plays.
  - Note: drive the `obsidian-cli eval` with the Obsidian window focused (`open -a Obsidian`) —
    a backgrounded window throttles rendering and skews the measurement.
- Gates: `npm test` (unchanged suite green), `npx eslint .` 0 errors / 67 warnings,
  `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- No change to the search index, match logic, scope pills, or the qualifier-search feature
  (that is a separate spec).
- No change to the sensitive-first re-sort or the async detection pipeline — only `jumpTo`
  waits for them to settle before scrolling.
