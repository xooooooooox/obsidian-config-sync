# Sync Center Checkbox Presentation Implementation Plan

> **For agentic workers:** This plan is executed INLINE by the controller — it is CSS/visual work verified by rendered two-theme screenshots that a subagent cannot see. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the top "select all" to the row-checkbox column, and give disabled checkboxes (top select-all + row) an obvious disabled appearance.

**Architecture:** `styles.css`-only. The DOM, classes, and `disabled` property are already correct in `SyncCenterView.ts`; only appearance changes.

**Tech Stack:** CSS (Obsidian theme variables).

## Global Constraints

- **Zero hardcoded color** — this change adds only opacity + cursor + spacing (`calc(var(--size-4-3) + 1px)`); introduce no color. `./scripts/check-no-hardcoded-color.sh` must stay green.
- No TypeScript, markup, or copy change.
- Gate: `npm run build`/`lint` clean (0 errors / 65 warnings baseline), `npm test` green (207), color scan passes.
- No Claude/AI attribution in commits.

---

### Task 1: CSS — alignment + disabled appearance

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Align the mainbar right padding to the card's inner edge.** Change `.config-sync-mainbar` (line ~593) `padding-right: 11px;` to `padding-right: calc(var(--size-4-3) + 1px);` (12px padding + 1px to match the card's border). Leave the rest of the rule (`display: flex; align-items: center; gap; padding-bottom; flex-wrap: wrap`) unchanged.

- [ ] **Step 2: Drop the select-all's extra right margin.** Change `.config-sync-mainbar .config-sync-selectall` (line ~743) from `{ margin-left: auto; margin-right: var(--size-4-3); }` to `{ margin-left: auto; }` — the box now sits flush against the mainbar's right padding, landing on the row-checkbox column.

- [ ] **Step 3: Give the top select-all a disabled appearance.** Add a new rule (near the other `.config-sync-mainbar input[type="checkbox"]` rules, e.g. after the `:indeterminate::after` block ~line 516):

```css
.config-sync-mainbar input[type="checkbox"]:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
```

- [ ] **Step 4: Make the row disabled checkbox use the same treatment.** Change `.config-sync-hub-row input[type="checkbox"]:disabled` (line ~466) from:

```css
.config-sync-hub-row input[type="checkbox"]:disabled {
  opacity: 0.25;
  cursor: default;
}
```
to:
```css
.config-sync-hub-row input[type="checkbox"]:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Gate.**

Run: `npm run build && npm run lint 2>&1 | grep problem ; ./scripts/check-no-hardcoded-color.sh ; npm test 2>&1 | grep Tests`
Expected: build clean; `0 errors` (warnings at/near 65); `no hardcoded color — OK`; `Tests 207 passed`.

- [ ] **Step 6: Commit.**

```bash
git add styles.css
git commit -m "feat: align Sync Center select-all and give disabled checkboxes an obvious state"
```

---

### Task 2: Two-theme visual verification (controller, inline)

**Files:** none (controller-run verification).

- [ ] **Step 1: Deploy + guard.** `npm run smoke:install`; vault-name guard (`app.vault.getName()` must print `vault`); reload the plugin (disable/enable `config-sync`) so the new CSS loads; open the Sync Center.
- [ ] **Step 2: Alignment.** Screenshot the Sync Center top area in the **default theme** and **AnuPpuccin** (`app.customCss.setTheme('AnuPpuccin')` / `setTheme('')`). Confirm the top select-all's right edge lines up with the row checkboxes' column (read the shared right baseline). Compare against the companion mockup.
- [ ] **Step 3: Disabled state.** Produce a state where the top select-all is disabled — filter/scope so there are **no checkable rows** (e.g. the "in sync" filter, or a scope where every visible row is in-sync/inert). Confirm the top box reads clearly disabled (dimmed) and shows `not-allowed` on hover; confirm an in-sync row's checkbox also reads disabled with `not-allowed`. Capture in both themes.
- [ ] **Step 4:** Confirm no console errors (`dev:errors` shows no config-sync frame). Reset theme to default; record results in the ledger.

---

## Self-Review Notes

- Spec coverage: (a) alignment → Task 1 Steps 1-2; (b) disabled appearance → Task 1 Steps 3-4; verification → Task 2.
- No color introduced — only opacity/cursor/spacing; color-scan stays green.
- Execution mode: INLINE (rendered two-theme verification). Post-plan: hand to user for pre-merge acceptance; merge + cut only after the user verifies.
