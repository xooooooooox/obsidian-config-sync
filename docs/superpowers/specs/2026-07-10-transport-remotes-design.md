# Transport plane & remotes — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** #2 (data-sync architecture) + #1 (consolidated ribbon command). #3 (Advanced-tab visual polish) is deferred to its own later spec.

## Problem

Today the store (`config-sync.json` + `store/` + `store.lock.json`) lives in the vault content area, and it travels between machines by **two unequal mechanisms**:

1. **Piggyback on note-sync** (remotely-save / Obsidian Sync / iCloud …) — implicit, ongoing, but config-sync neither owns nor controls it.
2. **External source Import** (git / local-path) — explicit, but modeled as a **one-shot cold-start import**, not a repeatable channel.

This splits the mental model into "cold-start full import" vs "ongoing incremental sync," couples config-sync to a specific note-sync tool, and under-uses the git/fs channel config-sync already owns. This ambiguity is why the "config-sync syncs itself" idea was shelved.

## Hard constraint

Mobile (iOS/iPadOS) cannot run `child_process`/git. `src/external/*` is desktop-only behind dynamic `import()` gated by `Platform.isDesktop`. Therefore config-sync can **never** fully replace note-sync on mobile — any unified model must keep note-sync as the mobile-capable default.

## Model: two orthogonal planes

The store sits between a device's live config and the outside world. Two planes, never entangled:

