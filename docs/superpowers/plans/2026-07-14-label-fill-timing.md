# Unified Label Fill Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the display-name `label` backfill from capture-only into a single `backfillLabels` method called from `refreshLocalStatus`, so labels populate on the next status refresh (panel open / periodic / awareness) instead of only after a Capture.

**Architecture:** Pure `src/main.ts` relocation. Extract the existing inline capture-host backfill (lines 246-260) into a private `backfillLabels(ctx)` method; call it from `refreshLocalStatus` after the status scan; delete the inline copy from `captureItems`. The enable-time immediate label write is untouched.

**Tech Stack:** TypeScript (Obsidian Plugin), no core-layer change, no UI, no tests added (relocation of covered logic).

## Global Constraints

- No behavior change beyond timing: the backfill body is byte-identical to the current inline logic; the resolver chain and `changed`-guarded write are unchanged.
- `backfillLabels` must never throw into its caller (internal try/catch, logs on error).
- `refreshLocalStatus` must remain non-throwing.
- Gate: `npm run build && npm run lint` clean (0 errors / 65 warnings baseline, don't add errors), `npm test` green (202), `./scripts/check-no-hardcoded-color.sh` passes.
- No Claude/AI attribution in commits.

---

### Task 1: Extract `backfillLabels`, call from refreshLocalStatus, remove capture copy

**Files:**
- Modify: `src/main.ts` (add `backfillLabels` method; call in `refreshLocalStatus` ~lines 135-146; delete inline backfill in `captureItems` ~lines 246-260)

**Interfaces:**
- Produces: `private async backfillLabels(ctx: CoreContext): Promise<void>` on the plugin class.

- [ ] **Step 1: Add the `backfillLabels` method.** Place it right after `refreshLocalStatus` (after its closing brace at ~line 146). Body is the lifted inline logic verbatim:

```ts
  // Fills in any missing display-name label using runtime plugin/core names, and persists the
  // manifest only if at least one label was added. Never throws into the caller.
  private async backfillLabels(ctx: CoreContext): Promise<void> {
    try {
      const groups = await readGroups(ctx);
      let changed = false;
      for (const g of groups) {
        if (g.label !== undefined) continue;
        const resolved = this.displayName(g.name, g.label);
        if (resolved !== g.name && resolved !== g.name.replace(/^plugin-/, "")) {
          g.label = resolved;
          changed = true;
        }
      }
      if (changed) await writeGroups(ctx, groups);
    } catch (e) {
      console.error("Config Sync: label backfill skipped", e);
    }
  }
```

(`readGroups`, `writeGroups` are already imported in main.ts — verify with `grep -n "readGroups\|writeGroups" src/main.ts`; `CoreContext` is already imported.)

- [ ] **Step 2: Call it from `refreshLocalStatus`.** The current method (lines 135-146):

```ts
  async refreshLocalStatus(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      this.localStatuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
    } catch (e) {
      console.error("Config Sync: status refresh failed", e);
    }
    this.updateRibbonDot();
    this.notifySyncCenter();
  }
```

Add the backfill call inside the try, after the `statusForGroups` line (so it shares the already-built `ctx`), before the catch:

```ts
      this.localStatuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
      await this.backfillLabels(ctx);
```

(`backfillLabels` is internally guarded so it can't break the refresh; placing it inside the try reuses `ctx` without rebuilding it.)

- [ ] **Step 3: Delete the inline backfill in `captureItems`.** Replace lines 245-261 — the `const results = await capture(...)` through `await this.refreshLocalStatus();` — removing the inner `try { … backfill … } catch { … }` block so it reads:

```ts
          const ctx = await this.coreContext();
          const results = await capture(ctx, names, onProgress);
          await this.refreshLocalStatus();
          return results;
```

(Post-capture labels are still filled: `refreshLocalStatus` now runs the unified backfill. No regression.)

- [ ] **Step 4: Check for now-unused imports.** After deleting the capture backfill, `readGroups`/`writeGroups` are still used (by `backfillLabels` and `readGroupsFile`/`writeGroupsFile`). Run `grep -n "readGroups\|writeGroups" src/main.ts` — expect ≥2 hits each; do NOT remove the imports.

- [ ] **Step 5: Gate.**

Run: `npm run build && npm run lint 2>&1 | grep problem`
Expected: build clean; `0 errors, 65 warnings`.

Run: `npm test 2>&1 | grep Tests`
Expected: `Tests  202 passed (202)`.

- [ ] **Step 6: Commit.**

```bash
git add src/main.ts
git commit -m "feat: fill display-name labels on status refresh, not only on capture"
```

---

### Task 2: Smoke — labels populate without Capture

**Files:** none (controller-run verification).

- [ ] **Step 1: Set up a label-less state.** Deploy (`npm run smoke:install`), vault-name guard (`app.vault.getName()` must print `vault`). In the dev vault, strip labels from `config-sync/config-sync.json` (remove every `"label"` key) via a script, so the manifest has label-less groups.
- [ ] **Step 2: Trigger a refresh WITHOUT capturing.** Reload the plugin (disable/enable) — `onLayoutReady` calls `refreshLocalStatus`; OR open the Sync Center (also refreshes). Do NOT click Capture.
- [ ] **Step 3: Verify.** Re-read `config-sync/config-sync.json` — confirm labels are back (`plugin-obsidian42-brat` → `BRAT`, `app` → `App settings`, etc.), populated by the refresh-time backfill alone.
- [ ] **Step 4: Confirm no console errors** (`dev:errors` shows no config-sync frame) and record the result in the ledger.

---

## Self-Review Notes

- Spec coverage: the single design (unified backfill on refresh, delete capture copy, keep enable write) → Task 1; verification protocol → Task 2.
- Type consistency: `backfillLabels(ctx: CoreContext)` matches the `ctx` built in both `refreshLocalStatus` and `captureItems` via `coreContext()`.
- No new symbols leak; the enable-time write in the settings host (`groupForItem(..., item.label)`) is out of scope and untouched.
- Post-plan flow (standing user instruction): after Task 1 + Task 2, hand to the user for pre-merge acceptance; merge + cut only after the user verifies. This is a small single-file change — the user may fold its cut in with a later backlog item rather than cutting a version for it alone (their call).
