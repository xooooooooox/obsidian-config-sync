# BRAT integration (Beta tab + precise install), switch-list capture ordering, install-only messaging

Real-vault findings 2026-07-17, one branch. Mockup 定稿: `Beta tab mockup v2` (BratIcon + three
sections), approved 2026-07-17.

## A. Switch-list capture writes store-stable order

**Bug.** `captureSwitchList` builds the captured list as `[local minus exceptions, store's
excluded ids appended]`. Two churn sources: excluded ids move from their store positions to the
tail (the diff shows them as del+add pairs, contradicting "the shared list neither includes nor
changes them"), and the kept ids follow LOCAL file order (Obsidian's per-device enable order), so
identical membership still rewrites the whole file.

**Fix — membership unchanged, order becomes store-stable.**
Array shape: walk the store list first — keep an id in place when it is excluded (pass-through)
or locally enabled; then append local-only non-excluded ids in local order. Map shape
(core-plugins): same key-ordering rule — store keys first (excluded → store value, non-excluded →
local value when the key exists locally), then local-only non-excluded keys in local order.
`store === null` behaves as today (local minus exceptions). Result: a capture with identical
membership is byte-identical to the store; diffs show only true adds/removes, and excluded ids
never appear in them.

Existing switchList tests that assert the old tail-append order are updated; a new test pins
"excluded ids keep their store positions".

## B. Install-only failure messaging

Two wrong messages when an install-only apply fails (seen with my-text-tools):
- "no settings in the store — installed the plugin only" printed even though the install FAILED.
  Fix: push this message only when the plugin is actually present after the state action
  (check the plugin host for the id, not the action's intent).
- The install-failure guidance "settings were staged; install it manually to pick them up" is
  written for the settings-apply case. When the group has no store data, the guidance drops the
  settings clause: "…— install it manually". `runStateAction` learns whether store data exists
  (parameter passed by `applyWithActions`, which already computes it).

## C. BRAT integration

### C1. id→repo index

New settings field `bratPluginIndex: Record<string, string>` (plugin id → `"owner/repo"`).
Derived data, synced like the rest of data.json (harmless: BRAT's own data.json is synced, so
the index is identical on every device — and it lets offline devices classify).

- Source list: the local BRAT plugin's `pluginList` (live instance when enabled; else read
  `{configDir}/plugins/obsidian42-brat/data.json` directly; absent → empty list).
- Resolution: for each repo not yet in the index, fetch the repo's `manifest.json`
  (raw.githubusercontent.com, default branch) via Obsidian `requestUrl`, take its `id`.
  Failures leave the repo unresolved (retried at the next trigger); no throwing into the UI.
- Pruning: repos no longer in BRAT's list have their index entries removed at re-scan.
- Triggers: rendering the Beta tab with unresolved repos; the tab's ↻ Re-scan button; an install
  request for an unmapped id (last-chance resolve before falling back).

### C2. Beta tab (settings panel) — per 定稿 mockup v2

- Tab bar gains **Beta** after Community plugins. Icon: BRAT's own registered `BratIcon`
  (feature-detect); fallback lucide `flask-conical` when BRAT isn't installed.
- Header: title "Beta plugins", description "Plugins installed through BRAT instead of the
  community catalog. Settings sync the same way — only the install path differs." Below it a
  map-note line "Matched from BRAT's beta list · N of M repos resolved" with an inline
  **↻ Re-scan** button.
- Sections mirror the Community tab: **Enabled** / **Installed but disabled** (installed plugins
  whose id ∈ index, split by enabled state) / **Not installed on this device** (plugin-* groups
  whose id ∈ index with no local install — synced from the store). Row structure identical to
  community rows (chevron, ⚠ keys badge, device dropdown, mode segment, toggle); the row
  sub-description appends "· owner/repo".
- Beta has no on/off-list section — the enabled list stays under Community plugins.

### C3. Community tab and Custom rules stop leaking

- Community tab excludes ids ∈ index (they live in Beta now) and gains its own
  **Not installed on this device** section for plugin-* groups that are neither installed locally
  nor in the index (e.g. DEVONlink on a device that lacks it).
- Advanced → Custom rules shows only true custom groups (name not plugin-*/option/core) — synced
  plugin groups never fall through to it again.
- `ItemCategory` and the Sync Center scope switcher are unchanged: beta items still count as
  community there. This split is settings-panel-only.

### C4. Precise install through BRAT

`installPlugin` resolution order for a plugin id:
1. id ∈ `bratPluginIndex` and BRAT is installed+enabled and `betaPlugins.addPlugin` exists
   (feature detection) → call BRAT's `addPlugin(repo)` for exactly that repo, then verify the id
   is present in the plugin host; enabling stays ours (the existing On-apply finish closure).
2. Otherwise → community catalog (current path).
3. Failures: id ∈ index but BRAT unavailable → "managed by BRAT — enable BRAT and retry, or run
   BRAT's update command"; id unmapped and absent from the catalog → current manual-install
   message (with clause per B). The Sync Center install pill and the settings flow share this
   single choke point.

BRAT's internal API is not public: every call is feature-detected, and any shape mismatch falls
back to path 3's messaging rather than throwing.

## Testing

- switchList: store-stable order (array + map), excluded-in-place pin, byte-identity when
  membership matches, `store === null` unchanged.
- core: install-failure apply carries no "installed the plugin only" message; guidance text with
  and without store data.
- index: resolve/prune with a fake fetcher (id extraction, failure leaves unresolved).
- settings sectioning: pure listing logic for beta/community/not-installed splits given
  (installed plugins, groups, index) — no DOM.
- Live dev-vault: Beta tab renders with BRAT present (forged pluginList), BratIcon fallback path,
  install via BRAT smoke where practical.
- Gates: full suite, build, lint 65-warning baseline, no-hardcoded-color.
