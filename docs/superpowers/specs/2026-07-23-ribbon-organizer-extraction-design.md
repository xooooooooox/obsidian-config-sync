# Ribbon Organizer — Quick Commands extraction (design)

Date: 2026-07-23
Status: approved design, pending user review

## Background

Quick Commands (a user-configurable command menu on a ribbon icon) currently lives inside the
config-sync plugin, but it is functionally independent. The owner wants it extracted into a
standalone plugin, **Ribbon Organizer**, targeted at the official Obsidian community plugin store.

Long-term positioning: "the left-ribbon steward" — menu-style command aggregation plus ribbon icon
grouping/ordering (replacing the hand-written `mystyle-ribbon.css` snippet). This design covers
**sub-project 1 only**: extraction of Quick Commands at feature parity, and its removal from
config-sync. Ribbon grouping/ordering is **sub-project 2** with its own future design round
(mechanism candidates: dynamic CSS injection vs read-only `leftRibbon.items`; decision deferred).

## Decisions (from brainstorming)

- **Approach:** new standalone plugin reusing the config-sync toolchain — NOT a fork of Commander.
  Commander (`jsmorabito/obsidian-commander`, MIT, actively maintained) remains a reference
  implementation only.
- **Name / id:** Ribbon Organizer / `ribbon-organizer`. Repo: `~/local/coding/open/obsidian-ribbon-organizer`.
- **Project initialization:** same approach as obsidian-config-sync — bootstrap from the official
  `obsidianmd/obsidian-sample-plugin` template, then layer the config-sync conventions on top
  (strict tsconfig, eslint/vitest setup, `version-bump.mjs` + `.npmrc` `tag-version-prefix=""`,
  CI release workflow, `dev/vault` test vault).
- **Initial version: 0.1.0.**
- **Distribution:** GitHub releases (BRAT) first; official community-store submission after the
  plugin is verified live.
- **config-sync side:** version **1.7.0** removes Quick Commands entirely. No automatic import —
  the user reconfigures the (short) list manually in Ribbon Organizer.
- **Red-box fix:** the settings rows no longer show the raw command id (`remotely-save:start-sync`
  etc.). This lands as part of the ported UI, not as a separate config-sync patch, since the whole
  panel disappears in 1.7.0.

## Part A — Ribbon Organizer 0.1.0

### Identity & toolchain

- `manifest.json`: id `ribbon-organizer`, name `Ribbon Organizer`, description
  "Group your ribbon and launch commands from a configurable ribbon menu.", MIT license,
  `isDesktopOnly: false`, `minAppVersion` same as config-sync's current value.
- Toolchain copied from config-sync verbatim: esbuild bundle, strict TypeScript with
  `noUncheckedIndexedAccess: true`, eslint (including `eslint-plugin-obsidianmd` sentence-case
  rules), vitest, `version-bump.mjs` (tag without `v` prefix), CI release workflow producing a
  Draft with `main.js` / `manifest.json` / `styles.css`, hand-written release notes.
- **Lint baseline for the new repo: 0 warnings.**
- Core purity rule carries over: nothing under `src/core/` imports from `"obsidian"`.

### Architecture (files)

Ported from config-sync with only naming/copy changes:

- `src/core/types.ts` — `QuickCommand { commandId; label; icon }`, `QuickSeparator { kind: "separator" }`,
  `QuickEntry`, `isSeparator` (verbatim from config-sync `core/types.ts`).
- `src/core/quickCommands.ts` — `quickMenuEntries(entries, isRegistered)` (verbatim: separator
  normalization, `disabled` flag for unregistered commands, collapse to `[]` when no command).
- `src/core/icons.ts` — `IconPack` / `IconChoice` / `iconChoices(builtinIds, packs)` (verbatim:
  built-ins first, custom packs excluding `lucide-icons`, id = prefix+name).
