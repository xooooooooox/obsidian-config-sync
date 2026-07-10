# Remotes redesign — data model, folder picker, row UI — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** the Remotes tab end-to-end: remote data model rename/simplification (no back-compat), local-path input replaced by a folder picker with store auto-detection, Advanced-style row UI, add-row affordance (Remotes AND Advanced), single-remote Pull/Push without the picker modal.

## Decisions (from brainstorming)

- Local-path remotes point at a **store directory**, not a config folder; the two-field `path`+`root` split is replaced by one absolute `storePath`.
- Users should not type paths by hand: a **Browse…** dialog + automatic store detection.
- Multi-remote stays (scenario: pull templates from kickstart + push backup to git); revisit later.
- **No migration**: the old `externalSources` settings key is simply ignored (left in data.json, never read). Users re-add their remotes once. The plugin has effectively one user; acceptable by explicit decision.
- Naming: `local-path` and `root` are opaque — renamed (below).

## 1. Data model

Settings key `externalSources` → **`remotes`**:

```ts
export type Remote =
  | { name: string; type: "vault"; storePath: string }
  | { name: string; type: "git"; url: string; branch: string; subdir?: string };
```

- `type: "vault"` — another vault (or any folder) on this machine. `storePath` = absolute path of the store directory itself (e.g. `/Users/<user>/…/kickstart.vault/0-Extras/config-sync`). Leading `~` is expanded (`os.homedir()`) at use time in the desktop-only layer.
- `type: "git"` — `url` (was `remote`), `branch`, and optional `subdir` (was `root`): the store's folder inside the repo; absent/empty = repo root. UI label "Folder in repo (optional)".
- Validation (`src/core/manifest.ts`): `validateExternalSources` → `validateRemotes`. Rules: non-empty `name`; vault: non-empty `storePath` starting with `/` or `~/`; git: non-empty `url` and `branch`; `subdir` when present must be a relative path without `..`. Unknown `type` rejected with the allowed values in the message.
- `transportAvailable()` and everything downstream read `settings.remotes`.

**External factories change shape** (`src/external/`):

- `createLocalPathReader(storeDir)` / `createLocalPathWriter(storeDir)` — single absolute directory (tilde-expanded by the caller-side helper in the same module), no join logic.
- `createGitReader(vaultBasePath, url, branch, subdir)` / `createGitWriter(url, branch, subdir)` — `subdir: string` (`""` = repo root; ls-tree prefix and writer base handle the empty case).

## 2. Folder picker + store auto-detection (vault remotes)

- The Store path field = text input + **Browse…** ExtraButton (desktop only; hidden on mobile — remotes are desktop-only to use anyway).
- Browse opens the system directory picker (Electron `dialog.showOpenDialog` with `openDirectory`, via the remote/`@electron/remote` interface Obsidian exposes).
- After picking a folder, the store is located automatically:
  - picked dir contains `config-sync.json` → it IS the store; fill it in.
  - else scan descendants (BFS, depth ≤ 4, skipping entries starting with `.` and `node_modules`) for directories containing `config-sync.json`:
    - exactly 1 hit → fill that directory;
    - multiple hits → `SuggestModal` to choose one;
    - 0 hits → fill the picked path as-is and show an inline note: "No store found here yet — Pull needs the other vault to Capture first; Push will initialize a store at this path." (Push to an empty target is the legitimate initialization flow; not an error.)
- Code placement: new `src/external/pickFolder.ts` — guard-first desktop-only module (first statement `if (!Platform.isDesktop) throw`), dynamic `await import()` from the settings tab on click; exports `pickFolder(): Promise<string | null>` (null = user cancelled) and `findStoreDirs(baseAbs: string): Promise<string[]>`. Tilde-expansion helper lives with the local-path code.

## 3. Remotes tab UI

- Rows adopt the Advanced language: summary row `▸` chevron · mono name · type label ("vault" / "git") · dim truncated target (storePath, or `url#branch`) · 🗑 delete. Click row (outside controls) toggles an attached expand panel — labels-above grid form:
  - vault: `Name` · `Store path` (text + Browse).
  - git: `Name` · `URL` · `Branch` · `Folder in repo (optional)`.
  - `Type` dropdown ("Another vault" / "Git repository") first in the form; switching type re-renders the form (existing draft semantics).
- The empty left gutter disappears with the old `Setting`-per-row layout.
- Expansion state joins the existing `expanded` set, keyed `remote:<name>` to avoid colliding with group names.
- Save semantics unchanged: drafts validated through `validateRemotes` on change, persistent error banner on failure.

## 4. Add-row affordance (Remotes AND Advanced)

- The heading `+` ExtraButtons (Add remote, Add rule) are removed.
- Each list gets a **full-width dashed add-row** at the bottom: `+ Add remote` / `+ Add rule` — row-height button styled with a dashed border and muted text, obviously clickable. Clicking behaves exactly like the old buttons (push empty draft/group, auto-expand).

## 5. Pull/Push modal skip

- `runPull`/`runPush`: exactly 1 remote → use it directly, no `SourceSelectModal`; ≥ 2 → modal as today; 0 → existing Notice.

## Error handling

- Browse/scan failures (dialog unavailable, unreadable dirs) surface as specific error Notices; no silent fallbacks. Scan skips unreadable subdirectories without aborting the walk (partial results are still useful), but a completely unreadable base reports its error.
- Tilde expansion only substitutes a leading `~/`; anything else passes through untouched.
- Validation error messages name the field and the expected form (e.g. `remote "kickstart": "storePath" must be an absolute path`).

## Testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit: `validateRemotes` (both shapes, bad type, relative storePath, `..` in subdir); external factories with new signatures (existing fixtures re-pointed at store dirs); git `subdir: ""` round-trip; tilde expansion.
- Smoke (obsidian-cli, dev vault): add-row visible and clickable in both tabs; remote summary row + expand; type switch re-renders form; Browse button present on desktop (dialog itself not automatable — manual once); single-remote Pull skips the modal; zero console errors.

## Non-goals

- Migration of old `externalSources` data (explicit decision).
- Default-remote concept; per-command remote binding.
- Mobile transport; multi-remote removal (revisit later).
- Any change to Pull/Push semantics beyond the modal skip.
