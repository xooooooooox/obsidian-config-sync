# Panel Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One counting model for the five item states (↑ = capture bucket incl. not-captured; ↓ = apply bucket incl. differs) applied to pills/dot/menu, workspace-file dedup in Discovered, item rows lose the inline path, and a CSS fidelity pass matching the approved gallery mockup — plus reproduce-and-fix the row-overlap glitch.

**Architecture:** A shared pure helper `bucketCounts(statuses)` in `src/core/status.ts` feeds all three counting surfaces. UI/CSS changes confined to `src/ui/SyncModal.ts` + `styles.css`. Visual ground truth: `.superpowers/brainstorm/22414-1783791813/content/all-final-gallery.html`.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, obsidian-cli for live verification.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — 0 lint errors (pre-existing warnings acceptable).
- `src/core/*`: zero Node-builtin/`obsidian` imports.
- Buckets exactly: `↑` = `local-changed` + `not-captured`; `↓` = `store-newer` + `differs`; `✓` = `in-sync`. Pre-check defaults are UNCHANGED (only local-changed and store-newer pre-check).
- **Vault-identity guard for any obsidian-cli use:** run `eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, read the output, require `vault`; on mismatch `open "obsidian://open?vault=vault"`, wait 6 s, re-check. NEVER chain the guard with `&&`.
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.
- Copy strings verbatim where specified.

---

### Task 1: `bucketCounts` + unified counting + workspace dedup

**Files:**
- Modify: `src/core/status.ts` (add helper), `src/core/catalog.ts` (`listDiscovered`), `src/main.ts` (dot + menu counts + tooltip), `src/ui/SyncModal.ts` (header pills)
- Test: `tests/status.test.ts`, `tests/catalog.test.ts`

**Interfaces:**
- Produces: `export interface BucketCounts { up: number; down: number; ok: number }` and `export function bucketCounts(statuses: GroupStatus[]): BucketCounts` in `src/core/status.ts` (`up` = local-changed + not-captured; `down` = store-newer + differs; `ok` = in-sync).

- [ ] **Step 1: Failing tests**

`tests/status.test.ts` (append; `GroupStatus` import already present or add it):

```ts
it("bucketCounts groups the five states into capture/apply/ok buckets", () => {
  const statuses: GroupStatus[] = [
    { group: "a", state: "local-changed" },
    { group: "b", state: "not-captured" },
    { group: "c", state: "store-newer" },
    { group: "d", state: "differs" },
    { group: "e", state: "in-sync" },
  ];
  expect(bucketCounts(statuses)).toEqual({ up: 2, down: 2, ok: 1 });
});
```

`tests/catalog.test.ts` (append; mirror the file's existing listDiscovered test fixture style — check `grep -n "listDiscovered" tests/catalog.test.ts` and reuse its MemFS setup):

```ts
it("discovered files exclude workspace-pattern files (offered under Not recommended instead)", async () => {
  // seed the fixture io with workspace.json and workspaces.json alongside an unknown file
  // (reuse the existing listDiscovered test's setup verbatim, adding the two workspace files)
  // assert: the unknown file IS discovered; neither workspace.json nor workspaces.json appears.
});
```

Write the real test body against the actual fixture helpers in that file — the assertion contract above is binding.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/status.test.ts tests/catalog.test.ts`; FAIL (bucketCounts missing; workspace files present in discovered).

- [ ] **Step 3: Implement**

`src/core/status.ts`:

```ts
export interface BucketCounts {
  up: number; // resolved by Capture: changed here + never captured
  down: number; // resolved by Apply: store newer + differs
  ok: number;
}

export function bucketCounts(statuses: GroupStatus[]): BucketCounts {
  let up = 0;
  let down = 0;
  let ok = 0;
  for (const s of statuses) {
    if (s.state === "local-changed" || s.state === "not-captured") up++;
    else if (s.state === "store-newer" || s.state === "differs") down++;
    else ok++;
  }
  return { up, down, ok };
}
```

`src/core/catalog.ts` `listDiscovered`: add `WORKSPACE_RE.test(b)` to the skip condition alongside the existing exclusions.

`src/main.ts`:
- `updateRibbonDot` (lines ~160): replace the two filters with `const { up, down } = bucketCounts(s);` — orange when `up > 0`; blue when `up === 0 && (down > 0 || remoteNewer.length > 0)`. Tooltip segments become: `` `${up} to capture` `` (when >0), `` `${down} to apply` `` (when >0), remote segments unchanged; joiner/format otherwise identical.
- `openSyncMenu` (lines ~175): same `bucketCounts` call replaces the two filters; title format `Sync… (↑N ↓N)` unchanged.

`src/ui/SyncModal.ts` header (lines ~112-135): `const { up, down, ok } = bucketCounts(this.rows().map((r) => r.status));` replaces the three filters; pill aria-labels become verbatim: `` `${up} item${up === 1 ? "" : "s"} to capture` ``, `` `${down} item${down === 1 ? "" : "s"} to apply` ``, `` `${ok} item${ok === 1 ? "" : "s"} in sync` ``.

- [ ] **Step 4: Green** — targeted, then `npm test`.
- [ ] **Step 5: Gate + commit**

```bash
git add src/core/status.ts src/core/catalog.ts src/main.ts src/ui/SyncModal.ts tests/status.test.ts tests/catalog.test.ts
git commit -m "fix: unified capture/apply bucket counting; discovered excludes workspace files"
```

