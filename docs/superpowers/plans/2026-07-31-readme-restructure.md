# README Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split README into a ~70-line bilingual landing page plus a single English user guide (`docs/GUIDE.md`) that holds every behavioral detail, with one error-message string retargeted and both README screenshots recaptured.

**Architecture:** Content-preserving docs refactor. Task 1 creates GUIDE.md from the current README (so nothing is lost), Task 2 replaces README.md with the landing page drafted verbatim below, Task 3 mirrors it into README.zh.md line-for-line, Task 4 retargets the one code string that points at a README section. Screenshots are recaptured by the controller inline (Task 5), not by a subagent.

**Tech Stack:** Markdown; one TypeScript string + vitest assertion.

## Global Constraints

- **NO-COMMITS mode**: the working tree is the review state; nothing is committed by any task. One commit happens at cut, by the controller, on explicit user request.
- No Claude/AI attribution anywhere.
- Docs record **current state only** — never "no more", "anymore", "the old X is now", "moved to", "not just … anymore". (Quoted UI strings are exempt.)
- Each fact expands in exactly one place: README gets at most one sentence per fact; GUIDE holds the expansion.
- `README.md` and `README.zh.md` must end with **identical line counts** (`wc -l`).
- All copy in English except README.zh.md prose; UI strings quoted exactly as rendered.
- Spec: `docs/superpowers/specs/2026-07-31-readme-restructure-design.md`.
- Gates after the code task and at the end: `npm test` (814 tests), `npm run build`, `npm run lint` (0 errors / 57-warning baseline).

---

### Task 1: Create `docs/GUIDE.md`

**Files:**
- Create: `docs/GUIDE.md`
- Read (source material, do not modify): `README.md` (repo root, 175 lines)

**Interfaces:**
- Produces: `docs/GUIDE.md` with EXACTLY these `##` headings, in this order —
  `## Concepts`, `## The Sync Center`, `## Settings`,
  `## Field rules & sensitive settings`, `## Transport`,
  `## Status bar & ribbon`, `## Walkthroughs`.
  Task 2's README links depend on the derived anchors:
  `#concepts`, `#the-sync-center`, `#settings`,
  `#field-rules--sensitive-settings`, `#transport`, `#status-bar--ribbon`,
  `#walkthroughs`, and one `###` sub-heading inside The Sync Center:
  `### Availability sections and the install engine`
  (anchor `#availability-sections-and-the-install-engine`). Do not rename any of
  these headings.

- [ ] **Step 1: Read the source README end to end** (`README.md`, all 175 lines). Every behavioral fact in it must survive into GUIDE.md except the sections the spec keeps in README (pitch, features one-liners, install, quick start, security & privacy, development, license).

- [ ] **Step 2: Write `docs/GUIDE.md`** with this skeleton and content mapping (line numbers refer to the current `README.md`):

```markdown
# Config Sync — User Guide

Every behavior in one place; the [README](../README.md) is the 5-minute version.

- [Concepts](#concepts)
- [The Sync Center](#the-sync-center)
- [Settings](#settings)
- [Field rules & sensitive settings](#field-rules--sensitive-settings)
- [Transport](#transport)
- [Status bar & ribbon](#status-bar--ribbon)
- [Walkthroughs](#walkthroughs)

## Concepts
<!-- from lines 43-51: the two planes and the per-device baseline;
     from lines 96-108: the store layout code block and surrounding text -->

## The Sync Center
<!-- from lines 23 (awareness bullet), 82 (header chip / this-device pane),
     80 (result strip + History), 84 (search + full qualifier table),
     24 (where-it-runs menu) -->

### Availability sections and the install engine
<!-- from lines 53-71 in full: section list, On-apply choice table,
     version pinning, catalog fallback, staged-config semantics,
     bulk-install failure isolation, ahead-of-store metadata line -->

## Settings
<!-- from lines 88-94: General bullet; card anatomy; Advanced; Remotes.
     Split the 400-word drawer paragraph (line 92) into three sub-headings:
     #### Enabled on   #### Settings file   #### Companion folders
     each rewritten as short paragraphs + bullets, not one run-on block -->

## Field rules & sensitive settings
<!-- from lines 141-153: {scope, encrypted} semantics, per-item scopes,
     whole-file vs per-key mode, passphrase & keychain, locked state,
     sensitive-key detection, File-preview color legend -->

## Transport
<!-- from lines 73-76: note-sync default, fresh-device Adopt flow and
     pre-adopt banner; Pull/Push remotes, git temp clone, repeatable pull;
     from line 27: remote freshness checks, per-file diff drill-down,
     "Pull never removes files" -->

## Status bar & ribbon
<!-- from lines 25 and 78: status-bar item, per-remote counts, opt-in
     ribbon dot, mobile force-show, the single ribbon menu, individual
     Sync Center ribbon icon, Ribbon Organizer pointer -->

## Walkthroughs
<!-- lines 110-130: all four walkthroughs, formatting tidied -->
```

