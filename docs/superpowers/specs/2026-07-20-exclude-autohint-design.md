# Surface auto (desktop-only) exclusions in the settings exclude list

## Problem

1.1.6/1.1.7 auto-except desktop-only plugins from the enabled-plugins switch list
**at runtime only** — `settings.switchExceptions` stays clean. So the settings
"Excluded from this list (this device)" section (`renderLocalDecisions`,
`SettingTab.ts`) shows only the user's *manual* excludes; the auto ones are
invisible. Real-vault repro (Screenshot_4, phone): `Better Export PDF` /
`Better File Link` (desktop-only, auto-excepted) show as **"included"**, so the
user can't tell they're already protected. Surface the auto exclusions there,
read-only, distinct from manual — 定稿 approved.

## Design

### 1. Data — `switchListRows` gains a `desktopOnly` flag

`main.ts switchListRows(groupName): Promise<{ id; name; hint }[]>` → add
`desktopOnly: boolean` per row. Computed from the **same runtime auto-except set**,
mobile-gated to match `augmentedSwitchExceptions`:

```ts
// after `const root = await this.resolvedRootPath();`
let dtoIds = new Set<string>();
if (Platform.isMobile && groupName === "community-plugins") {
  const lockPath = `${root}/store.lock.json`;
  let lock: StoreLock | null = null;
  if (await this.app.vault.adapter.exists(lockPath)) {
    try { lock = parseStoreLock(await this.app.vault.adapter.read(lockPath)); } catch { lock = null; }
  }
  dtoIds = desktopOnlyPluginIds(this.settings.groups, this.pluginHost(), lock);
}
```

then `desktopOnly: dtoIds.has(id)` on each mapped row. On desktop (or core-plugins),
`dtoIds` is empty → every row `desktopOnly: false` → the section is unchanged there.
Update the `SettingTab.ts` host interface signature (`switchListRows`) to include
`desktopOnly: boolean`.

### 2. Render — a read-only auto row

In `renderLocalDecisions`, classify each row:

- `isManual = exceptions.has(r.id)` — the user's manual exclude (unchanged path).
- `isAuto = r.desktopOnly && !isManual`.

For `isAuto`, render a read-only row instead of the editable one:

- Row class `config-sync-ldrow is-auto`.
- Name span, then a `config-sync-doto-pill` (the existing amber "desktop-only" pill,
  reused from the Sync Center), then the existing `config-sync-ldhint`.
- State span `config-sync-ldstate` text **"auto-excluded"**.
- A **disabled** toggle showing on: `new ToggleComponent(rowEl).setValue(true).setDisabled(true)`
  — Obsidian renders it greyed (distinct from the manual row's accent editable toggle).
  No `onChange`.
- Tooltip on the row/toggle: "Excluded automatically — this plugin can't run on this device."

Manual and included rows keep their exact current behavior. The header
`N excluded` badge continues to count **manual** exceptions only
(`exceptions.size`); auto exclusions appear in the list with the pill but are
system-managed and don't inflate the user's badge.

Precedence: a plugin that is both desktop-only **and** manually excluded renders as
manual (editable) — the user's explicit choice wins; `isAuto` is false when
`isManual`.

### 3. Styling

Both manual and auto rows carry the orange "local-decision" tint (DESIGN.md §1.1).
Reuse the manual selectors for auto:

```css
.config-sync-ldrow.is-local, .config-sync-ldrow.is-auto {
  border-color: rgba(var(--color-orange-rgb), 0.4);
  background: rgba(var(--color-orange-rgb), 0.05);
}
.config-sync-ldrow.is-local .config-sync-ldstate,
.config-sync-ldrow.is-auto .config-sync-ldstate { color: var(--color-orange); }
```

(Refactor the existing `.is-local` rules to the shared selector rather than
duplicating.) `.config-sync-doto-pill` already exists; no new color. The greyed
disabled toggle is Obsidian's default — no custom toggle CSS. Update `DESIGN.md`'s
local-decisions note to mention the auto/desktop-only read-only row.

## Testing

- `desktopOnlyPluginIds` is already unit-tested; the `desktopOnly` flag is
  `dtoIds.has(id)` and the row classification is trivial branching — no new pure
  unit. Verified by build + live.
- Gates: `npm test`, `npx eslint .` 0/67, `./scripts/check-no-hardcoded-color.sh`,
  `npm run build` clean.
- Live (dev vault, forced mobile): forge a `desktopOnly` lock flag for an installed
  plugin, open Config Sync settings → Enabled community plugins → confirm that
  plugin renders in the exclude list as an `is-auto` row with the `desktop-only`
  pill, "auto-excluded" state, and a disabled toggle; a manually-excluded plugin
  still shows its editable accent toggle; on desktop the section is unchanged.
  Restore forged state.

## Non-goals

- No change to the runtime auto-except (1.1.6/1.1.7), to persistence, or to the
  manual toggle behavior. Read-only display only.
- No override affordance (un-excluding a desktop-only plugin would re-introduce the
  footgun); auto rows are intentionally not editable.
