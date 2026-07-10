# Remotes on mobile, Browse fix, lock semantics — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** three post-0.9.0 findings: (1) the Remotes tab is meaningless on mobile, (2) the Browse button crashes with "failed module electron" on real desktops, (3) `store.lock.json` loses version records for errored groups and still speaks the retired "publish" vocabulary.

## 1. Hide the Remotes tab on mobile

Remote configuration lives in this device's `data.json` (device-local, never synced) and Pull/Push commands are desktop-only — configuring a remote on mobile has zero effect, and vault absolute paths are meaningless in the mobile sandbox. Decision: **hide the tab entirely on mobile** (option B).

- `TABS` entries gain `desktopOnly?: true` on `sources`; `renderTabNav` skips desktop-only tabs when `Platform.isMobile`.
- Phones show 5 tabs. `activeTab` can never become `sources` on mobile (no entry point; `display()` resets to `general`). Search results only cover picker tabs — no other reachability.
- Desktop behavior unchanged.

## 2. Browse fix: `window.require("electron")`

**Root cause (verified in the bundled `main.js`):** `await import("electron")` survives esbuild as a native ESM dynamic import (modern targets keep `import()` for externals even in CJS output). The Electron renderer cannot resolve a bare module specifier via ESM import → "failed module electron". The earlier live probe used `require("electron")`, which works — masking the import-mechanism failure.

**Fix:** `src/external/pickFolder.ts` obtains electron via `window.require("electron")` (the community-plugin standard), no dynamic `import()`:

- Narrow `window` to `{ require?: (m: string) => unknown }`; if `require` is absent, throw `Config Sync: the folder picker needs the desktop app`.
- The `Platform.isDesktop` guard stays the first statement; `electron` is not a Node builtin and `window.require` is invisible to the scanner — no new warnings.
- Everything downstream (`remote.dialog.showOpenDialog`, cancellation, store auto-detect) unchanged.

**Acceptance:** a human click on Browse in the dev vault opens the system dialog and, after picking a vault folder, auto-fills the detected store directory. (Lesson encoded: the button existing is not the button working — this smoke step is manual and mandatory.)

## 3. `store.lock.json`: carry-forward + retire "publish" vocabulary

### Mechanism (unchanged parts, for reference)

The lock is part of the store (travels with it). It is rewritten wholesale at the end of every Capture: `capturedAt` = capture time; for each plugin-backed group that captured without error, the source device's installed plugin version is recorded. `checkApply` uses it for pre-Apply warnings (not installed / version mismatch / no record).

### Change A — errored-capture carry-forward

Today an errored group simply vanishes from the new lock, degrading every later Apply to "no recorded version". New behavior: `capture()` loads the previous lock first; a plugin-backed group whose capture result is `error` keeps its old lock entry (if one exists). Groups that succeed record the current version as today; plugin-not-installed keeps today's warning + no record; groups absent from the old lock stay absent.

Test: capture once (records version) → make that group's source vanish → capture again → the new lock still carries the old version entry; a group that never had an entry stays without one.

### Change B — `publishedAt` → `capturedAt`, and prose cleanup

- `StoreLock.publishedAt` → `capturedAt` in `src/core/types.ts`; `parseStoreLock` validates the new key (error message updates to `store.lock.json must be {capturedAt: string, groups: object}`); `capture()` writes it.
- **Strict rename, no back-compat** (established principle): an old lock file fails `parseStoreLock` until the next Capture rewrites it. Self-healing: run Capture once after upgrading. Release notes must call this out.
- Internal `publishGroup` → `captureGroup` (rename only).
- `checkApply` mismatch message becomes: `store config was captured with ${pluginId}@${recorded}, this device runs ${pluginId}@${installed} — settings schema may differ`.
- Test wording/fixtures follow (`publishes the rest` → `captures the rest`, fixture keys `publishedAt` → `capturedAt`).
- NOT touched: `src/core/catalog.ts`'s `publish: "publish.json"` / `CORE_NOT_RECOMMENDED ["sync", "publish"]` — that "Publish" is Obsidian's own core plugin, unrelated to the retired verb.

## Error handling

- Old-format lock: `parseStoreLock` throws its normal validation error; `checkApply` surfaces it as today for any parse failure. No silent fallback (heals on next Capture).
- `window.require` absent: explicit error (theoretically unreachable on desktop).

## Testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit: carry-forward (kept entry / never-existed entry), `capturedAt` round-trip, old-key lock rejected.
- Smoke: phone emulation shows 5 tabs (no Remotes); desktop shows 6; **manual Browse click** end-to-end (dialog opens, store auto-filled); zero console errors.

## Non-goals

- README lock documentation (declined); `capturedAt` back-compat; any Pull/Push semantics change; other backlog items (§4.2 scanner warnings, self-sync, stable expand keys).
