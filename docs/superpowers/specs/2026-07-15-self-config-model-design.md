# Self-Config Model: Single Config File, Field Selection, Merge Pull (0.22.0)

Unify config-sync's own configuration into one file (`data.json`), make its cross-device
propagation an ordinary captured item protected by field rules, replace pull's mirror semantics
with a 2-way merge plus git-style conflict prompts, and bootstrap fresh devices from the store.
This resolves the long-deferred "self-config propagation" issue.

## Problem (verified in code, 2026-07-15)

config-sync's own state lives in three tangled layers with wrong propagation behavior:

1. **`data.json`** (`.obsidian/plugins/config-sync/data.json`, `ConfigSyncSettings` at
   `main.ts:35-43`): `pkmMode`, `rootPath`, `remotes`, `ribbonButtons`, `statusInMenu`,
   `remoteAutoCheck`, `localPeriodicCheck`. Two fields are inherently per-device (`rootPath`,
   `remotes`); the rest are portable preferences. There are **no credentials** here: `Remote`
   (`types.ts:53-55`) has no token field (git auth = system SSH), and the encryption passphrase
   lives in per-vault `localStorage` (`main.ts:358-365`), never in any synced file.
   **Danger:** `plugin-config-sync` is an ordinary catalog item with no special-casing — apply
   on device B wholesale-overwrites B's `data.json` with A's, clobbering B's `rootPath`/`remotes`.
2. **`config-sync.json`** (the manifest, at `${rootPath}/config-sync.json`): the group contract.
   It sits inside the tree that push/pull mirror (`importExternal`/`pushExternal` enumerate the
   whole `rootPath`, `ConfigSyncCore.ts:560/589`), so **pull overwrites the local manifest and
   deletes local-only groups' store files** — "B configures, pulls, loses everything".
3. **`store/**`** (captured copies): mirrored — correct, that is the point.

Meanwhile the user's mental model is: *one plugin configuration*, selectively synced by field,
merged (not mirrored) on pull, with the user resolving conflicts.

## Design decisions (定稿 2026-07-15)

- **D1 — one config file:** merge the manifest into `data.json`; no `config-sync.json` at the
  store root anymore.
- **D2 — propagation is self-capture:** the config travels as the captured item
  `plugin-config-sync` (store → remotely-save → apply), protected by preset device-local field
  rules. No separate propagation channel.
- **D3 — capture-side field selection:** any JSON item can exclude fields from sync via the
  existing fields mechanism; `plugin-config-sync` ships locked preset rules for
  `rootPath`/`remotes`.
- **D4 — pull is a 2-way merge with conflict prompts:** value-differs → conflict → user picks
  remote/local per item (git-style); one-sided content merges automatically; local-only groups
  and files are never deleted.
- **D5 — bootstrap:** a fresh device that finds a store containing `plugin-config-sync` is
  offered "adopt this configuration".

## Part 1 — Single config file

### Data model

`ConfigSyncSettings` gains the contract:

```ts
interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string;          // device-local
  remotes: Remote[];         // device-local
  ribbonButtons: RibbonButtons;
  statusInMenu: boolean;
  remoteAutoCheck: boolean;
  localPeriodicCheck: boolean;
  groups: SyncGroup[];       // NEW — the sync contract, formerly config-sync.json's "groups"
}
```

The `SyncGroup` shape (name/path/type/devices/description/label/mode/fields/…) is unchanged, so
`parseGroup` validation is reused verbatim on load (a malformed group in data.json is reported,
not silently dropped — same strictness the file had).

### Core-layer rewiring

The pure core reads/writes groups through `CoreContext` instead of a file:

- `CoreContext` gains `readGroups(): Promise<SyncGroup[]>` and `writeGroups(groups):
  Promise<void>` host callbacks (implemented in `main.ts` over `this.settings.groups` +
  `saveSettings`). The existing exported `readGroups(ctx)`/`writeGroups(ctx, groups)` keep their
  signatures but delegate to the ctx callbacks — call sites don't churn.
- `manifestPath`/`loadManifest`-as-file, `createStarterManifest`, the `$schema` writing, and
  `config-sync.json`-specific validation-error copy are removed. `validateRemotes` and the group
  validators stay (they validate settings content now).
- `statusForGroups`, capture, apply, catalog — unchanged consumers of `readGroups`.

### What remains at the store root

