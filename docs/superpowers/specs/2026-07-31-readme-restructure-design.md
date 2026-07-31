# README restructure: landing page + user guide split — Design

Date: 2026-07-31
Status: approved direction (brainstorming 2026-07-31); this document is the spec.

## Goal

Split the README's two jobs apart. `README.md` becomes a landing page a new user can
read in five minutes: pitch, features, install, quick start, security disclosure.
All behavioral detail — Sync Center anatomy, field rules, the install engine,
remotes, encryption, walkthroughs — moves to a single English user guide,
`docs/GUIDE.md`. Both READMEs are rewritten and stay line-parallel; the two README
screenshots are recaptured at the current UI (2.10.1) as part of this change.

## Decisions (settled during brainstorming)

- README = landing page; detail sinks to `docs/GUIDE.md` (single file, English only).
- `README.md` / `README.zh.md` remain line-parallel (`wc -l` equal); both fully rewritten.
- Screenshots `docs/assets/settings-picker.png` and `docs/assets/sync-panel.png`
  recaptured now (folds in the standing backlog item). Paths and filenames unchanged.
- README drops the **Releasing** section — the flow already lives in `CLAUDE.md`
  ("Releasing:" bullet) and `docs/ARCHITECTURE.md` ("Release flow" bullet); a third
  copy violates DRY.
- README drops the **Breaking upgrade** banner — schemaVersion 2 shipped several
  releases ago; a store install today has no pre-2 state to migrate. GUIDE's Store
  layout section keeps one sentence: the store format is `schemaVersion: 2` and
  pre-2 installs have no migration path.

## Problems with the current README (evidence, at 175 lines)

1. **Changelog-style phrasing** — sentences addressed to users of older versions,
   meaningless to a new reader: "No more separate …" (line 18), "The old
   ribbon-icon dot is now opt-in" (25), "Quick commands moved to …" (78), "There
   is no hand-edited rule file anymore" (108), "There is no hard blacklist
   anymore" (153). Violates the house rule: docs record current state, not a
   change history.
2. **Monster paragraphs** — "Always-visible awareness" (~200 words, line 23), the
   drawer-zones bullet (~400 words, line 92), and the prose block at lines 78–84
   describing every UI nuance in run-on paragraphs.
3. **Two jobs in one file** — landing-page pitch and exhaustive manual interleave;
   the same facts (scope icons, result strip, header chip) are explained two or
   three times at different depths.
4. **Stale banner** — the Breaking upgrade callout occupies the first screen for a
   migration that no longer applies to anyone installing from the store.
5. **Stale screenshots** — both images predate several UI iterations (status-bar
   header chip, availability sections, current settings cards).

## New `README.md` (target ≈ 70 lines; `README.zh.md` mirrors line-for-line)

Order and content:

