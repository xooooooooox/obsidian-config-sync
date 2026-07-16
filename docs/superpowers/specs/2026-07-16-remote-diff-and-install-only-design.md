# Remote diff correctness, bulk-enable sensitive defaults, switch-list segment removal, install-only apply

Four real-vault findings (2026-07-16), bundled into one branch.

## 1. Bulk enable must seed sensitive defaults

**Bug.** The per-item enable toggle seeds Fields mode from sensitive-key detection
(`defaultFieldsFromDetection`), but the section header "Sync all" toggle goes through
`toggleSection` and adds groups with the default (plain) mode. Items enabled in bulk show
`⚠ N keys` badges while syncing plain.

**Fix.** Extract the seeding into one helper used by both paths. When "Sync all" turns a
section on, every newly added file-type group (switch lists excluded) runs the same
detection: if sensitive keys are found, the group gets `mode: "fields"` with
detection-seeded rules. Existing groups are never rewritten — only groups the toggle adds.

## 2. Remote deep diff must not drop files unknown to the local manifest

**Bug.** `diffRemote` attributes each remote file to a group via the **local** manifest.
Files that match no local group come back as the `""` pseudo-group, and the final filter
drops `""` as "store metadata". A fresh device (zero groups) therefore drops **every**
remote file: entries = `[]`, the panel says "✓ contents match — remote has newer version
info", yet Pull imports 69 items.

**Fix.** Resolution order per remote file:
1. local manifest groups (unchanged);
2. **remote manifest groups** — parsed from the remote store's own self-config copy
   (the file matching `store/*/plugins/config-sync/data.json`, read via the remote
   reader; its `groups` array is the remote manifest);
3. still unmatched and not store metadata → bucket under the pseudo-group
   `(other store files)` so the delta is visible instead of silently dropped.

Only `store.lock.json` and the legacy root `config-sync.json` remain metadata (filtered).
Local-only files (deleted-on-remote side) get the same resolution order. After the fix a
fresh device's refresh shows the real "↓ N to pull" per group.

## 3. Switch-list rows drop the Plain/Fields/Encrypt segment

The two plugin on/off list rows (Enabled community/core plugins) are pinned to plain; the
disabled three-button segment is noise. `renderModeSegment` renders nothing for
pinned-to-plain groups. The self item's pinned-to-Fields segment is unchanged (not in
scope).

## 4. "Not installed on this device" — install-only apply for settings-less plugins

**Gap.** Rows in the not-installed section are stageable only when the store holds the
plugin's settings. Plugins that are enabled on device A but have no settings file
(state ○ no-settings) can never be installed on device B through config-sync.

**Change.** In the not-installed section (and only there), ○ no-settings rows become
stageable with direction Apply. Applying installs the plugin from the community catalog
and honors the existing On-apply choice (Enable / Keep disabled — same controls as the
other rows in the section); no settings file is written. Detail line for such a row reads
"no settings to apply — installs the plugin only". Counts (pills, header, Apply N items
button) include these rows. Everywhere else ○ rows stay inert.

## Testing

- core: `diffRemote` fresh-device test — zero local groups, remote store with files plus a
  remote self data.json; entries resolve to remote group names, lock/legacy manifest
  excluded, unmatched files land in `(other store files)`.
- core: apply of a staged install-only item runs the install action and reports ok with no
  files written.
- panelModel: stageability rule — no-settings row stageable in not-installed, inert in
  main section.
- Existing gates: full test suite, build, lint (65-warning baseline), no-hardcoded-color.