`store/**` and `store.lock.json` only. The lock file is capture metadata and keeps riding the
store. Push/pull's "root file" special-casing for `config-sync.json` (`ConfigSyncCore.ts:541-543,
591-595`) is removed; the store-presence check becomes "has a `store/` tree or lock file".

### Migration (one-time, on load)

On plugin load, if `${rootPath}/config-sync.json` exists: parse it; merge its groups into
`settings.groups` (by name — existing settings entry wins if both exist); save settings; rename
the file to `config-sync.json.migrated-<date>` (do not delete — user-auditable); Notice the user.
Failure to parse → Notice with the error, file left in place, plugin continues with settings
groups. The same applies to a store copy encountered during pull from an old-format remote: a
remote root `config-sync.json` is read (compat) and treated as that remote's groups source, but
is never written back locally as a file.

## Part 2 — Self-propagation via `plugin-config-sync`

`plugin-config-sync` stays a normal catalog item, with hardening:

- **No new mechanism — strip IS device-local.** Strip semantics (verified): `sanitizeJson`
  removes matching keys **entirely** from the store copy (`sanitize.ts:20` `continue` — the key
  does not exist in the captured JSON, it is not emptied), and apply's
  `mergePreservingSanitized` keeps the local value for keys matching strip patterns
  (`sanitize.ts:42-46`). So "don't sync this field / it stays per-device" is exactly what strip
  already does, generically, for any JSON item. No leak (A's paths/remote addresses never appear
  in the store), no ambiguity (absent key ≠ user-set empty value).
- **One generic addition: `locked` on field rules.** `FieldRule` gains an optional boolean
  `locked`; a locked rule cannot be removed in the UI (delete control disabled with the standard
  disabled treatment, 🔒 prefix on the row; single "don't sync" badge — no separate
  "device-local" badge, since it is not a second feature). The flag is generic (any preset could
  use it); today only the self-item's presets set it.
- **Preset locked rules for the self-item.** When the group `plugin-config-sync` is created (or
  migrated), it gets `mode: "fields"` with **locked** strip rules for `rootPath` and `remotes` —
  automatically. Other fields of data.json can be additionally stripped/encrypted by the user
  like any item.
- **Capture:** the store copy `store/configdir/plugins/config-sync/data.json` therefore contains the
  contract (`groups`) + portable prefs, with `rootPath`/`remotes` stripped.
- **Apply on B:** the existing fields-mode apply path (`modes.ts:206-215`,
  `mergePreservingSanitized` — verified: local-only keys matching strip patterns are preserved,
  `sanitize.ts:42-46`) keeps B's `rootPath`/`remotes` and takes A's portable fields + groups.
  After a `plugin-config-sync` apply, `main.ts` reloads settings from disk so the running plugin
  picks up the new contract immediately (settings hot-reload: re-run `loadSettings`, refresh
  status, notify Sync Center).
- **Self-apply write safety:** applying `plugin-config-sync` writes the very file the running
  plugin owns. The write goes through the normal apply path (vault adapter); the subsequent
  settings reload is the synchronization point. No concurrent `saveSettings` may run during
  apply of this item (apply already serializes operations).

## Part 3 — Capture-side field selection

Already 90% present: `mode: "fields"` + strip rules exclude fields at capture. The delta:

- Reframe in UI copy: the Fields segment's strip rule reads as "don't sync this field" (copy
  change only; semantics identical).
- The View-data.json key-click flow (added in 0.21.0) already lets users add a strip rule per
  key — that is the "selective sync" entry point. No new mechanism.
- Preset locked rules (Part 2) render in the same Fields segment, marked locked.

## Part 4 — Pull as 2-way merge with conflict prompts

`importExternal` is rewritten. Per group present in the remote store:

- **Group definitions** (remote's `plugin-config-sync` store copy → its `groups`, vs local
  `settings.groups`):
  - group only in remote → added locally (plus its store files).
  - group only local → kept; its store files kept (never deleted). **This removes pull's
    delete-mirroring** (`ConfigSyncCore.ts:559-570` behavior dropped).
  - group in both, definitions identical → no-op.
  - group in both, definitions differ → **conflict entry** (granularity: whole group definition).
- **Store file contents** per group:
  - file only in remote → written locally.
  - file only local → kept.
  - both, bytes identical → no-op.
  - both, bytes differ → **conflict entry** (granularity: whole file; JSON field-level diffing is
    out of scope for this iteration — YAGNI, revisit if whole-file proves too coarse).
- **2-way:** no baseline snapshot is stored; "differs" = conflict. (3-way with recorded baselines
  was considered and deferred — cost of persisting sync baselines outweighs the benefit for now.)

### Conflict resolution UI

When the merge produces conflicts, pull pauses and shows a **conflict modal**. Visual 定稿
(companion, 2026-07-15, `conflict-modal-v4.html` + `gallery-self-config.html`):

- **Structure:** pinned header ("Resolve pull conflicts", remote name, N items compared) →
  scrollable middle → pinned footer. Middle: a collapsible **auto-merged section** (collapsed by
  default, `＋n · ＝n · ⌂n` count summary; expanded rows list each clean item with its reason:
  `＋` added from remote, `＝` identical, `⌂` local-only kept) then the **conflict list** with
  "All local" / "All remote" shortcuts.
- **Conflict row:** display label + kind badge (`DEFINITION` orange / `FILE` blue, file rows show
  the store path) + a segmented **Local | Remote** toggle (chosen side accent-tinted). Unresolved
  rows get an amber border + "⚠ choose a side"; **Apply stays disabled until every conflict is
  resolved** (footer counts "k of n resolved").
- **Diff preview (git-style):** each row expands to a read-only diff with a **Unified ⇄ Split**
  toggle in the diff toolbar. Unified = `--- local` / `+++ remote` headers, `@@` hunks, context
  lines dimmed, `-` red / `+` green. Split = side-by-side local|remote panes, differing lines
  tinted per side. DEFINITION diffs show the group-definition JSON (differing properties ±
  context); FILE diffs show file content with capture timestamps per side. View choice is
  remembered for the session (not persisted); phones force Unified. Choice semantics stay whole
  side (git ours/theirs) — the diff is for understanding, not per-line picking.
- **Footer:** "nothing is written until you apply" + **Cancel pull** / **Apply merge**. Apply
  writes the whole merge result in one pass: all auto-merged parts plus each conflict's chosen
  side. Cancel aborts with **nothing** written — not even the auto-merged parts. Pull is
  all-or-nothing per invocation.
- Choices are per-operation; nothing is persisted. Colors bind to theme palette vars (accent for
  chosen side, orange caution, red/green diff tints) per the design system.

Push keeps mirror semantics for `store/**` (push publishes this device's store; the remote-side
merge story is pull's job on the other device). Push no longer writes any root
`config-sync.json`.

## Part 5 — Bootstrap on a fresh device

On load, when `settings.groups` is empty AND no legacy `config-sync.json` exists AND
`${resolvedRootPath}/store/configdir/plugins/config-sync/data.json` exists (typical: remotely-save brought
the store before the user configured the plugin): show a Notice + Sync Center banner. Visual 定稿
(companion, `gallery-self-config.html`): an accent-tinted banner at the top of the Sync Center —
"Found an existing configuration in the store" with a summary line (item count, source device,
capture time), an **Adopt** primary button, and a ✕ that dismisses for the session. Adopt = apply
`plugin-config-sync` (fields-mode apply preserves the empty-but-default local `rootPath`/
`remotes`), reload settings, refresh. Decline = banner dismissed for the session; normal manual
setup remains available. No auto-adopt — explicit user action required.

## Edge cases

- **Old store pulled from a remote** (root `config-sync.json`, no `plugin-config-sync` store
  item): compat path reads the root file as the remote's groups source for the merge; local side
  never writes that file. Documented as deprecated format.
- **`devices` scoping:** `plugin-config-sync` defaults to `devices: "all"`; the strip rules make
  that safe.
- **Encrypted fields in data.json:** allowed like any item (user may encrypt e.g. a field they
  consider sensitive); passphrase stays in localStorage so an encrypted self-item is decryptable
  only after the user sets the passphrase on B — standard behavior.
- **rootPath circularity:** `rootPath` tells the plugin where the store is; it is device-local
  (stripped), so a pulled config can never point B's store somewhere unexpected.
- **Conflict modal on mobile:** same modal; no desktop-only dependency (pull from vault-type
  remotes is desktop-only today via localPath — unchanged).
- **store.lock.json conflicts:** lock is metadata; on pull, remote lock entries for groups taken
  from remote are adopted, local entries kept otherwise; never a user-facing conflict.

## Testing

- **Unit (node suite):** settings-groups round-trip (parse/validate groups from settings,
  including malformed-group error); migration (legacy file → settings, rename, both-exist
  precedence); capture of `plugin-config-sync` strips `rootPath`/`remotes` (store copy
  inspection); apply preserves local `rootPath`/`remotes` and takes remote portable fields +
  groups (`mergePreservingSanitized` integration); 2-way merge classifier (pure function:
  given local groups+files and remote groups+files → {autoMerge[], conflicts[]}) over all four
  cell types; conflict resolution application (chosen set → exact writes); bootstrap detector.
- **Controller smoke (dev vault):** capture self → inspect store copy; simulate device B (second
  scratch config dir or manipulated settings) → apply → verify rootPath/remotes intact + groups
  adopted; pull with a doctored remote store → conflict modal appears → both resolution paths;
  legacy-migration path with a real old config-sync.json; fresh-vault bootstrap banner.
- Gates: build/lint (0 errors, warnings baseline), color scan, node suite green (count grows).

## Scope & sequencing

One spec, implemented as multiple plan tasks in this order: (1) settings-groups data model +
core rewiring + migration; (2) preset locked field rules + self-apply hot-reload; (3) pull
merge classifier (pure core) + conflict modal UI (needs mockup 定稿); (4) bootstrap banner;
(5) push/pull root-file removal + compat; (6) copy pass ("don't sync this field"). UI surfaces
(conflict modal, locked rules presentation, bootstrap banner) go through the visual companion
before their tasks are implemented. This supersedes the deferred "self-config propagation"
backlog item; capture/pull interruption robustness (#5) remains parked separately.