1. **Logo + title + badges** — unchanged (release, downloads, EN/中 switchers).
2. **Pitch paragraph** — current line 10 kept, lightly tightened. No banner after it.
3. **Hero screenshot** — `docs/assets/sync-panel.png` (the Sync Center is the
   product's main surface; it replaces settings-picker as the hero).
4. **Features** — 10 bullets, each `**Bold lead** — one sentence`, linking to a
   GUIDE anchor where depth exists. Topics (one bullet each):
   - One card per synced item (option group / plugin / snippet: same row + drawer).
   - Field rules: every key an orthogonal `{scope, encrypted}` pair; string-array
     keys get per-item scopes.
   - Credential-safe: `This device` keys never leave the machine; encryption with a
     per-device passphrase for what should travel.
   - Explicit Apply: nothing lands without a tick and an Apply; result strip +
     History record every run.
   - Sync Center awareness: per-item state badges, normalized JSON diffs,
     this-device status chip, pending-action totals.
   - Install engine: outdated / disabled / not-installed plugins can be updated,
     enabled or installed during Apply, pinned to the captured version.
   - Remotes (desktop): pull/push the store against a git repo or another vault,
     with per-file diff previews.
   - Search everywhere: `key:value` qualifiers with autocomplete in both the Sync
     Center and settings.
   - Status bar: capture/apply and per-remote push/pull counts at a glance.
   - Mobile-friendly: capture, apply and the Sync Center work on phones; the store
     is plain vault content.
5. **Install** — unchanged (community catalog + BRAT beta line).
6. **Quick start** — the existing 3 steps; `docs/assets/settings-picker.png` sits
   here illustrating step 1.
7. **How it works** — ≈ 12 lines, two short blocks:
   - *Local plane*: Capture copies enabled items into the store applying each
     field's rule; Apply lands ticked items into this device's config dir;
     direction comes from a per-device sync baseline, not file times.
   - *Transport*: by default the store rides your note sync (a fresh device gets
     an **Adopt** banner and a one-time setup guide); optional desktop Pull/Push
     against a git repo or another vault.
   No result-strip / header-chip / qualifier detail here — that's GUIDE material.
8. **Security & privacy** — kept in README verbatim (store review expects
   network use and outside-the-vault file access disclosed here). Current lines
   132–139 carry no changelog phrasing; they move as-is.
9. **Documentation** — new short section: link `docs/GUIDE.md` (user guide) and
   `docs/ARCHITECTURE.md` (code map, for contributors).
10. **Development** — the 4-command block + "dedicated test vault" warning, kept.
11. **License** — unchanged.

Dropped from README (all content preserved in GUIDE unless noted): Breaking
upgrade banner (one GUIDE sentence), Features detail beyond one sentence each,
Settings guide, Store layout, Walkthroughs, Sensitive settings, Availability
sections / install engine detail, Releasing (lives in CLAUDE.md + ARCHITECTURE.md).

## New `docs/GUIDE.md` (English only, single file, information-complete)

Header: one-line scope note ("Every behavior in one place; the README is the
5-minute version.") + a table of contents. Sections, with the current README
content that maps into each:

1. **Concepts** — the two planes (lines 43–47 intro), the per-device sync
   baseline (line 51), the store layout tree + schemaVersion-2 note (lines
   96–108, plus the migration sentence replacing the old banner).
2. **The Sync Center** — header status bar & this-device chip/pane (lines 23, 82);
   item state badges & normalized diffs (line 23); availability sections and the
   install engine — full rules: On-apply choices per section, version pinning to
   `store.lock.json`, catalog fallback, staged-config semantics, bulk-install
   failure isolation, ahead-of-store metadata line (lines 53–71); result strip &
   History (line 80); search & qualifiers with the full qualifier table (lines
   28, 84).
3. **Settings** — General (line 90); card anatomy with the drawer's three zones
   split into `#### Enabled on` / `#### Settings file` / `#### Companion folders`
   sub-headings with bullets, replacing the 400-word paragraph (lines 91–92);
   Advanced: custom rules + discovered files + reset row (line 93); Remotes incl.
   the "Keep Config Sync's own settings out of this remote" toggle (line 94).
4. **Field rules & sensitive settings** — `{scope, encrypted}` semantics,
   per-item scopes, whole-file vs per-key mode, passphrase & keychain, locked
   state, sensitive-key detection and File-preview color legend (lines 141–153,
   rewritten current-state: the line-153 "no hard blacklist anymore" sentence
   becomes "every plugin — including `remotely-save` and `config-sync` itself —
   is a normal item").
5. **Transport** — note sync default + fresh-device Adopt flow and pre-adopt
   banner (line 75); Pull/Push remotes: git temp-clone behavior, vault remotes,
   remote freshness checks, per-file diff drill-down, pull-is-additive ("Pull
   never removes files") and the push mirror-delete exemption (lines 27, 76).
6. **Status bar & ribbon** — status-bar item, per-remote counts, opt-in ribbon
   dot, mobile force-show, the single ribbon menu (lines 25, 78 — rewritten
   without "the old … is now" and "moved to" framing; the Ribbon Organizer link
   survives as a plain "quick commands live in …" sentence).
7. **Walkthroughs** — the existing four (lines 110–130), formatting tidied.

Rewrite rules applied to every migrated sentence:

- **Current state only.** Delete or reword every "no more", "anymore", "the old
  X is now", "moved to", "not just … anymore" construction.
- **One place per fact.** README gets at most one sentence per fact; GUIDE holds
  the expansion. Inside GUIDE, a fact lives in one section and is cross-linked
  from others, not restated.
- **Lists over prose** for enumerable behavior (qualifier keys, On-apply choices,
  scope glyphs, legend colors).
- Copy stays English; UI strings quoted exactly as rendered.

## Code touch (one string)

`src/core/manifest.ts:123` — migration-error copy ends "(see README → Sensitive
settings)". That anchor is moving; the copy becomes "(see the sensitive-settings
guide in docs/GUIDE.md)". Update the matching assertion at
`tests/manifest.test.ts:79`. This is the only code change; full gates apply.

## Cross-reference updates

- `CLAUDE.md` docs-currency bullet (line 44): add `docs/GUIDE.md` to the list of
  docs that must be updated in the same branch as user-facing changes.
- Verified by grep: no other repo file references README *sections*.
  `docs/ARCHITECTURE.md:318` mentions the README logo tile (asset, untouched);
  `AGENTS.md:108` is a generic policy sentence (untouched); `docs/design/` has no
  README references.

## Screenshots

Recapture both images in the dev vault on 2.10.1 via electron `capturePage`
(known pitfalls: window must be shown, `moveTop`, `webContents.invalidate`, then a
settle delay before capture — occluded windows capture stale frames):

- `docs/assets/sync-panel.png` — Sync Center with a representative mixed state
  (some pending captures/applies, a remote block visible).
- `docs/assets/settings-picker.png` — Settings → Config Sync picker tab with a
  few cards, at least one with badges.

Same filenames and paths; README and GUIDE reference them where designed above.

## Out of scope

- No behavior or UI change beyond the one error-message string.
- `docs/design/DESIGN.md` untouched (no visual change).
- No `GUIDE.zh.md` — the guide is English only by decision.
- No link-checker tooling; anchor validity is verified manually once.

## Verification

- `wc -l README.md README.zh.md` — equal line counts.
- Every GUIDE anchor linked from README resolves (manual check of heading slugs).
- No occurrence of the changelog phrases ("no more", "anymore", "is now
  opt-in", "moved to") in README.md or GUIDE.md except inside quoted UI strings —
  spot-check with grep.
- Gates: `npm test` (suite currently 814 — count unchanged; one assertion string
  updated), `npm run build`, `npm run lint` (0 errors / 57-warning baseline).
- Screenshots visually match the running 2.10.1 dev vault.