- `src/ui/iconRender.ts` — `iconizeApi` / `iconizePacks` / `renderIcon` (verbatim: chain
  setIcon → iconize `setIconForNode` → `node.empty()` on miss → command's default icon → `"command"`).
- `src/ui/IconSelectModal.ts`, `src/ui/CommandSelectModal.ts` — verbatim ports.
- `src/ui/SettingTab.ts` — the Quick commands section only (see UI changes below).
- `src/main.ts` — plugin entry: settings load/save, ribbon icon, menu.
- `styles.css` — the `*-qc-*` / icon-picker rules ported with a `ribbon-organizer-` class prefix.

### Behavior

- **Ribbon icon:** lucide `menu`, tooltip `Ribbon Organizer` (static; no status dot, no counts).
- **Click → menu:** `new Menu()` with `menu.setUseNativeMenu(false)` (required: macOS native menus
  cannot render Lucide/iconize icons — root cause established in config-sync 1.6.1). Items come
  from `quickMenuEntries(settings.quickCommands, id => id in app.commands.commands)`:
  - command → title = label, icon via `renderIcon` on the item's `iconEl`, disabled greyed via
    `setDisabled(true)`, click runs `app.commands.executeCommandById(commandId)`.
  - separator → `menu.addSeparator()`.
  - empty result → single disabled item "No commands configured — add them in the plugin settings".
- **Cross-device behavior:** the list lives in the plugin's `data.json` (synced by whatever vault
  sync the user runs). A command not registered on the current device is greyed out in menu and
  settings; it recovers automatically once the providing plugin is installed. Iconize remains
  entirely optional (missing pack → command's default icon).

### Settings UI (ported, with changes)

Single section "Quick commands", description "Commands shown in the Ribbon Organizer menu. A
command not installed on this device is greyed out." Per-row: icon button (opens IconSelectModal),
editable label input, move up/down, delete; separator rows; "Add command" (CommandSelectModal) and
"Add separator" buttons with the existing spacing fix.

**Changes vs the config-sync original:**

1. The command-id meta line (`config-sync-qc-cid`) is **removed**. No row shows the raw command id.
2. The "not on this device" information it carried is kept: when the command is missing, the row
   shows a small meta line "Not on this device" (and the row stays greyed as today). When the
   command is present, no meta line renders at all.

### Data

`data.json` shape: `{ "quickCommands": QuickEntry[] }` (default `[]`). No other settings in 0.1.0.
No import/migration code from config-sync.

### Testing & error handling

- Port `tests/quickCommands.test.ts` and `tests/icons.test.ts` unchanged (they test pure core).
- Non-public API access stays behind guarded casts (`(x as unknown as {...})`) exactly as in
  config-sync; iconize absence is a normal state, not an error.
- Gate for every task: build clean, tests green, lint 0 warnings.

### Release & store submission

1. Publish 0.1.0 on GitHub (CI Draft → hand-written notes → publish), install via BRAT, live-verify
   on the owner's vault (menu icons on macOS, iconize pack icons, missing-command grey-out).
2. Only then: community-store submission — README with screenshots, `LICENSE`, PR to
   `obsidianmd/obsidian-releases`. Submission is a follow-up task after 0.1.0 is verified, not part
   of the implementation plan's gate.

## Part B — config-sync 1.7.0 (removal)

Sequenced **after** Ribbon Organizer 0.1.0 is live-verified.

- Remove the Quick commands settings section and the quick entries from the ribbon menu — the menu
  keeps exactly `Sync Center (…)` and `Revert last apply`, still with
  `menu.setUseNativeMenu(false)` (their icons still need a DOM menu).
- Delete now-unused files and their tests: `core/quickCommands.ts`, `core/icons.ts`,
  `ui/iconRender.ts`, `ui/IconSelectModal.ts`, `ui/CommandSelectModal.ts`,
  `tests/quickCommands.test.ts`, `tests/icons.test.ts`; remove the `config-sync-qc-*` and
  `config-sync-iconpick*` CSS blocks.
- Drop `quickCommands` from the settings interface and defaults; on load, delete a stale
  `quickCommands` key from persisted data once so `data.json` cleans itself on next save.
- Docs currency rule applies: update README/zh/ARCHITECTURE/DESIGN in the same change.
- Lint baseline stays at or below 67; release as 1.7.0 with hand-written notes.

## Out of scope (sub-project 2 and later)

- Ribbon icon grouping/ordering/dividers (replaces `mystyle-ribbon.css`; mechanism A vs B to be
  brainstormed separately). Until then the CSS snippet stays in the vault.
- Macros, multiple menu entries, submenus, status-bar entry, drag-and-drop reordering.
