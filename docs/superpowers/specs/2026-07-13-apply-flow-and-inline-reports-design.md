# Apply Flow & Inline Reports Design (0.20.0)

Combined iteration: availability-layered Sync Center (four sections), gap-ladder per-item
state policies with a plugin install/update engine, inline result strips replacing report
modals, report styling (legend/tooltips/section pills), version-drift handling, and removal
of the pre-apply confirmation modal. Approved via visual mockups
(`iter2526-master-gallery.html`, 9 screens + model rules).

## Model rules (bind every surface)

1. **Checkbox** = whether the item's config participates in this run. **Segment** = what
   this apply does to the plugin's state. **Footer buttons** = the only execution points —
   no inline immediate actions anywhere.
2. **Segment options are composed from the item's gap list** (install → update → enable).
   The default when checked is the option that closes every gap. Exception: Obsidian/Core
   app-version drift has no automatable action → reminder text only.
3. **Section placement looks at availability only** (not-installed > disabled > outdated).
   Version gaps travel with the item as extra segment options / metadata lines. All
   top-level counts (header pills, sidebar badges, filter pills, footer, main select-all)
   count the main list only.
4. **Zero confirmation modals.** `checkApply`, `ApplyWarning`, and `confirmWarnings` are
   deleted. Apply always executes directly. The only modal left in the plugin is the
   Revert report (command entry point outside the hub).
5. **Graduation**: after a successful enable/install/update the item re-buckets on the next
   state recompute (no migration logic). Failures are isolated per item and never block
   other items.

## Part 1 — Core: availability, version anchors, install engine, apply pipeline

### 1.1 Availability + drift (`src/core/availability.ts`, new)

```ts
export type AvailabilityKind = "enabled" | "disabled" | "not-installed";
export type VersionDrift = "behind" | "ahead" | null; // local vs store (behind = local < store)
export interface Availability {
  kind: AvailabilityKind;
  drift: VersionDrift;
  localVersion: string | null;   // plugin version, or app version for obsidian/core groups
  storeVersion: string | null;   // from store.lock.json
  anchor: "plugin" | "app";
}
```

- Community plugin groups (`plugin-<id>`): `kind` from `getInstalledPluginVersion` (null →
  `not-installed`) + `isPluginEnabled`. Drift compares `sourcePluginVersion` from the lock
  against the installed version with a dotted-numeric compare (split on `.`, numeric
  segment compare, missing segments = 0; non-numeric segments compared as strings).
- Core plugin groups (`CORE_SETTINGS_IDS`): `kind` is `enabled`/`disabled` via a new
  `isCorePluginEnabled(id)`; never `not-installed`. Drift anchor = app version.
- Obsidian settings groups: always `enabled`; drift anchor = app version.
- Custom/dir groups without a plugin id: always `enabled`, drift always `null`.
- `drift` is only non-null when both versions are known and differ.

### 1.2 Version anchors in the lock (`store.lock.json`)

`lock.groups[name]` becomes `{ sourcePluginVersion?: string; sourceAppVersion?: string }`
(at least one key required by validation). Capture records `sourcePluginVersion` for
plugin groups (existing) and **`sourceAppVersion` (the Obsidian app version) for
obsidian/core groups** (new). `PluginHost` gains `getAppVersion(): string` (from
`apiVersion` in the obsidian module). The "no version recorded" capture message is dropped
for non-plugin groups (they now record app version). `parseStoreLock` accepts either key.

### 1.3 Install/update engine (`src/core/installer.ts`, new)

```ts
export type HttpGet = (url: string) => Promise<ArrayBuffer>; // throws on non-2xx
export class CatalogError extends Error {}   // plugin not in the community catalog
export class DownloadError extends Error {}  // network / asset failure
export async function installCommunityPlugin(
  io: FileIO, configDir: string, pluginId: string, http: HttpGet
): Promise<string> // resolves to the installed manifest version
```

- Catalog: GET
  `https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json`,
  find entry with `id === pluginId` → `repo`. Missing → `CatalogError` with message
  `{id} isn't in the community catalog — install it manually`.
- Assets: GET `https://github.com/{repo}/releases/latest/download/manifest.json` and
  `main.js` (both required), `styles.css` (optional — a failed styles fetch is tolerated).
  Any required failure → `DownloadError` with message
  `couldn't download {id} from the community catalog`.
- Write files to `{configDir}/plugins/{pluginId}/`. Return `version` parsed from the
  downloaded manifest. Update = same function over an existing dir (files overwritten).
- The plugin adapter provides `http` via Obsidian `requestUrl` (works on mobile, no CORS).
- Catalog response is cached in-memory per Sync Center session (one fetch per run at most).

### 1.4 State actions + apply pipeline (`src/core/ConfigSyncCore.ts`)