Structural rules while migrating:
- Prefer lists over prose for enumerable behavior (qualifier keys, On-apply choices, scope glyphs, legend colors). The qualifier table, the On-apply choices and the availability sections stay complete — no summarizing away of rules.
- Break any paragraph longer than ~6 lines into bullets or sub-headings.
- Keep every literal UI string, keyboard interaction, and file path exactly as the source has it.

- [ ] **Step 3: Apply these exact changelog-phrase rewrites** (source sentence → GUIDE sentence). These are the only sentences that change meaning-carrying words; everything else is reorganized, not reworded:

| Source (line) | Write instead |
|---|---|
| "No more separate "Enabled community plugins" / "Enabled core plugins" rows — a plugin's on/off state lives on its own card." (18) | "A plugin's on/off state lives on its own card, in its **Enabled on** zone." |
| "The old ribbon-icon dot is now opt-in (off by default), and a mobile-only toggle can force Obsidian's hidden status bar visible on phones." (25) | "The ribbon icon's status dot is opt-in (off by default); a mobile-only toggle can force Obsidian's hidden status bar visible on phones." |
| "Quick commands moved to the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin." (78) | "Quick commands live in the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin." |
| "There is no hand-edited rule file anymore — what syncs, and each field's `{scope, encrypted}` rule, is configured entirely through…" (108) | "What syncs, and each field's `{scope, encrypted}` rule, is configured entirely through…" (rest of sentence unchanged) |
| "There is no hard blacklist anymore — `remotely-save`, `ioto-update`, `slides-rup` and `config-sync` are now normal items like any other (e.g. …)." (153) | "Every plugin — including `remotely-save`, `ioto-update`, `slides-rup` and `config-sync` itself — is a normal item like any other (e.g. …)." (keep the examples) |
| Breaking-upgrade banner (12) — dropped from README | Add one sentence at the end of the Concepts store-layout text: "The store format and settings schema are `schemaVersion: 2`; installs older than that have no migration path — upgrade every device together, then re-tick what to sync before capturing or applying again." |

- [ ] **Step 4: Self-check the result**

Run: `grep -inE "no more|anymore|is now opt-in|moved to|not .* anymore" docs/GUIDE.md`
Expected: no matches (or only matches inside quoted UI strings — there are none expected).

Run: `grep -n "^## \|^### Availability" docs/GUIDE.md`
Expected: the seven `##` headings in the exact order above plus the `### Availability sections and the install engine` line.

- [ ] **Step 5: No commit** — NO-COMMITS mode; leave the file in the working tree.

---

### Task 2: Rewrite `README.md` + CLAUDE.md docs-currency bullet

**Files:**
- Modify: `README.md` (full replacement)
- Modify: `CLAUDE.md` (one bullet, "Documentation currency" around line 44)

**Interfaces:**
- Consumes: the GUIDE anchors produced by Task 1 (`docs/GUIDE.md#the-sync-center`, `#settings`, `#field-rules--sensitive-settings`, `#transport`, `#availability-sections-and-the-install-engine`, `#walkthroughs`).
- Produces: the new `README.md` — Task 3 translates it line-for-line.

- [ ] **Step 1: Replace the entire contents of `README.md`** with exactly this (no edits, no additions):

````markdown
<p align="center"><img src="assets/logo.svg" width="96" alt="Config Sync logo"></p>

# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)
[![Static Badge](https://img.shields.io/badge/README-EN-blue)](./README.md)
[![Static Badge](https://img.shields.io/badge/README-中-red)](./README.zh.md)

Selective, on-demand sync of Obsidian settings — hotkeys, CSS snippets, themes, plugin configs — across devices and vaults. The data rides your existing note sync (remotely-save, Obsidian Sync, iCloud…) by default, or config-sync's own git / vault remotes. Nothing ever lands on a device without an explicit **Apply** from the Sync Center.

![Sync Center](docs/assets/sync-panel.png)

## Features

- **One card per item** — every synced thing (an Obsidian option group, a core or community plugin, a snippet) is one row with an expandable drawer holding its rules; a plugin's on/off state lives on its own card. ([details](docs/GUIDE.md#settings))
- **Orthogonal field rules** — every key carries a `{scope, encrypted}` pair (`All devices` / `Desktop only` / `Mobile only` / `This device`), and string-array keys can scope each element on its own. ([details](docs/GUIDE.md#field-rules--sensitive-settings))
- **Credential-safe** — `This device` keys never leave the machine, and a per-device passphrase encrypts what should travel.
- **Explicit Apply** — nothing changes a device until you tick items and press Apply; every run stays visible in the pinned result strip and a browsable **History**.
- **A Sync Center that knows the state** — per-item state badges, normalized JSON diffs, a *this device* status chip and totals for every pending action. ([tour](docs/GUIDE.md#the-sync-center))
- **Install engine** — plugins that are outdated, disabled or missing on this device can be updated, enabled or installed during Apply, pinned to the captured version. ([rules](docs/GUIDE.md#availability-sections-and-the-install-engine))
- **Remotes (desktop)** — pull/push the store against a git repo or another vault, with per-file diff previews. ([details](docs/GUIDE.md#transport))
- **Search everywhere** — both search boxes accept `key:value` qualifiers with autocomplete, combined freely with plain text.
- **Status bar** — ↑ capture / ↓ apply plus per-remote ⇡ push / ⇣ pull counts at a glance; click opens the Sync Center.
- **Mobile-friendly** — capture, apply and the Sync Center work on phones; the store is plain vault content, so any note sync carries it.

## Install

From Obsidian: **Settings → Community plugins → Browse**, search **Config Sync**, install and enable.

Beta builds: via [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `xooooooooox/obsidian-config-sync`.

## Quick start

1. **Settings → Config Sync** — tick what you want to sync (Obsidian / Core plugins / Community plugins / Beta tabs).
2. Open **Sync Center** from the ribbon menu (or the **Open Sync Center** command), tick what to capture, and press **Capture N items**.
3. On another device, once your note sync has delivered the data folder: open **Sync Center**, tick what to apply, and press **Apply N items**.

![Settings picker](docs/assets/settings-picker.png)

## How it works

Two planes, kept separate.

- **Local plane** — **Capture** copies every enabled item's settings files and companion folders into the store, applying each field's `{scope, encrypted}` rule; **Apply** lands the items you tick into this device's config dir. Direction (↑ capture, ↓ apply) comes from a per-device sync baseline, not file times, so the Sync Center can tell which side actually moved.
- **Transport plane** — by default the store is plain vault content and rides your note sync; a fresh device discovers an arriving store on its own and offers an **Adopt** guide. Optionally (desktop), Pull/Push move the store against a git repo or another vault from the Sync Center's Remotes block.

The full tour — Sync Center anatomy, field rules, encryption, the install engine, remotes, walkthroughs — lives in the **[user guide](docs/GUIDE.md)**.

## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note sync moves them between devices. Two **optional, desktop-only** remote features go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (vault remotes and git temp clones).** If you add a remote of type "Another vault", Pull/Push read/write the absolute store path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.

Both features are disabled until you configure a remote, and never run without an explicit Pull or Push from the Sync Center.

## Documentation

- **[User guide](docs/GUIDE.md)** — every behavior in one place: the Sync Center, field rules, sensitive settings, transport, walkthroughs.
- **[Architecture](docs/ARCHITECTURE.md)** — code map and invariants, for contributors.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

Develop against a dedicated test vault (never a real one).

## License

[MIT](LICENSE)
````

- [ ] **Step 2: Update the docs-currency bullet in `CLAUDE.md`.** Find the bullet starting `- Documentation currency:` and change the file list `` `README.md` and `README.zh.md` (keep the two in sync) `` to `` `README.md` and `README.zh.md` (keep the two in sync), `docs/GUIDE.md` (the user guide — behavioral detail lives there, not in the READMEs) ``. Leave the rest of the bullet untouched.

- [ ] **Step 3: Verify anchors resolve.**

Run: `grep -oE "GUIDE\.md#[a-z-]+" README.md | sort -u`
Expected: exactly `GUIDE.md#availability-sections-and-the-install-engine`, `GUIDE.md#field-rules--sensitive-settings`, `GUIDE.md#settings`, `GUIDE.md#the-sync-center`, `GUIDE.md#transport`.
For each, confirm the matching heading exists in `docs/GUIDE.md` (see Task 1 Interfaces).

Run: `grep -inE "no more|anymore|is now|moved to" README.md`
Expected: no matches.

- [ ] **Step 4: No commit** — NO-COMMITS mode.

---

### Task 3: Rewrite `README.zh.md` line-parallel

**Files:**
- Modify: `README.zh.md` (full replacement)
- Read: `README.md` (the new one from Task 2 — the translation source), and the pre-change `README.zh.md` via `git show HEAD:README.zh.md` (terminology reference only)

**Interfaces:**
- Consumes: the new `README.md` from Task 2, translated line-for-line.

- [ ] **Step 1: Translate the new `README.md` into `README.zh.md`, strictly line-parallel** — line N of README.zh.md corresponds to line N of README.md; blank lines, image lines, badge lines, code blocks and the license line stay byte-identical except where noted. Translation conventions (match the voice of `git show HEAD:README.zh.md`):
  - Keep product/UI terms in English: Config Sync, Sync Center, Capture, Apply, Pull, Push, store, scope, `{scope, encrypted}`, This device, Desktop only, Mobile only, All devices, History, Adopt, BRAT, remote(s) 可写作 remote/远程.
  - Chinese em-dash style `——` where the English uses ` — ` inside sentences; bullet leads stay `- **英文或中文粗体** —— …` matching the old file's pattern.
  - First mention of note sync as `笔记同步工具(note sync)`, as the old file does.
  - The two badge switcher lines, both image lines, the heading lines' `##` markers, and the Development code block stay as in README.md; headings translate (`## Features` → `## 功能特性`, `## Install` → `## 安装`, `## Quick start` → `## 快速开始`, `## How it works` → `## 工作原理`, `## Security & privacy` → `## 安全与隐私`, `## Documentation` → `## 文档`, `## Development` → `## 开发`, `## License` → `## 许可证`), reusing the old file's heading translations where they exist.
  - GUIDE links keep the same targets (`docs/GUIDE.md#…`); link text may be 中文 (e.g. `[详情]`, `[导览]`, `[规则]`).

- [ ] **Step 2: Verify parallelism.**

Run: `wc -l README.md README.zh.md`
Expected: identical line counts.

Run: `grep -oE "GUIDE\.md#[a-z-]+" README.zh.md | sort -u`
Expected: the same five anchors as README.md.

- [ ] **Step 3: No commit** — NO-COMMITS mode.

---

### Task 4: Retarget the migration-error copy (code + test)

**Files:**
- Modify: `src/core/manifest.ts:123`
- Test: `tests/manifest.test.ts:79`

**Interfaces:** none consumed or produced; independent of Tasks 1–3.

- [ ] **Step 1: Update the assertion first.** In `tests/manifest.test.ts` line 79, change

```ts
'"s" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).'
```

to

```ts
'"s" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see the sensitive-settings guide in docs/GUIDE.md).'
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — the assertion no longer matches the thrown message.

- [ ] **Step 3: Update the source string.** In `src/core/manifest.ts` line 123, change

```ts
`"${name}" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).`
```

to

```ts
`"${name}" still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see the sensitive-settings guide in docs/GUIDE.md).`
```

- [ ] **Step 4: Run the gates.**

Run: `npm test` — Expected: 814 passing (count unchanged).
Run: `npm run build` — Expected: clean.
Run: `npm run lint` — Expected: 0 errors / 57 warnings.

- [ ] **Step 5: No commit** — NO-COMMITS mode.

---

### Task 5: Recapture the two screenshots (controller-inline — NOT a subagent task)

**Files:**
- Overwrite: `docs/assets/sync-panel.png`, `docs/assets/settings-picker.png`

Executed by the controller in the main session against the dev vault (`dev/vault`) running config-sync 2.10.1, via electron `capturePage`. Known pitfalls: the window must be shown and focused — `show()` + `moveTop()` + `webContents.invalidate()` + a settle delay before capture, or an occluded window captures a stale frame.

- [ ] Sync Center shot: representative mixed state (some pending captures/applies, a remote block visible) → `docs/assets/sync-panel.png`.
- [ ] Settings picker shot: Settings → Config Sync picker tab with several cards, at least one with badges → `docs/assets/settings-picker.png`.
- [ ] Visually confirm both match the running UI; no commit.

---

## Final verification (controller, after all tasks)

- `wc -l README.md README.zh.md` — equal.
- Anchor spot-check: every `GUIDE.md#…` target in both READMEs has its heading in `docs/GUIDE.md`.
- `grep -inE "no more|anymore|is now opt-in|moved to" README.md docs/GUIDE.md` — no matches.
- Gates: `npm test` (814), `npm run build`, `npm run lint` (0/57).
- Content-preservation sweep: every behavioral fact from the old README (`git show HEAD:README.md`) is findable in GUIDE.md or the new README.
