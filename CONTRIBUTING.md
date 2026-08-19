# Contributing

Development workflow for obsidian-config-sync. Architecture and invariants live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the UI design system in
[docs/design/DESIGN.md](docs/design/DESIGN.md); agent-facing rules in [CLAUDE.md](CLAUDE.md).

## Setup & commands

```bash
npm install
npm run dev            # esbuild watch → main.js
npm run build          # tsc -noEmit + production bundle — run before finishing any change
npm test               # vitest (tests/external.test.ts needs the git binary)
npm run lint           # eslint
npm run smoke:install  # build and install into ./dev/vault (see Smoke testing)
```

- **Lint ceiling:** 0 errors / 58 warnings. Never add inline `eslint-disable`; product-term
  sentence-case exceptions go through `ignoreWords` in `eslint.config.mts`. CI lints every
  commit on all branches.
- **Color gate:** `./scripts/check-no-hardcoded-color.sh` must pass — all CSS uses Obsidian
  theme variables (a release gate; see DESIGN.md).

## Testing strategy

- Unit tests are `vitest` over the pure core (`src/core/`), against an in-memory `FileIO`
  and a fake `PluginHost` — no mocks of external services, real shapes throughout.
- The schema files under `schema/` are gated by `tests/schemaFiles.test.ts` against the
  producers in code; a persisted-shape change updates the schema first (schema-first rule,
  CLAUDE.md).
- **Never develop or test against a real vault.**

## Smoke testing (dev vault)

`dev/vault/` (gitignored) is a disposable Obsidian vault for CLI-driven smoke tests.
Install the current build with `npm run smoke:install`, then drive the RUNNING app with the
official CLI (`obsidian-cli`, shipped inside the Obsidian app bundle):

- `vaults verbose` lists registered vaults; target one with `vault=<folder-basename>`. The
  CLI routes by CWD — run it from `dev/vault/`.
- `command id=config-sync:sync` opens the Sync Center (the only registered command);
  `plugin:reload id=config-sync` reloads a dev build; `dev:errors` shows console errors;
  `dev:mobile on` emulates mobile; `dev:dom` / `dev:screenshot` inspect UI.
- Drive the UI via `eval code=...`: tick `.config-sync-*` checkboxes and click buttons by
  textContent; run reports render as the pinned result strip. Modals (Stop syncing, conflict,
  folder picker) use `.modal` selectors.
- **Vault registration is human-only**: Obsidian rebuilds its vault registry from internal
  state at startup, pruning injected entries. A human must "Open folder as vault" + Trust
  once — afterwards CLI automation is fully autonomous. CLI calls against a stale vault
  hang (~2 min).
- A UI change is never "style-only": render functions carry event wiring. Before shipping a
  UI diff, click every control the diff touched in the dev vault; `npm test` alone proves
  nothing about a click path.

## Template upstream

The repo's git history is rooted at `obsidianmd/obsidian-sample-plugin` (remote
`template`); toolchain files are vendored from it. To pull upstream updates:
`git fetch template && git merge template/master`. Conflict rules:

- toolchain files (esbuild/eslint/version-bump/.npmrc/.editorconfig/.gitignore): take theirs
- identity files (`manifest.json`, `package.json` name/author/license, `versions.json`),
  `styles.css` (plugin-owned styles), `src/`, `tests/`, `AGENTS.md`, `CLAUDE.md`, docs: keep ours
- `tsconfig.json`: take theirs, then re-add `tests/**/*.ts` to `include`

## Documentation currency

When a change alters user-facing behavior (features, UI, commands, settings, workflows),
update the affected docs in the SAME branch:

- `README.md` **and** `README.zh.md` (keep the two in sync)
- `docs/GUIDE.md` — the user guide; behavioral detail lives there, not in the READMEs
- `docs/ARCHITECTURE.md` — code map / invariants, when structure changes
- `docs/design/DESIGN.md` — before any UI change (design-first)
- `schema/*.schema.json` — before any persisted-shape change (schema-first)
- `CHANGELOG.md` — at release time, one entry per version (see Releasing)
- `UPGRADING.md` — only when a release asks the user to act before syncing again

Version history goes in those last two and nowhere else: the docs above state how the plugin
behaves now, not how it got there.

Pure internal refactors that change nothing a user sees need no doc edit. Gate: docs must
be current before merging to `main` and before cutting a release.

Written artifacts (docs, commit messages, PR text) carry no real personal paths, hostnames,
or identifiers — write `~/path` and `<host>`-style placeholders instead.

## Releasing

1. Write the release's `CHANGELOG.md` entry first, at the top: a bare `## x.y.z` heading and
   flat `-` bullets, each opening with `Added` / `Fixed` / `Improved` / `Changed` / `Removed`.
   No dates, no sub-bullets, no category headings.
2. `npm version <x.y.z>` — bumps `manifest.json`/`versions.json`, commits, tags (tag has no
   leading `v`).
3. `git push --follow-tags` — CI builds a **draft** GitHub release with the three assets
   (`main.js`, `manifest.json`, `styles.css`).
4. The release body is that changelog entry (never auto-generated); the release title is the
   bare version number.
5. Publish the draft — the community directory and BRAT only see published releases.

A release that changes a persisted format also writes an `UPGRADING.md` entry, and its
release body links there. What belongs in that entry — the update order, and any behavior
that differs after the migration — is set out in `docs/ARCHITECTURE.md`'s closing section.
