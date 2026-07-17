# Version-pinned install + install correctness (0.29.0)

Real-vault findings 2026-07-18. Three related install/panel corrections, plus the
architecture change the user approved: install/update target the version the store's
settings were captured on, not "latest".

Context: the store lock already records `sourcePluginVersion` per group at capture time
(`ConfigSyncCore.ts:183`), synced across devices and already used for the Outdated/drift
comparison (`availability.ts:45`). So version-pinning needs no new schema — only the
installer must target that version instead of always-latest.

## A. Footer summary counts the total selection

`footerSummary(selected, outdated, disabled, toInstall)` hardcodes the lead as
`${selected} selected`, but `selected` is only the MAIN-section staged count. With 9 rows
staged in "Not installed" and none in main, the footer read "0 selected · +9 to install"
while the section head said "9 selected" and the button "Apply 9 items" — three numbers
disagreeing on one thing.

Fix: the lead number becomes the TOTAL staged across all sections; the non-main sections
become a composition breakdown (a partition, so drop the misleading `+`):

- `total = selected + outdated + disabled + toInstall`; empty → "".
- `"{total} selected"`, then append only the non-zero non-main parts as
  `"{n} to install"`, `"{n} to update"`, `"{n} to enable"` — e.g.
  `"12 selected · 2 to enable · 9 to install"`. The counts are subsets of the total, joined
  with " · ", no `+`.

## B. Installer resolves the right version (fixes the calendar-beta failure)

`createInstaller` downloads from `github.com/{repo}/releases/latest/download` — GitHub's
"latest release", which for Calendar is a beta whose manifest id is `calendar-beta`, failing
our id check. Obsidian instead resolves the stable version from the repo's root manifest.

New signature: the returned installer takes an optional target version —
`(pluginId: string, targetVersion?: string) => Promise<string>`.

- **Pinned path** (`targetVersion` given): download
  `github.com/{repo}/releases/download/{targetVersion}/{manifest.json,main.js,styles.css}`.
  Validate the downloaded manifest's `id === pluginId`. If the tagged release is missing
  (download fails), fall back to the latest-stable path and record a warning message.
- **Latest-stable path** (no `targetVersion`, or fallback): fetch the root manifest
  `raw.githubusercontent.com/{repo}/HEAD/manifest.json`, read its `version`, then download
  that version's tagged release as above. This is what Obsidian's community browser does —
  it returns id `calendar` / version `1.5.10`, not the beta.
- The `releases/latest/download` URL is removed entirely.

`styles.css` stays optional. `http` (timeout+retry from 0.28.0) wraps every fetch,
including the new root-manifest fetch.

## C. Install and update target the captured version (方案 A + c)

The store's settings were captured on a specific plugin version; installing/updating to that
same version reproduces the source environment and keeps settings schema-compatible.

- **Install** (not-installed section): target = the group's `sourcePluginVersion` from the
  lock. When it is null (old store, or the group is app-anchored with no plugin version),
  install latest-stable (path B). Fallback to latest with a warning when the pinned release
  is gone.
- **Update** (outdated section): already bucketed only when `anchor === "plugin" && drift
  === "behind"` (`panelModel.ts:106`) — plan c is the existing behavior; an "ahead" local
  never enters Outdated, so no downgrade paradox. Change the target from latest to the
  store's `sourcePluginVersion`, and relabel the ladder: `"⤓ Update to latest"` →
  `"⤓ Update to {version}"` (and the pill `"⤓ update"` → `"⤓ update to {version}"` /
  keep short as `"⤓ update"`). The section note already frames it as "captured on a newer
  version".
- **Threading**: `PluginInstallFn` gains the optional target version:
  `(pluginId, onPhase?, targetVersion?) => Promise<string>`. `applyWithActions` loads the
  lock once and passes each group's `sourcePluginVersion` into `runStateAction` →
  `installPlugin` for both install and update actions.
- **BRAT-managed installs stay on BRAT's own channel** (beta plugins track their own
  versions); pinning applies to the community-catalog path only. Documented, not changed.

## D. UI shows the target version

- Not-installed ladder note gains the version: e.g. "installs the captured version
  1.5.10" (or "installs the latest version" when unpinned/fallback).
- Outdated ladder shows "Update to {version}" per above.
- No layout change; text only. Follows DESIGN.md (theme vars, no new color/icon).

## Testing

- `installer.test.ts`: pinned version downloads from the version-tagged URL and returns it;
  missing tagged release falls back to latest-stable (root manifest) and still succeeds;
  latest-stable path resolves version from the root manifest (a fixture where the "latest
  release" manifest has a different id must NOT be used — proves the calendar-beta fix);
  id mismatch in the resolved release throws.
- `panelModel` test: `footerSummary` total = sum; composition parts are subsets with no
  `+`; all-zero → "".
- Core: `applyWithActions`/`runStateAction` pass the lock's `sourcePluginVersion` to the
  installer for install and update; null version → latest path.
- Live dev-vault: install Calendar (previously failed) → now installs 1.5.10; a pinned
  plugin installs its captured version; footer reads consistently with the section heads
  and Apply button.
- Gates: npm test, lint 67-warning baseline, no hardcoded colors.

## Non-goals

Arbitrary user-chosen versions (a version picker) — out of scope; install follows the
store's captured version. Retiring the lock — rejected (it carries capturedAt + drives
remote-newer detection + app-anchored source versions; version belongs in this sidecar,
not inside plugins' own data.json).