| Plane | Inbound | Outbound |
|---|---|---|
| **Local** (store ↔ this device's configDir) | **Apply** (store → configDir) | **Capture** (configDir → store) |
| **Transport** (local store ↔ a remote) | **Pull** (remote → store) | **Push** (store → remote) |

- Local-plane verbs are **transport-agnostic and always available** on every device/platform. They never touch the network.
- Transport-plane verbs are **additive**, only for explicit git/local-path remotes.
- **note-sync is the implicit default transport:** the store is content, so the user's note-sync carries it passively between their own devices. On a note-sync-only device, Pull/Push are simply not needed — Capture writes the store, note-sync delivers it, Apply lands it on the other end.

Cold-start and ongoing collapse into the same operation: **Pull is repeatable**. First run = cold start; every later run = get latest. No separate "import" concept.

## Command set (rename: direction B)

Current commands: `publish`, `apply`, `revert-last-apply`, `import-from-external`.

New set:

| Command id | Label | Plane | Availability |
|---|---|---|---|
| `capture` | Capture (this device's config → store) | local | always |
| `apply` | Apply (store → this device) | local | always |
| `revert-last-apply` | Revert last apply | local | always |
| `pull` | Pull (remote → store) | transport | desktop ∧ remotes > 0 |
| `push` | Push (store → remote) | transport | desktop ∧ remotes > 0 |

- **`publish` → `capture`**: rename the command id, ribbon label, report titles ("Publish report" → "Capture report"), and the internal engine `publish()`/`runPublish()` → `capture()`/`runCapture()`. Pre-1.0 — the id break is acceptable and there are no other consumers.
- **`import-from-external` → `pull`**: repeatable, same engine (`importExternal`, see below). Rename id/label; keep the overwrite + delete-propagation semantics.
- **`push`**: new (see Engines).

Both `pull` and `push` are **desktop-only this iteration** — the existing git/local-path readers use `child_process`/`fs`. Mobile git Pull over raw-HTTPS is explicitly **deferred**; mobile is covered by the note-sync default. Gating uses `checkCallback` returning `false` when `!Platform.isDesktop || remotes.length === 0`, exactly mirroring today's `import-from-external` gate.

## Transport semantics

- **Pull** overwrites the local store from the remote's `<root>/`, with deletion propagation (files absent upstream are removed locally). Validates upstream `config-sync.json` before writing. No merge. This is today's `importExternal`, unchanged.
- **Push** overwrites the remote's `<root>/` from the local store, with deletion propagation. No merge.
- Overwrite-not-merge keeps the model predictable and matches the existing Import behavior. A stale-overwrite guard is out of scope; users coordinate who is the source, as they do today.

## Remotes model

- **Data structure unchanged.** The settings key stays `externalSources` and the `ExternalSource` union (`local-path { path, root }` | `git { remote, branch, root }`) is reused. **Zero migration** — existing configured sources become remotes as-is.
- **UI relabel only.** The "External sources" tab becomes **"Remotes"**; copy reframes each entry as "a place you Pull from and Push to." No schema change.
- Push requires the user's own write access to the git remote (their credential helper / SSH) or a writable local-path folder. Push failures surface explicitly (no silent retry on non-idempotent git push).

## Engines (`src/core/ConfigSyncCore.ts`)

- **Pull:** existing `importExternal(ctx, reader: ExternalStoreReader)` — no change. `pull` command calls it.
- **Push:** new `pushExternal(ctx, writer: ExternalStoreWriter): Promise<GroupResult>`, the mirror of `importExternal`:
  - reads the local store files under `ctx.rootPath`,
  - writes each to the remote via the writer,
  - deletes remote files not present locally (deletion propagation),
  - returns a `GroupResult` (`"push"` op) for the report modal.
- New interface, mirroring `ExternalStoreReader`:
  ```ts
  export interface ExternalStoreWriter {
    listFiles(): Promise<string[]>;               // existing remote files, relative to <root>/
    writeFile(relPath: string, content: string): Promise<void>;
    deleteFile(relPath: string): Promise<void>;
    finalize(): Promise<void>;                    // git: add/commit/push; local-path: no-op
  }
  ```
- **Writers** (`src/external/`, desktop-only, dynamic-imported):
  - `createLocalPathWriter(destVaultPath, destRoot)` — fs write/delete into the other vault's `<root>/`; `finalize` is a no-op.
  - `createGitWriter(remote, branch, root)` — clone/fetch remote into a temp dir, apply writes/deletes under `<root>/`, then `finalize` = `git add -A && git commit && git push origin <branch>`. Commit message: `config-sync push: {{date}}`. Reuses the `git()` execFile helper from `gitSource.ts`.
- The `src/core/` red line holds: engines take the reader/writer interface; only `src/external/*` imports Node.

## #1 Consolidated ribbon command

- One new ribbon icon (**"Config Sync"**, icon `refresh-cw` — distinct from Apply's `folder-sync`) whose click opens an Obsidian `Menu` at the pointer, listing only the **currently available** commands: always Capture / Apply / Revert; plus Pull / Push when `Platform.isDesktop && remotes.length > 0`. So a note-sync device shows 3 items, a desktop-with-remote shows 5. No item that does nothing.
- The four/five **individual** ribbon icons are **hidden by default**. A new settings block (General tab) exposes a per-command toggle to show any of them individually. New setting:
  ```ts
  ribbonButtons: Record<"capture" | "apply" | "revert" | "pull" | "push", boolean>
  ```
  default all `false`. The consolidated "Config Sync" ribbon icon is always present and not part of this map.
- Ribbon registration reads `ribbonButtons` on load. Changing a toggle re-registers ribbon icons live: `addRibbonIcon` returns the created `HTMLElement`, so keep the handles, `.remove()` the affected icon and re-add per the new state. No reload required.

## Transport-status line (General tab)

A single computed line so users always know how their store travels — closing the "ambiguity" pain directly:

- No remotes: *"Store syncs via your note-sync tool (remotely-save / Obsidian Sync / …). Add a remote under Remotes for git or cross-vault sync."*
- One or more remotes: lists each remote's name and type, e.g. *"Remotes: `main-vault` (git), `laptop` (local-path). Use Pull/Push to sync the store."*

## Data flow

- **Outbound:** Capture (configDir → store) → note-sync carries it to your own devices **and/or** Push (store → git/local remote) for cross-vault / no-note-sync peers.
- **Inbound:** note-sync delivers the store passively **and/or** Pull (remote → store) → Apply (store → configDir).
- Planes never mix: Capture/Apply never touch a remote; Pull/Push never touch configDir.

## Error handling

- Transport commands hidden (not errored) when unavailable — "no remote" is a valid state, not a failure.
- Push git failures (auth, non-fast-forward) raise with the git stderr surfaced in the Notice; no silent retry (non-idempotent).
- Pull validates upstream `config-sync.json` before writing anything locally (existing behavior).
- Report modal shows per-file written/deleted counts for Pull and Push, as it does for Capture/Apply.

## Testing

- Core: unit-test `pushExternal` with an in-memory `ExternalStoreWriter` fake (writes/deletes/finalize recorded) — assert deletion propagation and that `finalize` is called once. Mirror the existing `importExternal` tests.
- Core: `checkCallback` gating logic (desktop ∧ remotes>0) as a pure predicate if extracted; otherwise cover in the smoke pass.
- Smoke (obsidian-cli, desktop dev vault): consolidated ribbon menu lists 3 items with no remote and 5 with a remote; Capture/Pull/Push report modals; transport-status line reflects remote presence; individual-ribbon toggles.
- No mobile automated test this iteration (Pull/Push desktop-only); verify on-device that mobile shows only the 3 local commands and the note-sync default still works.

## Non-goals (this iteration)

- Mobile git Pull over raw-HTTPS (deferred).
- Merge/conflict resolution (overwrite + delete-propagation only).
- Stale-overwrite / who-is-source guarding.
- config-sync syncing its own settings (the originally shelved #6) — unblocked conceptually by this model but out of scope here.
- #3 Advanced-tab visual polish (separate spec).
