# Mobile overflow fixes — implementation plan

**Goal:** Stop two Sync Center layouts from overflowing at phone width — the
"On apply" policy segment (clips `⤓ Install`) and the result strip (crams into
multiple lines) — with changes scoped to `body.is-mobile`.

**Architecture:** ② is one CSS rule. ③ groups the strip's meta items (pills +
two toggles) into a `.config-sync-strip-meta` wrapper that is `display:contents`
on desktop (identical render) and a 100%-basis second row on mobile.

**Tech Stack:** TypeScript (`src/ui/SyncCenterView.ts`), `styles.css`, Obsidian
theme vars. No unit-testable logic changes; gates are build/lint/color/live.

## Global Constraints

- Every new rule scoped to `body.is-mobile`; desktop render byte-identical.
- No hardcoded colors — reuse existing theme vars only.
- Gates: `./scripts/check-no-hardcoded-color.sh` OK, `npx tsc -noEmit -skipLibCheck`
  clean, `npx eslint .` at 0 errors / 67 warnings, `npm test` green, `npm run build` clean.
- Live-verify on `dev/vault` under mobile emulation.

---

## Task 1: ② segrow wraps on mobile

**Files:** Modify `styles.css` (near line 655, `.config-sync-segrow`).

- [ ] **Step 1: Add the mobile rule.** After the existing
  `.config-sync-segrow { display: flex; align-items: center; gap: var(--size-4-2); }`
  rule, add in the mobile block (near the other `body.is-mobile` seg rules, ~line 787):

```css
body.is-mobile .config-sync-segrow { flex-wrap: wrap; }
```

- [ ] **Step 2: Color check + build.** Run `./scripts/check-no-hardcoded-color.sh`
  (expect OK) and `npm run build` (expect clean).

- [ ] **Step 3: Commit.**

```bash
git add styles.css
git commit -m "fix: wrap On-apply segment row on mobile so Stop syncing drops below"
```

---

## Task 2: ③ result strip two-row on mobile

**Files:** Modify `src/ui/SyncCenterView.ts` (`renderResultStrip`, ~line 826-835),
`styles.css` (strip rules ~line 830-835).

**Interfaces:** `renderResultStrip` builds `.config-sync-strip-head` with children
check, title, `renderReportPills(head)`, two `.config-sync-strip-toggle`, and
`.config-sync-strip-close`. After this task the pills + toggles live inside a new
`.config-sync-strip-meta`; close stays last.

- [ ] **Step 1: Group meta items in the render.** In `renderResultStrip`, replace
  the block that appends pills + both toggles directly to `head` with a
  `.config-sync-strip-meta` wrapper. Close stays appended to `head` last.

Current:
```ts
    head.createSpan({ cls: "config-sync-strip-title", text: title });
    renderReportPills(head, run.results);
    const toggle = head.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
    toggle.addEventListener("click", () => { run.expanded = !run.expanded; this.render(this.renderGen); });
    const open = head.createSpan({ cls: "config-sync-strip-toggle", text: "open in history →" });
    open.addEventListener("click", () => { this.panelScope = { kind: "history" }; this.historyOpen = 0; this.switcherOpen = false; this.render(this.renderGen); });
    const close = head.createSpan({ cls: "config-sync-strip-close", text: "✕" });
```

New (only the container for pills+toggles changes; close still on `head`):
```ts
    head.createSpan({ cls: "config-sync-strip-title", text: title });
    const meta = head.createDiv({ cls: "config-sync-strip-meta" });
    renderReportPills(meta, run.results);
    const toggle = meta.createSpan({ cls: "config-sync-strip-toggle", text: run.expanded ? "details ▾" : "details ▸" });
    toggle.addEventListener("click", () => { run.expanded = !run.expanded; this.render(this.renderGen); });
    const open = meta.createSpan({ cls: "config-sync-strip-toggle", text: "open in history →" });
    open.addEventListener("click", () => { this.panelScope = { kind: "history" }; this.historyOpen = 0; this.switcherOpen = false; this.render(this.renderGen); });
    const close = head.createSpan({ cls: "config-sync-strip-close", text: "✕" });
```

- [ ] **Step 2: Desktop-identical CSS.** In `styles.css`, after the
  `.config-sync-strip-head` rule (~line 830), add:

```css
.config-sync-strip-meta { display: contents; }
```

This makes the pills/toggles participate directly in the head flex in DOM order,
so desktop renders exactly as before (check, title, pills [margin-left:auto],
details, history, close [margin-left:auto]).

- [ ] **Step 3: Mobile two-row CSS.** In the `body.is-mobile` region of
  `styles.css` (near the other strip/mobile rules), add:

```css
body.is-mobile .config-sync-strip-head { flex-wrap: wrap; }
body.is-mobile .config-sync-strip-close { order: 2; }
body.is-mobile .config-sync-strip-meta {
  order: 3;
  flex-basis: 100%;
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-wrap: wrap;
  padding-left: var(--size-4-5);
  margin-top: var(--size-2-3);
}
body.is-mobile .config-sync-strip-meta .config-sync-report-pills { margin-left: 0; }
```

Row 1 = check + title + close (close pinned right by its existing
`margin-left:auto`); row 2 = pills + `details` + `open in history`.

- [ ] **Step 4: Gates.** `./scripts/check-no-hardcoded-color.sh` (OK),
  `npx tsc -noEmit -skipLibCheck` (clean), `npm run build` (clean),
  `npx eslint .` (0 errors / 67 warnings), `npm test` (green).

- [ ] **Step 5: Commit.**

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "fix: lay the result strip out in two rows on mobile"
```

---

## Task 3: Live verification

- [ ] **Step 1: Deploy + reload.** `cp main.js styles.css dev/vault/.obsidian/plugins/config-sync/`;
  reload the plugin via obsidian-cli (disable/enable).
- [ ] **Step 2: Mobile emulation.** `dev:cdp Emulation.setDeviceMetricsOverride`
  to a phone width; confirm `body.is-mobile` is set (Obsidian sets it under
  emulation, or force it for the check). Verify:
  - Expanded item's `On apply` row: segment intact, `Stop syncing` on its own line.
  - Result strip: two clean rows (title+✕ / pills+details+history).
- [ ] **Step 3: Desktop unchanged.** Reset emulation; confirm the strip renders as
  a single row and the segment row as before (desktop identical).

---

## Self-Review

- Spec coverage: ② → Task 1; ③ render + desktop-identical + mobile two-row → Task 2. ✓
- No placeholders; exact code shown. ✓
- Type consistency: `.config-sync-strip-meta` created in Task 2 render; referenced
  by Task 2 CSS. `display:contents` desktop / `order` mobile keeps close last in DOM. ✓
- Colors: only `var(--size-*)` spacing tokens and existing behavior; no colors added. ✓
