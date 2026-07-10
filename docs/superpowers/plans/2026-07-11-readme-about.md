# README Rewrite + GitHub About Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite README.md for the community-directory audience (badges, screenshots, features, current 0.11.0 behavior), add a Chinese mirror README.zh.md, capture three screenshots from the dev vault, and fill the empty GitHub About fields.

**Architecture:** Docs/metadata only — zero plugin code. Screenshots are staged and captured live via obsidian-cli against the dev vault (with a mandatory vault-identity guard before every command batch). The English README text is given verbatim in Task 2; the Chinese version translates it. About is set via `gh repo edit`.

**Tech Stack:** Markdown, obsidian-cli (`eval`, `dev:screenshot`), GitHub CLI.

## Global Constraints

- Gate for every task: `npm test` && `npm run build` && `npm run lint` — must stay green (docs-only diffs; the gate guards against accidental code edits).
- **Vault-identity guard:** before ANY obsidian-cli batch, run `eval vault=vault code="app.vault.getName()"` and require the answer `vault`. If it is anything else (the CLI falls back to another open window when the dev vault is closed), STOP — run `open "obsidian://open?vault=vault"`, wait 5 s, re-check. Never run staging/cleanup commands against a vault whose name is not `vault`.
- The English README (Task 2) is canonical; README.zh.md is a faithful translation, no divergent content.
- Every behavioral claim must match 0.11.0 (no Lock all/Unlock all; Discovered uses toggles with fixed name/path; Status/menu counts exist; blacklist includes both plugin ids).
- Commit messages: plain conventional-commit style, no Claude attribution / no Claude-Session trailer.
- Do not modify anything under `src/`, `tests/`, or config files.

---

### Task 1: Screenshots

**Files:**
- Create: `docs/assets/settings-picker.png`, `docs/assets/status-modal.png`, `docs/assets/apply-picker.png`

**Interfaces:** Produces the three asset paths Task 2/3 reference.

Notes: `dev:screenshot vault=vault` prints a temp PNG path (contains spaces — quote it). The dev vault has ~2 community plugins, so the picker screenshot uses the **Obsidian** tab (well-populated) — accepted deviation from the spec's "Community plugins tab" recorded here. CLI path: `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli` (export as `$CLI`).

- [ ] **Step 1: Identity guard + stage drift states**

```bash
CLI=/Applications/Obsidian.app/Contents/MacOS/obsidian-cli
timeout 20 $CLI eval vault=vault code="app.vault.getName()"   # MUST print => vault
```

Then stage (creates snippets=local-changed, hotkeys=store-newer; app/appearance stay in-sync):

```bash
timeout 30 $CLI eval vault=vault code="const a = app.vault.adapter; a.write('.obsidian/snippets/screenshot-demo.css', 'body{}').then(() => a.read('config-sync/store/configdir/hotkeys.json')).then(c => a.write('config-sync/store/configdir/hotkeys.json', c.trim() === '{}' ? '{\"demo\":1}' : '{}')).then(() => 'staged')"
```

- [ ] **Step 2: Capture the settings picker**

```bash
timeout 30 $CLI eval vault=vault code="app.setting.open(); app.setting.openTabById('config-sync'); new Promise(r => setTimeout(() => { Array.from(document.querySelectorAll('.config-sync-tab'))[1].click(); setTimeout(() => r('obsidian-tab'), 400); }, 500))"
timeout 30 $CLI dev:screenshot vault=vault
```

Copy the printed path: `mkdir -p docs/assets && cp "<printed path>" docs/assets/settings-picker.png`

- [ ] **Step 3: Capture the Status modal**

```bash
timeout 30 $CLI eval vault=vault code="app.setting.close(); app.commands.executeCommandById('config-sync:status'); new Promise(r => setTimeout(() => r(Array.from(document.querySelectorAll('.config-sync-status-row')).length + ' rows'), 1000))"
timeout 30 $CLI dev:screenshot vault=vault
cp "<printed path>" docs/assets/status-modal.png
timeout 30 $CLI eval vault=vault code="document.querySelectorAll('.modal-close-button').forEach(b=>b.click()); 'closed'"
```

