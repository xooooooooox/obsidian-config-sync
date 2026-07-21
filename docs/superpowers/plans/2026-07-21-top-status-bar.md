# Sync Center Top Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Sync Center header a global at-a-glance status bar — Config Sync's own state (self chip) plus all four sync-action totals (capture/apply/push/pull) — identical on desktop and mobile.

**Architecture:** Add a pure `remoteDirectionCounts` helper to `core/status.ts` (TDD). Rework `SyncCenterView.renderHeader` (Layout B): a self chip reusing `selfStatePill`, a divider, then the existing item totals plus new push/pull remote-count pills. Entirely view-local — no host-interface change.

**Tech Stack:** TypeScript, Obsidian API (`setIcon`), vitest, plain CSS (theme vars).

## Global Constraints

- Gates before "done": `npx tsc -noEmit -skipLibCheck` clean · `npm test` green · `npx eslint .` **0 errors / 67 warnings** · `./scripts/check-no-hardcoded-color.sh` OK · `npm run build` clean.
- CSS: theme vars only — `var(--…)` / `rgba(var(--…-rgb), α)`; no hex/rgb literals.
- Icons: Lucide via `setIcon` — no emoji (DESIGN.md §148).
- No host-interface (`SyncCenterHost`) additions — feature is view-local.
- Push/pull count **remotes** (not items); shown only when count > 0. Remotes are desktop-only (`main.ts:558`) so these pills never appear on mobile — no platform branch needed.
- Item totals stay bucketed over `mainRows()` (already scope-independent).
- Commit messages: conventional, **no Claude/AI attribution**.

---

### Task 1: `remoteDirectionCounts` pure helper

**Files:**
- Modify: `src/core/status.ts` (add export beside `bucketCounts`, near `:151`)
- Test: `tests/status.test.ts` (create if absent)

**Interfaces:**
- Consumes: `RemoteState` (already exported from `src/core/status.ts:153` — `"no-store" | "same" | "remote-newer" | "remote-older" | "unknown"`).
- Produces: `export function remoteDirectionCounts(states: RemoteState[]): { push: number; pull: number }` — `push` counts `"remote-older"`, `pull` counts `"remote-newer"`; all other states count as neither.

- [ ] **Step 1: Write the failing tests**

Add to `tests/status.test.ts` (create the file with this content if it does not exist; otherwise append the `describe` block and add the import):

```ts
import { describe, it, expect } from "vitest";
import { remoteDirectionCounts } from "../src/core/status";

describe("remoteDirectionCounts", () => {
  it("counts remote-older as push", () => {
    expect(remoteDirectionCounts(["remote-older", "remote-older"])).toEqual({ push: 2, pull: 0 });
  });
  it("counts remote-newer as pull", () => {
    expect(remoteDirectionCounts(["remote-newer"])).toEqual({ push: 0, pull: 1 });
  });
  it("ignores same/no-store/unknown", () => {
    expect(remoteDirectionCounts(["same", "no-store", "unknown"])).toEqual({ push: 0, pull: 0 });
  });
  it("counts a mixed set", () => {
    expect(remoteDirectionCounts(["remote-older", "remote-newer", "same"])).toEqual({ push: 1, pull: 1 });
  });
  it("returns zeroes for an empty list", () => {
    expect(remoteDirectionCounts([])).toEqual({ push: 0, pull: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/status.test.ts`
Expected: FAIL — `remoteDirectionCounts` is not exported (import error / not a function).

- [ ] **Step 3: Implement the helper**

In `src/core/status.ts`, immediately after the `bucketCounts` function (ends at `:151`), add:

```ts
// Push/pull are per-remote whole-store states, not item counts: a remote is
// "older" (push would update it) or "newer" (pull would update the store).
// Counts how many remotes need each direction. same/no-store/unknown → neither.
export function remoteDirectionCounts(states: RemoteState[]): { push: number; pull: number } {
  let push = 0;
  let pull = 0;
  for (const s of states) {
    if (s === "remote-older") push++;
    else if (s === "remote-newer") pull++;
  }
  return { push, pull };
}
```

