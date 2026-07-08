# CLAUDE.md

Obsidian plugin: selective config distribution across devices/vaults. Spec: `docs/superpowers/specs/2026-07-08-obsidian-config-sync-design.md` (design decisions D1–D7 explain every non-obvious choice — read it before structural changes).

## Commands

- `npm run dev` — esbuild watch → `main.js`
- `npm run build` — `tsc -noEmit` + production bundle (run before finishing any change)
- `npm test` — vitest; `tests/external.test.ts` needs the `git` binary
- `npm run smoke:install` — build and install the plugin into `./dev/vault` (gitignored copy of a test vault)

## Architecture

- `src/core/` — pure functions; ALL file I/O via the `FileIO` interface (`app.vault.adapter` in prod, `tests/memfs.ts` in tests). **Never import Node APIs here — core must run on mobile.**
- `src/external/` — the only place Node `fs`/`child_process` are allowed; loaded exclusively via dynamic `import()` from desktop-gated code in `main.ts`.
- `src/ui/` — thin Obsidian modals/settings; no logic worth testing.
- `src/main.ts` — plugin shell; the only file that touches non-public API (`app.plugins`), typed via the local `CommunityPluginRegistry` interface.

## Template upstream

The repo's git history is rooted at `obsidianmd/obsidian-sample-plugin` (remote `template`); toolchain files are vendored from it. To pull upstream updates: `git fetch template && git merge template/master`. Conflict rules: toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/styles.css/.gitignore) take theirs; identity files (manifest.json, package.json name/author/license, versions.json) and `src/`/`tests/` stay ours; tsconfig takes theirs plus `tests/**/*.ts` re-added to `include`.

## Smoke testing

`dev/vault/` (gitignored) is a disposable Obsidian vault for manual/CLI smoke tests. Install the current build with `npm run smoke:install`, open the vault in Obsidian, then drive it with the official CLI (`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`): `plugin:reload id=obsidian-config-sync`, `command id=obsidian-config-sync:publish` (also `:apply`, `:revert-last-apply`, `:import-from-external`), `eval code=...` for assertions, `dev:errors` for console errors. Never smoke-test in a real vault.

## Rules

- Store path mapping and the blacklist live in `core/pathing.ts` / `core/manifest.ts` — change them only with matching spec + test updates.
- Errors must carry context (group name, path, git command). No silent fallback.
- Test in a dedicated dev vault, never in a real vault.