Expect the rows to include `↑ changed on this device (likely)` (snippets) and `↓ store is newer (likely)` (hotkeys) before shooting — if all rows read in-sync, re-check Step 1 staging.

- [ ] **Step 4: Capture the Apply picker**

```bash
timeout 30 $CLI eval vault=vault code="app.commands.executeCommandById('config-sync:apply'); new Promise(r => setTimeout(() => r('open'), 1200))"
timeout 30 $CLI dev:screenshot vault=vault
cp "<printed path>" docs/assets/apply-picker.png
timeout 30 $CLI eval vault=vault code="document.querySelectorAll('.modal-close-button').forEach(b=>b.click()); 'closed'"
```

- [ ] **Step 5: Clean up the staging**

```bash
timeout 30 $CLI eval vault=vault code="const a = app.vault.adapter; a.remove('.obsidian/snippets/screenshot-demo.css').then(() => 'cleaned')"
timeout 30 $CLI eval vault=vault code="app.commands.executeCommandById('config-sync:capture'); new Promise(r => setTimeout(() => { document.querySelectorAll('.modal-close-button').forEach(b=>b.click()); r('recaptured'); }, 2000))"
timeout 30 $CLI eval vault=vault code="app.commands.executeCommandById('config-sync:status'); new Promise(r => setTimeout(() => { const bad = Array.from(document.querySelectorAll('.config-sync-status-row')).filter(x => !x.textContent.includes('in sync')).length; document.querySelectorAll('.modal-close-button').forEach(b=>b.click()); r(bad + ' non-in-sync rows'); }, 1000))"
```

Expected final check: `0 non-in-sync rows`. Verify the three PNGs are non-trivial (`ls -la docs/assets/` — each > 50 KB typically) and visually contain what they should (open with Read tool to view).

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: green (nothing code-touching changed).

```bash
git add docs/assets/
git commit -m "docs: settings, status and apply-picker screenshots"
```

---

### Task 2: README.md rewrite

**Files:**
- Modify: `README.md` (full replacement)

**Interfaces:** Consumes the three asset paths from Task 1. Produces the canonical text Task 3 translates.

- [ ] **Step 1: Replace README.md with exactly this content**

````markdown
# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)

**English** · [中文](README.zh.md)

Selective, on-demand sync of Obsidian settings — hotkeys, CSS snippets, themes, plugin configs — across devices and vaults. The data rides your existing note sync (remotely-save, Obsidian Sync, iCloud…) by default, or config-sync's own git / vault remotes. Nothing ever lands on a device without an explicit **Apply**.

![Settings picker](docs/assets/settings-picker.png)

## Features

- **Pick exactly what syncs** — Obsidian options, core-plugin and community-plugin settings, snippets, themes, vault-root dotfiles; per item, per device class (all / desktop / mobile).
- **Credential-safe** — `sanitize` key globs strip tokens and secrets before anything enters the store; each device keeps its locally entered values across applies.
- **Explicit, reversible Apply** — pick groups, see version-mismatch warnings, land them; every touched file is backed up and **Revert last apply** restores it.
- **Know what's in sync** — the **Status** view badges every group (`✓ in sync`, `↑ changed on this device`, `↓ store is newer`, `— not captured`), the sync menu shows change counts, and the Apply picker pre-selects what the store updated.
- **Remote-aware** — check whether a git or vault remote was captured after your local store; Pull/Push on demand (desktop).
- **Mobile-friendly** — capture, apply and status all work on phones; the store is plain vault content, so any note sync carries it.

## Install

From Obsidian: **Settings → Community plugins → Browse**, search **Config Sync**, install and enable.