(`RemoteState` is already declared at `:153`; the function may reference it since it is a top-level type in the same module.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck`
Expected: no output (clean).

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/core/status.ts tests/status.test.ts
git commit -m "feat(core): remoteDirectionCounts — push/pull totals from remote states"
```

---

### Task 2: Header rework — self chip, divider, push/pull pills

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `renderHeader` (`:771-812`); add a `renderSelfChip` method; add the `remoteDirectionCounts` import to the `../core/status` import (`:3`).
- Modify: `styles.css` — add `.config-sync-self-chip`, `.config-sync-head-divider`, and `.config-sync-pill.is-push` / `.is-pull` (near the other `.config-sync-pill` rules, `:404-410`).

**Interfaces:**
- Consumes: `remoteDirectionCounts` (Task 1); `this.selfInfo` (`SelfSyncInfo | null`); `this.selfStatePill(info)` → `{ text: string; cls: string } | null` (`:454`); `this.host.remotes()` → `Remote[]` (`[]` on mobile); `this.host.remoteCheck(name)` → `{ check: RemoteCheck; at: number } | undefined`; `renderActionCount(parent, action, count)` (already imported); `setIcon` (already imported).
- Produces: nothing consumed downstream (view-internal).

- [ ] **Step 1: Add the `remoteDirectionCounts` import**

In `src/ui/SyncCenterView.ts:3`, extend the existing `../core/status` import. Current:

```ts
import { bucketCounts, GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry } from "../core/status";
```

Change to:

```ts
import { bucketCounts, GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry, remoteDirectionCounts } from "../core/status";
```

- [ ] **Step 2: Add the `renderSelfChip` method**

Insert this method directly above `renderHeader` (i.e. just before `:771`) in `src/ui/SyncCenterView.ts`:

```ts
// The self chip for the global status bar (Layout B): Config Sync's own state,
// always shown (green check when in sync) so mobile can confirm self status
// even with the sidebar collapsed. Reuses selfStatePill so the pane and the
// header can't drift. Clicking opens the self pane.
private renderSelfChip(parent: HTMLElement): void {
  const info = this.selfInfo;
  if (info === null) return;
  const pill = this.selfStatePill(info);
  if (pill === null) return;
  const chip = parent.createSpan({ cls: `config-sync-self-chip ${pill.cls}`, attr: { "aria-label": `Config Sync: ${pill.text}` } });
  const ic = chip.createSpan({ cls: "config-sync-self-chip-ic" });
  setIcon(ic, info.state === "insync" ? "check" : "settings");
  chip.createSpan({ text: pill.text });
  chip.addEventListener("click", () => {
    this.panelScope = { kind: "self" };
    this.switcherOpen = false;
    this.render(this.renderGen);
  });
}
```

- [ ] **Step 3: Rework `renderHeader`**

Replace the body of `renderHeader` (`:771-812`) with the version below. Changes: call `renderSelfChip` + divider first; compute `remoteDirectionCounts`; insert push/pull pills between the apply and in-sync pills. The refreshed text + refresh button are unchanged.

```ts
private renderHeader(): void {
  // No title span: the pane header already reads "Sync Center" (mobile polish round 2).
  const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
  this.renderSelfChip(head);
  if (this.selfInfo !== null) head.createSpan({ cls: "config-sync-head-divider" });
  const { up, down, ok, none } = this.presentedCounts(this.mainRows());
  const remoteStates = this.host.remotes().map((r) => this.host.remoteCheck(r.name)?.check.state ?? "unknown");
  const { push, pull } = remoteDirectionCounts(remoteStates);
  const pills = head.createSpan({ cls: "config-sync-report-pills" });
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
  if (push > 0) {
    renderActionCount(
      pills.createSpan({ cls: "config-sync-pill is-push", attr: { "aria-label": `${push} remote${push === 1 ? "" : "s"} to push` } }),
      "push", push,
    );
  }
  if (pull > 0) {
    renderActionCount(
      pills.createSpan({ cls: "config-sync-pill is-pull", attr: { "aria-label": `${pull} remote${pull === 1 ? "" : "s"} to pull` } }),
      "pull", pull,
    );
  }
  pills.createSpan({
    cls: "config-sync-pill is-ok",
    text: `✓ ${ok}`,
    attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` },
  });
  if (none > 0) {
    pills.createSpan({
      cls: "config-sync-pill is-none",
      text: `○ ${none}`,
      attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
    });
  }
  head.createSpan({
    cls: "config-sync-center-refreshed",
    text: this.lastRefreshedAt === null ? "" : `refreshed ${relativeAge(this.lastRefreshedAt)}`,
  });
  // Manual refresh (定稿 2026-07-17, replaces the enabled-set polling): same affordance as
  // the Remotes ↻ — re-scans local state, catching plugin toggles made in Obsidian's
  // settings modal while the panel stayed open.
  const refresh = new ExtraButtonComponent(head);
  refresh.setIcon("refresh-cw");
  refresh.setTooltip("Refresh local state");
  refresh.extraSettingsEl.addClass("config-sync-center-refresh");
  refresh.onClick(() => void this.reload());
}
```

- [ ] **Step 4: Add CSS**

In `styles.css`, after the existing `.config-sync-pill.is-none` rule (`:409`), add the push/pull pill colors:

```css
.config-sync-pill.is-push { background: rgba(var(--color-pink-rgb), 0.15); color: var(--color-pink); }
.config-sync-pill.is-pull { background: rgba(var(--color-cyan-rgb), 0.15); color: var(--color-cyan); }
```

After the `.config-sync-center-refreshed` rule (`:611`), add the self chip + divider:

```css
.config-sync-self-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--font-ui-smaller); border-radius: 999px; padding: 1px 9px; border: 1px solid transparent; cursor: pointer; }
.config-sync-self-chip .config-sync-self-chip-ic { display: inline-flex; }
.config-sync-self-chip .config-sync-self-chip-ic svg { width: 13px; height: 13px; }
.config-sync-self-chip.is-up { border-color: rgba(var(--color-orange-rgb), 0.5); color: var(--color-orange); }
.config-sync-self-chip.is-down { border-color: rgba(var(--interactive-accent-rgb), 0.5); color: var(--interactive-accent); }
.config-sync-self-chip.is-ok { border-color: rgba(var(--color-green-rgb), 0.5); color: var(--color-green); }
.config-sync-head-divider { width: 1px; height: 16px; background: var(--background-modifier-border); flex: none; }
```

- [ ] **Step 5: Run the gates**

Run each and confirm:
```bash
cd ~/local/coding/open/obsidian-config-sync
npx tsc -noEmit -skipLibCheck            # clean (no output)
npm test                                  # green
npx eslint .                              # 0 errors / 67 warnings
./scripts/check-no-hardcoded-color.sh     # OK
npm run build                             # clean (exit 0)
```

- [ ] **Step 6: Live-verify on the dev vault**

Reload the plugin (or `open -a Obsidian` if backgrounded). In the Sync Center:
- Header shows the self chip left of a thin divider, then the item totals.
- If the self layer is in sync, the chip shows a green check + "in sync"; otherwise a gear + state text ("N to capture" / "N to adopt" / "to adopt · to capture" / "not set up") with a colored border.
- Clicking the self chip opens the Config Sync self pane.
- If a remote is configured and its check is `remote-older`/`remote-newer`, a `☁↑`/`☁↓` pill appears (pink/cyan) between the apply and in-sync pills.
- Switch scope (All items → Obsidian → a remote): the header totals do **not** change (they stay global).
- Mobile (390×844, `body.is-mobile`): the self chip is visible at the top with the sidebar collapsed; no push/pull pills (no remotes); the row wraps without horizontal overflow.

- [ ] **Step 7: Commit**

```bash
cd ~/local/coding/open/obsidian-config-sync
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(ui): global status bar — self chip + push/pull totals in the header"
```

---

## Self-Review

- **Spec coverage:** self chip always-shown w/ green check (Task 2 §2/§6) ✅; divider (Task 2 §3/§4) ✅; item totals unchanged & global (Task 2 §3) ✅; push/pull = remote counts, >0 only, desktop-only naturally (Task 1 + Task 2 §3) ✅; view-local, no host change ✅; theme vars / Lucide (Task 2 §2/§4) ✅.
- **Placeholders:** none — every code step shows full code.
- **Type consistency:** `remoteDirectionCounts(states: RemoteState[]) → {push,pull}` matches Task 1's export; `selfStatePill` null-guarded; `remoteCheck(name)?.check.state ?? "unknown"` yields `RemoteState`.