```ts
export type StateAction =
  | "none"            // enabled items, Keep {v}, Stage only, Keep disabled
  | "enable"          // ⏻ Enable
  | "update"          // ⤓ Update to latest
  | "update-enable"   // ⤓ Update & enable
  | "install"         // ⤓ Install
  | "install-enable"; // ⤓ Install & enable
export interface ApplyItem { name: string; action: StateAction; }
export async function applyWithActions(
  ctx: CoreContext, items: ApplyItem[], onProgress?: ProgressFn
): Promise<GroupResult[]>
```

Per item, state steps run before config write, in order install/update → enable:

| action | on state-step failure |
|---|---|
| `install`, `install-enable` | config **still written** (staged; plugin isn't running, harmless). Row gets warning note. |
| `update`, `update-enable` | **config write skipped** (user declared the old version unsafe). Enable also skipped. Row gets warning note, `status: "warning"`. |
| `enable` | config still written; warning note. |

After state steps, the surviving names go through the existing `apply()` write path
(backup, transforms, classified writes) unchanged. `checkApply` and `ApplyWarning` are
deleted along with their tests.

`GroupResult` gains `stateNote?: { kind: "ok" | "warn"; text: string }`:

| outcome | stateNote text (verbatim) |
|---|---|
| installed, enabled | `⤓ installed & enabled {v}` |
| installed only | `⤓ installed {v}` |
| enabled only | `⏻ enabled` |
| updated only | `⤓ updated to {v}` |
| updated + enabled | `⤓ updated to {v} & enabled` |
| not-installed item applied with `none` | `staged for install` |
| install failed | kind `warn`, `⚠ install failed` + message `couldn't download {display} from the community catalog — settings were staged; install it manually to pick them up` (or the CatalogError variant `{display} isn't in the community catalog — install it manually; settings were staged`) |
| update failed | kind `warn`, `⚠ update failed` + message `couldn't download {display} from the community catalog — settings not applied; they were captured on a newer version` |
| enable failed | kind `warn`, `⚠ enable failed` + the bare underlying error message |

Enable uses `enablePlugin` (community) or new `enableCorePlugin` (core). After an install,
the host calls a new `reloadPluginManifests(): Promise<void>` (wraps
`app.plugins.loadManifests()`) before enabling.

## Part 2 — UI: Sync Center four sections

### 2.1 Layout (item mode, top to bottom)

Result strip (if any) → filter pills + main select-all → **main list** → **Outdated**
section → **Disabled** section → **Not installed** section → footer. Sections render only
when non-empty. Section states (expanded, checked names, chosen policies) persist for the
view's lifetime via the existing prune-by-name pattern.

- Main list holds: enabled items with no drift, enabled items with `ahead` drift, and all
  obsidian/core/custom groups regardless of drift.
- **Outdated** (`Outdated on this device`, count pill, pink accent): enabled community
  items with `behind` drift.
- **Disabled** (`Disabled on this device`, gray): disabled community/core items (any
  drift — composite ladder below).
- **Not installed** (`Not installed on this device`, amber): community items whose plugin
  dir is absent but the store has config.

Section headers: chevron, title, neutral count pill, `✓ {n}` pill when the section holds
in-sync items, hint `not staged` when collapsed, and a **section select-all checkbox**
(same control as the main list's, scoped to the section). Sections are collapsed and
unchecked by default; section items never count into top-level pills/badges/footer until
checked. In-sync items inside sections render `✓` instead of a checkbox.

### 2.2 Per-item policy segments ("On apply")

Shown in the expanded row under a small `On apply` label; selection persists; the collapsed
row shows a teal pill naming the policy **only when it includes a state action**
(`⤓ update`, `⏻ enable`, `⤓ update & enable`, `⤓ install & enable`, `⤓ install`). Checking
an item defaults its policy to the close-every-gap option.

| situation | options (first = default) |
|---|---|
| Outdated (enabled, behind) | `⤓ Update to latest` \| `Keep {local}` |
| Disabled, no drift | `⏻ Enable` \| `Keep disabled` |
| Disabled + behind | `⤓ Update & enable` \| `⏻ Enable` \| `Keep disabled` |
| Not installed | `⤓ Install & enable` \| `⤓ Install` \| `Stage only` |

Section notes (verbatim, italic, under the header when expanded):
- Outdated: `Store settings were captured on a newer plugin version than this device runs — updating first is the safe path.`
- Disabled: `Settings sync either way — choose whether applying also turns the plugin on.`
- Not installed: `Settings sync either way — choose whether applying also installs the plugin (latest version, from the community catalog).`

Direction segments: Outdated and Disabled rows keep the `↑ Capture | ↓ Apply store`
segment (local files exist); when direction is Capture the On apply segment hides.
Not-installed rows have neither direction segment nor capture ability (apply-only).

### 2.3 Version metadata lines (expanded rows, quiet)

- Outdated row: `this device {local} · store {store}`
- Disabled + behind: `this device {local} · store {store} — settings were captured on a newer version`
- Main list, ahead drift: `this device {local} · store {store} — newer here; capturing will refresh the store`
- Obsidian/core, app behind store (amber text): `captured on Obsidian {store} — this device runs {app}; update Obsidian if settings look off`
- Obsidian/core, app ahead (gray): `captured on Obsidian {store} · this device runs {app}`
- No line when versions match or either side is unknown.

### 2.4 Footer

Left text: `{n} staged` plus non-zero source segments joined with ` · `: `+{k} outdated`,
`+{k} disabled`, `+{k} to install`. Buttons unchanged (`↑ Capture {n} items`,
`↓ Apply {n} items`) — Apply's count is the grand total across list + sections. Progress
and `running`-flag behavior unchanged.

### 2.5 Search moves to the sidebar

The `Filter by name…` input renders at the top of the sidebar (above the scope list), like
Obsidian's settings search. Semantics change to **global across scopes**: matches any item
in any category (display name + raw id, as today). While a query is active: sidebar scope
badges show hit counts, the main pane shows only hits, and sections with hits auto-expand
showing only matching rows with a `{hits} of {total}` count pill; clearing restores the
previous expanded/collapsed state. In-sync fold contents match too. Remote mode disables
the input. Compact mode: the input moves back to the main bar next to the scope switcher.

## Part 3 — Inline result strips + report styling

### 3.1 Result strip (replaces ReportModal for hub actions)

After Capture / Apply / Pull / Push completes, no modal opens. Instead a **result strip**
renders at the top of the main pane (both item and remote modes): green accent for
Capture/Apply/Revert-style verbs, cyan for Pull/Push. Collapsed row: `✓` + verb title
(`Captured`, `Applied`, `Pulled from {remote}`, `Pushed to {remote}`) + `{n} changed`
neutral pill + `✓ {n}` green pill (when any unchanged) + `details ▸` toggle + `✕` dismiss.

Expanded content = the full report, shared markup with the restyled ReportModal (§3.2):
legend line, category sections with count pills, rows with display names + change chips +
stateNote pills, error/warning messages under rows, unchanged fold line, and the
`Some changes need an app reload` + `Reload app` CTA when any result needs it.

Lifecycle: a new run replaces the strip; `✕` clears it; closing the view clears it; it does
not survive reloads. External awareness refreshes re-render around it without clearing it.

### 3.2 Report styling (shared by strip + Revert modal)

- Legend under the title, small gray, verbatim: `+ added · ~ updated · − deleted (files)`.
- Each category section header carries a neutral count pill with the section's row count.
- Every change chip gets a tooltip (`title` attr): `{n} file(s) added|updated|deleted`
  with correct singular/plural.
- Store-metadata pseudo-row and unchanged fold line unchanged from today.
- Rows show `stateNote` pills (teal for ok, red for warn) between name and chips; warn
  notes also emit their message line in the row's detail block.
- ReportModal keeps this exact styling and remains used **only** by the Revert command.

### 3.3 Deletions

- `confirmWarnings` (`src/ui/ConfirmModal.ts`) and its callers in `main.ts`; the plain
  `ConfirmModal` class stays only if another caller exists — otherwise delete the file.
- `checkApply`, `ApplyWarning`, and their tests.
- ReportModal invocations for capture/apply/pull/push in `main.ts` (the Sync Center owns
  those flows' reporting; command-palette capture/apply also route their results into the
  open Sync Center strip, opening the view if needed).

## Edge cases

- An item both disabled and behind → Disabled section with the 3-option ladder (never in
  two sections). Not-installed items have no local version, so no drift composite exists.
- Scope interplay: Obsidian scope shows no sections; Core scope can only show Disabled.
- Remote mode: sections and search don't apply; result strip renders in the same top slot.
- Empty sections don't render; zero actionable items still leaves obsidian/core rows in
  the main list (fresh-device case).
- Compact/mobile: sections render full-width; segments wrap; no special casing beyond the
  search input relocation.
- Locked (`locked` GroupState) and no-settings items keep their existing treatment and
  never enter the new sections.

## Testing

Extend the existing node test suite (166 tests): availability bucketing + drift compare,
lock schema with `sourceAppVersion`, installer against a mocked `HttpGet` (catalog hit,
catalog miss, asset 404, styles-optional), `applyWithActions` outcome matrix (all six
actions × success/failure semantics, config-skip on update failure, config-write on
install failure), and manifest validation for the widened lock. UI behavior is covered by
the controller-run obsidian-cli smoke (sections, policies, strip, search relocation).
