# CLAUDE.md

Obsidian plugin: selective config distribution across devices/vaults. Spec: `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` (design decisions D1–D7 explain every non-obvious choice — read it before structural changes).

## Commands

- `npm run dev` — esbuild watch → `main.js`
- `npm run build` — `tsc -noEmit` + production bundle (run before finishing any change)
- `npm test` — vitest; `tests/external.test.ts` needs the `git` binary
- `npm run smoke:install` — build and install the plugin into `./dev/vault` (gitignored copy of a test vault)
- Releasing: `npm version <x.y.z>` → `git push --follow-tags` → CI drafts the release → publish the draft on GitHub (BRAT needs a published release).

## Architecture

- `src/core/` — pure functions; ALL file I/O via the `FileIO` interface (`app.vault.adapter` in prod, `tests/memfs.ts` in tests). **Never import Node APIs here — core must run on mobile.**
- `src/external/` — the only place Node `fs`/`child_process` are allowed; loaded exclusively via dynamic `import()` from desktop-gated code in `main.ts`.
- `src/ui/` — thin Obsidian modals/settings; no logic worth testing.
- `src/main.ts` — plugin shell; the only file that touches non-public API (`app.plugins`), typed via the local `CommunityPluginRegistry` interface.

## Template upstream

The repo's git history is rooted at `obsidianmd/obsidian-sample-plugin` (remote `template`); toolchain files are vendored from it. To pull upstream updates: `git fetch template && git merge template/master`. Conflict rules: toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/styles.css/.gitignore) take theirs; identity files (manifest.json, package.json name/author/license, versions.json) and `src/`/`tests/` stay ours; tsconfig takes theirs plus `tests/**/*.ts` re-added to `include`.

## Smoke testing

`dev/vault/` (gitignored) is a disposable Obsidian vault for CLI-driven smoke tests. Install the current build with `npm run smoke:install`, then drive the RUNNING app with the official CLI (`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`):

- `vaults verbose` lists registered vaults; target one with `vault=<folder-basename>`.
- `command id=obsidian-config-sync:<publish|apply|revert-last-apply|import-from-external>` runs commands; `plugin:reload id=obsidian-config-sync` reloads a dev build; `dev:errors` shows console errors; `dev:mobile on` emulates mobile; `dev:dom` / `dev:screenshot` inspect UI.
- Drive modals via `eval code=...`: `document.querySelectorAll('.modal .checkbox-container')[i].click()` toggles, find buttons by textContent (e.g. Continue), `.modal-close-button` closes reports, `.suggestion-item` picks in fuzzy modals.
- **Vault registration is human-only**: Obsidian rebuilds its vault registry from internal state at startup, pruning injected entries; the CLI cannot register or open new vaults. A human must "Open folder as vault" + Trust once — afterwards CLI automation is fully autonomous. CLI calls against a stale vault hang (~2 min).
- Never smoke-test in a real vault.

## Rules

- Store path mapping and the blacklist live in `core/pathing.ts` / `core/manifest.ts` — change them only with matching spec + test updates.
- Errors must carry context (group name, path, git command). No silent fallback.
- Test in a dedicated dev vault, never in a real vault.
