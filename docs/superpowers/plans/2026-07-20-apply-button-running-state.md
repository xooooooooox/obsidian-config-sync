# Fix apply/capture button running-state desync — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the Apply/Capture button from flipping back to "↓ Apply N items" (greyed) mid-run: suppress reactive re-renders while running (A) and make the action bar render the in-flight progress (B).

**Architecture:** A adds `this.running` guards to the view's reactive reload paths. B adds an `activeRun` field + a pure `runProgressLabel`, so `renderActionBar` renders the busy button from the live progress instead of the staged count.

**Tech Stack:** TypeScript, vitest. Files: `src/ui/panelModel.ts`, `src/ui/SyncCenterView.ts`, `tests/panelModel.test.ts`.

## Global Constraints

- No change to apply/capture core logic, the progress-bar shimmer, or the runline. View-only.
- Gates: `npm test`, `npx eslint .` 0 errors / 67 warnings, `./scripts/check-no-hardcoded-color.sh`, `npm run build` clean.

---

### Task 1: `runProgressLabel` pure helper

**Files:**
- Modify: `src/ui/panelModel.ts` (add exported function)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Produces: `runProgressLabel(verb: "Capturing" | "Applying", done: number, total: number): string`.

- [ ] **Step 1: Write the failing test.** Add to `tests/panelModel.test.ts` (add `runProgressLabel` to the existing import from `"../src/ui/panelModel"`):

```ts
describe("runProgressLabel", () => {
  it("arrow-prefixes the verb with done/total", () => {
    expect(runProgressLabel("Applying", 5, 72)).toBe("↓ Applying 5/72…");
    expect(runProgressLabel("Capturing", 0, 3)).toBe("↑ Capturing 0/3…");
  });
});
```

- [ ] **Step 2: Run, verify failure.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/panelModel.test.ts -t "runProgressLabel"` — Expected: FAIL (not exported).

- [ ] **Step 3: Implement.** In `src/ui/panelModel.ts`, add at the end:

```ts
// The busy-button label during a capture/apply run — arrow-prefixed to match the idle
// "↑ Capture N items" / "↓ Apply N items" buttons. Rendered from the view's activeRun state so a
// mid-run rebuild shows live progress instead of the stale staged count.
export function runProgressLabel(verb: "Capturing" | "Applying", done: number, total: number): string {
  return `${verb === "Capturing" ? "↑" : "↓"} ${verb} ${done}/${total}…`;
}
```

- [ ] **Step 4: Run tests.** `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/panelModel.test.ts` — Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/panelModel.ts tests/panelModel.test.ts && git commit -m "feat: add runProgressLabel helper"
```

---

### Task 2: Guard reactive re-renders + render the running state

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (import; `activeRun` field; `active-leaf-change`, `evaluateCompact`, `notifyExternalChange`; `run`; `renderActionBar`)

**Interfaces:**
- Consumes: `runProgressLabel` (Task 1).

- [ ] **Step 1: Import + field.** In `src/ui/SyncCenterView.ts`, add `runProgressLabel` to the existing import from `"./panelModel"`. Then, right after the line `private running = false;`, add:

```ts
  private activeRun: { verb: "Capturing" | "Applying"; done: number; total: number } | null = null;
```

- [ ] **Step 2: Guard the `active-leaf-change` reload.** Change:
```ts
        if (leaf === this.leaf) void this.reload();
```
to:
```ts
        if (leaf === this.leaf && !this.running) void this.reload();
```

- [ ] **Step 3: Guard `notifyExternalChange`.** Change the method:
```ts
  notifyExternalChange(): void {
    void this.reload();
  }
```
to:
```ts
  notifyExternalChange(): void {
    if (this.running) return; // a rebuild mid-run would replace the live progress button
    void this.reload();
  }
```