---

### Task 2: Row path → tooltip; style fidelity pass; overlap investigation

**Files:**
- Modify: `src/ui/SyncModal.ts`, `styles.css`

**Interfaces:** consumes Task 1's shipped state; no new exports.

- [ ] **Step 1: Path removal**

In `renderItemRow` (SyncModal.ts ~line 193): delete the `config-sync-row-path` span; add to the ROW element `attr: { "aria-label": this.host.resolvedPath(group) }` (or `row.setAttribute(...)` after creation). Remote rows keep their `captured <time>` span.

- [ ] **Step 2: CSS fidelity (replace the corresponding blocks in styles.css)**

```css
.config-sync-macro {
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: var(--radius-m);
  padding: var(--size-4-2) var(--size-4-3) var(--size-4-3);
  margin-bottom: var(--size-4-3);
}

.config-sync-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: var(--radius-m);
  padding: 0 var(--size-4-3);
}

.config-sync-hub-row,
.config-sync-report-row {
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.config-sync-sect {
  padding: var(--size-4-3) 2px var(--size-4-1);
}

.config-sync-actionbar {
  margin-top: var(--size-4-3);
}

.config-sync-pill {
  font-size: var(--font-ui-smaller);
  padding: 1px 8px;
}

.config-sync-state-icon {
  font-size: var(--font-ui-small);
}

/* custom-drawn checkboxes (same inputs, no native rendering) */
.config-sync-hub-row input[type="checkbox"],
.config-sync-sect input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  margin: 0;
  border: 1.5px solid var(--text-faint);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  flex: none;
  background: transparent;
}

.config-sync-hub-row input[type="checkbox"]:disabled {
  opacity: 0.25;
  cursor: default;
}

.config-sync-hub-row input[type="checkbox"].is-capture:checked {
  background: var(--color-orange);
  border-color: var(--color-orange);
}

.config-sync-hub-row input[type="checkbox"].is-apply:checked {
  background: var(--interactive-accent);
  border-color: var(--interactive-accent);
}

.config-sync-hub-row input[type="checkbox"]:checked::after {
  content: "✓";
  position: absolute;
  top: -3px;
  left: 1px;
  font-size: 12px;
  color: var(--text-on-accent);
}

.config-sync-sect input[type="checkbox"]:checked {
  background: var(--text-muted);
  border-color: var(--text-muted);
}

.config-sync-sect input[type="checkbox"]:checked::after {
  content: "✓";
  position: absolute;
  top: -3px;
  left: 1px;
  font-size: 12px;
  color: var(--background-primary);
}

.config-sync-sect input[type="checkbox"]:indeterminate {
  background: var(--text-faint);
  border-color: var(--text-faint);
}

.config-sync-sect input[type="checkbox"]:indeterminate::after {
  content: "−";
  position: absolute;
  top: -3px;
  left: 3px;
  font-size: 12px;
  color: var(--background-primary);
}
```

(Adapt selector merging where these rules already exist — REPLACE the old `background/border/padding` values rather than appending duplicates. Delete the now-obsolete `accent-color` rules.)

- [ ] **Step 3: Overlap investigation (live, guard first)**

In the dev vault: enable ~20+ items via the pickers (`eval` can tick programmatically: `p.readGroupsFile()` → push many groups → `p.writeGroupsFile(...)`, or use the settings tab's toggleSection via core — simplest: write a config-sync.json with 25 file groups pointing at real `.obsidian/*.json` files). Open the panel, expand/collapse various rows, scroll, screenshot, view with Read tool, hunt for superimposed text. Suspects: empty detail div margins on rows with no `changes`; `min-width: 0` missing on a flex ancestor; the hint div's negative margin (`.config-sync-hub-hint` if it has one). Fix the reproduced cause. If not reproducible after an honest attempt, write the attempt up in the report and restore the dev vault config afterwards (keep a backup of the original config-sync.json and restore it).

- [ ] **Step 4: Live style verification (guard first)**

`npm run smoke:install` → reload → stage one ↑ one ↓ one ≠ one — (write files as in previous smokes; the `—` = tick a new item) → open panel → screenshot → view: compare against `.superpowers/brainstorm/22414-1783791813/content/all-final-gallery.html` (open its Sync-panel section in your mind's eye from reading the HTML): layered depth visible (macro lighter than modal, card lighter than macro), custom checkboxes (rounded, orange/purple fills, gray indeterminate), pills counting per the new model (the — item counts in ↑), no inline paths, row hover shows the path tooltip. Clean up all staging (restore config, remove temp files, verify all in-sync via `p.refreshLocalStatus()`).

- [ ] **Step 5: Gate + commit**

```bash
git add src/ui/SyncModal.ts styles.css
git commit -m "fix: panel style fidelity to approved mockups; paths move to row tooltips"
```

(If the overlap fix touched other files, include them and name the cause in the commit body's first line after the subject — still no attribution lines.)

---

## Verification after all tasks

1. Full gate; `bucketCounts` used by all three surfaces (grep: `grep -rn "bucketCounts" src/` shows status.ts + main.ts ×2 + SyncModal.ts).
2. Smoke evidence in the task report: side-by-side screenshot, new-item → orange dot, ≠ → ↓ pill.
3. Ledger notes the overlap outcome (fixed + cause, or parked with repro attempt).
