# Desktop-only plugin detection

Mobile-vault finding (2026-07-19, post-1.1.1): applying on a phone offers desktop-only community
plugins (e.g. Better Export PDF) for "install & enable" in the **Not installed** section, then
reports `⚠ enable failed — enable it manually` for each — misleading, because those plugins
**can't run on mobile at all**. Every plugin's `manifest.json` declares `isDesktopOnly`, but
config-sync ignores it.

This detects `isDesktopOnly` at capture, records it in the lock, and on mobile buckets those
plugins into a dedicated **informational** section instead of offering a failing install. It does
**not** change the data model beyond one optional lock field, and does not touch the user's
`devices` setting.

## Two distinct axes (do not conflate)

- **`devices` (`all`/`desktop`/`mobile`)** — the *user's* choice of which device classes an item
  syncs to. A soft preference set in config-sync.
- **`isDesktopOnly`** — the *plugin author's* hard declaration (manifest) that the plugin can only
  run on desktop. A fact, not a preference.

They overlap in effect but are different axes. This design keeps them separate: `isDesktopOnly` is
a hard capability gate; config-sync **never** auto-writes `devices` from it (that would overwrite
the user's synced choice).

## Design decisions (定稿 2026-07-19)

- **D1 — detect at capture, record in the lock.** Capturing a plugin group reads its manifest's
  `isDesktopOnly`; when true, the lock's group entry gains `desktopOnly: true` (alongside
  `sourcePluginVersion`). Recorded only when true, to keep the lock clean.
- **D2 — separate from `devices`.** `devices` is untouched.
- **D3 — mobile: informational section, hard gate.** On a mobile device, a plugin flagged
  `desktopOnly` that isn't installed here goes into a new **"Desktop-only"** availability section
  (plain-text title, styled like the existing Outdated/Disabled/Not-installed sections). It is
  **informational only**: no checkbox, no install/enable/apply action, never counted in pills /
  footer / sidebar badges, never stageable. Its settings are **not** applied (option A — the
  plugin can't run here, and its config already lives in the store for when you're on desktop).
- **D4 — desktop: a small `desktop-only` pill.** Where the item shows normally (i.e. on desktop,
  where it runs), its row carries an **independent** small pill — amber outline
  (`--color-orange`), rounded, text `desktop-only` — styled like the other small Sync Center
  badges, so you can see at capture time which plugins won't run on your phones. (Not tied to the
  settings-tab `device-specific` badge, which is unrelated and, per this session's finding,
  effectively unreachable — a separate audit-backlog cleanup.)
- **D5 — graceful degradation.** A store captured before this feature has no `desktopOnly` flag;
  those plugins stay in "Not installed" on mobile until re-captured on a desktop. No migration.

## Part 1 — Detection & storage (core)

- **Manifest field.** Extend the `CommunityPluginRegistry.manifests` value type (`main.ts`) from
  `{ id; name; version }` to include `isDesktopOnly?: boolean` (present in the real Obsidian
  manifest). Add a `PluginHost` method `isDesktopOnly(id: string): boolean`
  (`ConfigSyncCore.ts`), implemented in `main.ts` as
  `registry.manifests[id]?.isDesktopOnly === true`.
- **Lock schema** (`types.ts`): `groups: Record<string, { sourcePluginVersion?: string;
  sourceAppVersion?: string; desktopOnly?: boolean }>`.
- **Capture** (`ConfigSyncCore.ts` `capture`): where it writes
  `lock.groups[name] = { sourcePluginVersion: version }`, also set `desktopOnly: true` when
  `ctx.plugins.isDesktopOnly(pluginId)` — i.e. `{ sourcePluginVersion: version, ...(desktopOnly
  ? { desktopOnly: true } : {}) }`. App-anchored (core/Obsidian) groups never get it.

## Part 2 — Availability & sectioning (core + panelModel)

- **`Availability`** (`availability.ts`): add `desktopOnly: boolean`. `availabilityForGroup` reads
  it from `lock?.groups[group.name]?.desktopOnly === true` (only meaningful for plugin-anchored
  groups; `false` otherwise).
- **`SectionKind`** (`panelModel.ts`): add `"desktop-only"` to the union; add its
  `SECTION_TITLES` entry `"Desktop-only"` and a `SECTION_NOTES` entry
  `"In your config but can't run on this device — nothing to do here."`.
- **`sectionForItem`** gains an `isMobile` argument:
  `sectionForItem(a: Availability, isMobile: boolean): SectionKind`. It returns `"desktop-only"`
  when `isMobile && a.desktopOnly && a.kind === "not-installed"`; otherwise its current logic. All
  callers pass `Platform.isMobile` (the view has it; tests pass an explicit boolean).
- **`stageableRow`**: a `"desktop-only"` section is never stageable (return `false`).

## Part 3 — UI (view)

- **Section rendering** (`SyncCenterView.ts`): the `"desktop-only"` section renders like the other
  availability sections but **without** the checkbox column, the per-row install/On-apply
  controls, and the section select-all — just the item name + a `desktop-only` tag + the section
  note. It is excluded from `mainRows()`/count buckets (it already is, since counts bucket the
  main section; ensure the desktop-only rows never enter `checkableRows`/staging).
- **Desktop tag** (`SyncCenterView.ts`): on rows where `availability.desktopOnly` is true and the
  row renders in a normal (non-desktop-only) section, add a small `desktop-only` pill to the row
  name.
- **CSS** (`styles.css`): reuse existing section styling; add one new rule for the `desktop-only`
  pill — amber outline via `rgba(var(--color-orange-rgb), …)` + `var(--color-orange)` text,
  rounded, small; theme-native, zero hardcoded colors.

## Non-goals

- **BRAT-direct install** (installing GitHub/BRAT-sourced plugins without delegating to BRAT, to
  fix BRAT's mobile install failures) — a separate, larger design.
- **Mobile enable timing-race** (mobile-runnable plugins spuriously reported "enable failed") — a
  separate fix, pending confirmation.
- **Mutating `devices`** from `isDesktopOnly` (D2).
- Detecting desktop-only without the lock (e.g. fetching the catalog manifest on mobile) — the
  lock is the single source; graceful degradation covers old stores.

## Testing

- **core** (`tests/core.test.ts`): capturing a group whose fake host reports
  `isDesktopOnly(pluginId) === true` writes `desktopOnly: true` into that group's lock entry; a
  non-desktop-only group's entry has no `desktopOnly` key.
- **availability** (`tests/availability.test.ts`): `availabilityForGroup` sets `desktopOnly` from
  the lock; `false` when absent or for app-anchored groups.
- **panelModel** (`tests/panelModel.test.ts`): `sectionForItem({…desktopOnly:true, kind:"not-installed"}, true)` → `"desktop-only"`; the same with `isMobile:false` → `"not-installed"`; a
  desktopOnly item that IS installed (kind enabled/disabled) → its normal section (the desktop-only
  bucket is only for the not-installed case on mobile); `stageableRow(_, "desktop-only")` → false.
- **Live**: on the user's mobile device — desktop-only plugins appear under **Desktop-only**
  (informational, no controls, not counted), no more "enable failed"; on desktop the same plugins
  carry a `desktop-only` tag and install normally.
- **Gates**: `npm test`, lint 67-warning baseline, `check-no-hardcoded-color.sh`, mobile scoping.