- [ ] **Step 4: Guard `evaluateCompact`'s render.** In `evaluateCompact`, change:
```ts
    if (compact !== this.compact) {
      this.compact = compact;
      this.render(this.renderGen);
    }
```
to:
```ts
    if (compact !== this.compact) {
      this.compact = compact;
      if (!this.running) this.render(this.renderGen);
    }
```

- [ ] **Step 5: Set/clear `activeRun` in `run`.** In the `run` closure: after the line `this.running = true;`, add:
```ts
      this.activeRun = { verb, done: 0, total: payload.length };
```
In the `onProgress` callback passed to `exec`, replace the line:
```ts
            btn.setButtonText(`${verb} ${done}/${total}…`);
```
with:
```ts
            this.activeRun = { verb, done, total };
            btn.setButtonText(runProgressLabel(verb, done, total));
```
In the `finally` block, after `this.running = false;`, add:
```ts
          this.activeRun = null;
```

- [ ] **Step 6: Render the running state in `renderActionBar`.** For the capture button, replace:
```ts
    capW.btn.setButtonText(`↑ Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
```
with:
```ts
    if (this.activeRun?.verb === "Capturing") {
      capW.btn.setButtonText(runProgressLabel("Capturing", this.activeRun.done, this.activeRun.total));
      capW.btn.buttonEl.addClass("is-busy");
    } else {
      capW.btn.setButtonText(`↑ Capture ${capItems.length} item${capItems.length === 1 ? "" : "s"}`);
    }
```
For the apply button, replace:
```ts
    applyW.btn.setButtonText(`↓ Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
```
with:
```ts
    if (this.activeRun?.verb === "Applying") {
      applyW.btn.setButtonText(runProgressLabel("Applying", this.activeRun.done, this.activeRun.total));
      applyW.btn.buttonEl.addClass("is-busy");
    } else {
      applyW.btn.setButtonText(`↓ Apply ${applyItems.length} item${applyItems.length === 1 ? "" : "s"}`);
    }
```
(The existing `capW.btn.buttonEl.addClass("config-sync-btn-capture")`, `setCta()`, and `setDisabled(this.running || …)` lines stay as-is.)

- [ ] **Step 7: Gates.** `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck` (clean), `npm test` (green), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK), `npm run build` (clean).

- [ ] **Step 8: Commit.**

```bash
cd ~/local/coding/open/obsidian-config-sync && git add src/ui/SyncCenterView.ts && git commit -m "fix: keep the action-bar button on the running state through mid-run re-renders"
```

---

### Task 3: Live verification (dev vault)

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`; reload the plugin.
- [ ] **Step 2: Simulate a mid-run rebuild.** Via `obsidian-cli eval`, set the view's `activeRun = { verb: "Applying", done: 12, total: 72 }` and `running = true`, call `v.render(v.renderGen)`, and read the apply button's text — assert it is `↓ Applying 12/72…` and disabled (a rebuild while "running" shows progress, not "Apply N items"). Also assert `notifyExternalChange()` is a no-op while `running` (the button text is unchanged after calling it). Reset `activeRun = null; running = false; render`.
- [ ] **Step 3: Confirm idle unchanged.** With `activeRun = null`, confirm the buttons render as `↑ Capture N items` / `↓ Apply N items` as before.

---

## Self-Review

**Spec coverage:** A (guard reactive reloads) → Task 2 Steps 2-4; B (`activeRun` + `runProgressLabel` + render-derived button) → Task 1 + Task 2 Steps 1,5,6; test → Task 1; live → Task 3. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. ✓

**Type consistency:** `runProgressLabel(verb: "Capturing" | "Applying", done, total): string` (Task 1) consumed in `run`'s onProgress and `renderActionBar` (Task 2 Steps 5-6). `activeRun: { verb; done; total } | null` (Task 2 Step 1) set in Step 5, read in Step 6 with `this.activeRun?.verb === "Capturing"|"Applying"`. Verb literals match the `run` calls (`"Capturing"`/`"Applying"`, existing). ✓