Beta builds: via [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `xooooooooox/obsidian-config-sync`.

## Quick start

1. **Settings → Config Sync** — tick what you want to sync (Obsidian / Core plugins / Community plugins tabs).
2. Run **Capture: save this device's settings** (ribbon menu or command palette).
3. On another device, once your note sync has delivered the data folder: **Apply: update this device with synced settings**.

## How it works

Two planes, kept separate.

**Local plane** — this device's live config ↔ the store:

- **Capture** copies the groups defined in `<data folder>/config-sync.json` into `<data folder>/store/`, strips `sanitize`d keys, skips OS junk files, and records source plugin versions in `store.lock.json`.
- **Apply** picks groups, warns on plugin-version mismatches, then lands them into this device's config dir (whatever its name). Sanitized keys keep their local values. A one-slot backup covers every touched file; **Revert last apply** restores it.
- **Status** compares live config against the store per group, with best-effort direction hints (file times vs the last capture) and on-demand remote freshness checks.

**Transport plane** — how the store travels:

- **Your note sync (default)**: the store is plain vault content — remotely-save, Obsidian Sync, iCloud or anything else carries it everywhere, mobile included, zero configuration.
- **Pull / Push (desktop, optional)**: config-sync's own transport for a git repo or another vault on this machine. Pull overwrites this vault's store from a remote (repeatable — cold start and ongoing use are the same command); Push sends it out. The git transport clones to a temp dir and never touches your vault's own repo.

Everything hangs off one **Config Sync** ribbon icon that opens a menu of the currently available actions, with change counts when there's something to do (e.g. `Capture (2 changed here)`). Individual ribbon icons per command are available under **Settings → General**, off by default.

![Status](docs/assets/status-modal.png)

## Settings guide

- **General** — PKM mode (auto-detects IOTO vaults), the data folder location, status toggles (menu change counts, Apply-picker badges), ribbon icons.
- **Obsidian / Core plugins / Community plugins** — tick items to sync them; a heading toggle syncs all/none per section; a search box spans all tabs. `workspace.json` and the `sync`/`publish` core plugins are *Not recommended* and ask for confirmation.
- **Advanced** — every rule as a compact row; expand to edit. **Managed by pickers** (created by ticks; reset to default per row or in bulk), **Discovered files** (config files we couldn't classify; toggle to sync — name and path are fixed by the file), **Custom rules** (fully yours: vault-root files, extra folders, sanitize patterns).
- **Remotes** (desktop) — add a **git repository** (URL, branch, optional folder) or **another vault**: click **Browse…**, pick the vault folder, and the store inside it is auto-detected.

![Apply picker](docs/assets/apply-picker.png)

## Store layout

```
<data folder>/               # default "config-sync", configurable
├── config-sync.json         # group definitions (yours to edit)
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/… (device-independent)
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

`config-sync.json` example:

```json
{
  "$schema": "https://raw.githubusercontent.com/xooooooooox/obsidian-config-sync/main/schema/config-sync.schema.json",
  "version": 1,
  "groups": [
    { "name": "snippets", "path": "{configDir}/snippets", "type": "dir", "devices": "all" },
    { "name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all" },
    { "name": "vimrc", "path": ".obsidian.vimrc", "type": "file", "devices": "desktop" },
    { "name": "plugin-ioto-settings", "path": "{configDir}/plugins/ioto-settings/data.json",
      "type": "file", "devices": "all",
      "sanitize": ["*ForSync", "*ForFetch", "*APIKey*", "*Token*", "*Secret*", "userEmail"] }
  ]
}
```

Group fields: `name` (unique) · `path` (`{configDir}` variable supported) · `type` (`file`/`dir`) · `devices` (`all`/`desktop`/`mobile`) · `sanitize` (optional key-glob list, file groups only).

Never syncable (hard blacklist): the `remotely-save`, `ioto-update`, `slides-rup`, `config-sync` and `obsidian-config-sync` plugin dirs. OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never captured.

## Walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys**, **Appearance**, **CSS snippets**.
2. Run **Capture: save this device's settings**.
3. On each other device, run **Apply: update this device with synced settings** once your note sync has delivered the data folder.

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, tick the plugin.
2. Open *Advanced* — expand the rule the tick created and add sanitize patterns for its credential keys, e.g. `*Token*, *Secret*, *APIKey*`.
3. Capture. Credentials never enter the store; each device keeps its locally entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Capture, and let remotely-save carry it; other devices Apply.

**Seed a second vault from another one, without a shared note sync (desktop)**
1. In the target vault: Settings → Config Sync → **Remotes** → add a remote of type **Another vault**, click **Browse…** and pick the source vault's folder — its store is auto-detected into **Store path** (or add a git remote: URL + branch, optionally a folder in the repo).
2. Run **Pull: get settings from a remote**, then **Apply: update this device with synced settings**.
3. Later, from the source vault, **Push: send settings to a remote** publishes updates for the other vault to pull.

## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note sync moves them between devices. Two **optional, desktop-only** remote features go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (vault remotes and git temp clones).** If you add a remote of type "Another vault", Pull/Push read/write the absolute store path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.

Both features are disabled until you configure a remote, and never run without an explicit Pull or Push command.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

Develop against a dedicated test vault (never a real one).

## Releasing

1. `npm version <x.y.z>` — bumps `manifest.json` + `versions.json` (via `version-bump.mjs`), commits, and tags.
2. `git push --follow-tags`
3. The "Release Obsidian plugin" workflow builds, attests build provenance, and creates a **draft** GitHub release with `main.js`, `manifest.json`, `styles.css`.
4. Publish the draft on GitHub — the directory and BRAT only see published releases.

## License

[MIT](LICENSE)
````

- [ ] **Step 2: Verify claims against the live plugin**

Spot-check in the dev vault (identity guard first): the Status badges' wording, the menu-count format, the Advanced sections' names, the General-tab toggle names — each appears in the README exactly as the UI shows it. Fix any mismatch in the README (the UI is the truth).

- [ ] **Step 3: Gate + commit**

Run: `npm test && npm run build && npm run lint`
Expected: green.

```bash
git add README.md
git commit -m "docs: rewrite README for the community-directory audience"
```

---

### Task 3: README.zh.md

**Files:**
- Create: `README.zh.md`

**Interfaces:** Consumes the committed `README.md` (read it from the repo — it is the single source).

- [ ] **Step 1: Translate**

Create `README.zh.md`: a faithful, complete Chinese translation of `README.md`, same section order and images. Header block differs only in the language line: `[English](README.md) · **中文**`. Terminology rules:

- Command, tab, and button names stay in English exactly as the UI shows them (**Capture**, **Apply**, **Pull**, **Push**, **Status**, **Browse…**, tab names General/Obsidian/Core plugins/Community plugins/Advanced/Remotes), optionally followed by a short Chinese gloss on first use, e.g. “**Capture**(捕获本机设置)”.
- `store` → “store(配置存储)” on first use, then “store”。`group`/rule → “规则”。`sanitize` → “sanitize(脱敏)”。`data folder` → “数据文件夹”。`note sync` → “笔记同步工具”。
- Keep all code blocks, JSON, paths, and badge/image markup identical to the English file.

- [ ] **Step 2: Cross-link check + gate + commit**

Verify both language links resolve (`README.md` ↔ `README.zh.md`), images render from the zh file (same relative paths).

Run: `npm test && npm run build && npm run lint`
Expected: green.

```bash
git add README.zh.md
git commit -m "docs: Chinese README"
```

---

### Task 4: GitHub About

**Files:** none (repo metadata).

- [ ] **Step 1: Set description, homepage, topics**

```bash
gh repo edit --description "Selective, on-demand sync of Obsidian settings — hotkeys, snippets, plugin configs — across devices and vaults. Rides your note sync, or git/vault remotes." --homepage "https://community.obsidian.md/plugins/config-sync"
gh repo edit --add-topic obsidian --add-topic obsidian-plugin --add-topic settings-sync --add-topic sync --add-topic configuration
```

- [ ] **Step 2: Verify**

```bash
gh repo view --json description,homepageUrl,repositoryTopics --jq '{desc: .description, home: .homepageUrl, topics: [.repositoryTopics[]?.name]}'
```

Expected: the three fields exactly as set. No commit (nothing in-tree changed); no gate needed beyond confirming `git status` is clean.

---

## Verification after all tasks

1. `git status` clean; gate green.
2. GitHub rendering: README shows badges, three images, working 中文/English cross-links (check after push).
3. `gh repo view` shows description/homepage/topics.
4. README claims match the 0.11.0 UI (Task 2 Step 2's spot-check).
