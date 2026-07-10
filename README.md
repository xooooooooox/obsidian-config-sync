# obsidian-config-sync

Selective, on-demand distribution of Obsidian vault configuration (CSS snippets, hotkeys, plugin settings) across devices and vaults. The store rides your existing note-sync (e.g. remotely-save) by default, or config-sync's own git/vault-remote transport; landing is always an explicit, per-device **Apply**.

## How it works

Two planes, kept separate.

**Local plane** — this device's live config ↔ the store:

- **Capture** (source vault): copies the config groups defined in `<root>/config-sync.json` into `<root>/store/`, stripping credential keys (`sanitize` patterns) and recording source plugin versions in `<root>/store.lock.json`.
- **Apply** (any device): pick groups, get version-mismatch warnings, then land them into this device's config dir (`app.vault.configDir`, whatever its name). Sanitized keys keep their local values, so credentials entered once survive every apply. The previous state of every touched file is kept in a single-slot backup.
- **Revert last apply**: restores that backup.

**Transport plane** — the store ↔ elsewhere; how it travels between devices/vaults:

- **note-sync (default)**: the store is plain vault content, so your existing note-sync (remotely-save, Obsidian Sync, iCloud…) carries it everywhere — mobile included — with no configuration.
- **Pull / Push** (desktop, optional): config-sync's own transport for a git repo or another vault. **Pull** overwrites this vault's `<root>/` from a configured **remote** — repeatable, so cold start and ongoing use the same command; **Push** sends the local store out to a remote. The git transport clones to a temp dir and never touches your vault's own repo.

Commands live under one **Config Sync** ribbon icon that opens a menu of the currently-available actions (Capture/Apply/Revert always; Pull/Push when you're on desktop with at least one remote). Each command can also get its own ribbon icon — off by default; toggle them in Settings → Config Sync → **General**. Configure remotes under Settings → Config Sync → **Remotes**.

Pick what to sync in Settings → Config Sync. Items are grouped into tabs — **Obsidian** (global options), **Core plugins**, **Community plugins** — and within each tab by state (Available / Not yet in this vault / Not recommended, or Enabled / Disabled). Tick an item to sync it; each group has a **Sync all / Sync none** button. Core and community plugin names come from Obsidian at runtime. The Advanced tab groups rules into **Managed by pickers** (name fixed, path unlockable, reset to default individually or in bulk via Lock all / Unlock all / Reset all), **Discovered files** (config files we couldn't classify — name them to start syncing; path is fixed), and **Custom rules** (fully your own). Rule names are variable-style identifiers (lowercase letters, digits, `-`, `_`). A top **search box** finds items across all tabs. `workspace.json` and the `sync`/`publish` core plugins are shown under *Not recommended* and ask for confirmation before syncing. Everything is stored as named groups in `<data folder>/config-sync.json`.

## Store layout

```
<root>/                      # default "config-sync", configurable
├── config-sync.json         # group definitions (yours to edit)
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/…
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

`config-sync.json` example:

```json
{
  "$schema": "https://raw.githubusercontent.com/xooooooooox/obsidian-config-sync/main/schema/config-sync.schema.json",
  "version": 1,
  "groups": [
    { "name": "snippets", "path": "{configDir}/snippets", "type": "dir", "devices": "all" },
    { "name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all" },
    { "name": "vimrc", "path": ".obsidian.vimrc", "type": "file", "devices": "desktop" },
    { "name": "plugin-ioto-settings", "path": "{configDir}/plugins/ioto-settings/data.json",
      "type": "file", "devices": "all",
      "sanitize": ["*ForSync", "*ForFetch", "*APIKey*", "*Token*", "*Secret*", "userEmail"] }
  ]
}
```

Group fields: `name` (unique) · `path` (`{configDir}` variable supported) · `type` (`file`/`dir`) · `devices` (`all`/`desktop`/`mobile`) · `sanitize` (optional key-glob list, file groups only).

Never syncable (hard blacklist): `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync` plugin dirs. `workspace*.json` (window layout) is allowed but discouraged — ticking it asks for confirmation because devices will overwrite each other's layout.

## Configuring what to sync — walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys**, **Appearance**, **CSS snippets**.
2. Run `Capture: save this device's settings` (ribbon menu or command palette).
3. On each other device, run `Apply: update this device with synced settings` once your note-sync has delivered the data folder.

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, tick the plugin.
2. Open *Advanced* — the rule the tick created is listed there. Add sanitize patterns for its credential keys, e.g. `*Token*, *Secret*, *APIKey*`.
3. Capture. Credentials never enter the store; each device keeps its locally-entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Capture, and let remotely-save carry it; other devices Apply.

**Seed a second vault from another one, without a shared note-sync (desktop)**
1. In the target vault: Settings → Config Sync → **Remotes** → add a remote, type **Another vault**. Click **Browse…** and pick the source vault's folder — the store inside it is auto-detected and its absolute path fills the **Store path** field (or add a git remote instead: URL + branch, and optionally a folder in the repo).
2. Run `Pull: get settings from a remote` to overwrite this vault's store from that remote, then `Apply: update this device with synced settings`.
3. Later, from the source vault, `Push: send settings to a remote` to publish updates for the other vault to pull.

## Install

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add beta plugin `xooooooooox/obsidian-config-sync`.

## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note-sync tool moves them between devices. Two **optional, desktop-only** remote features go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (vault remotes and git temp clones).** If you add a remote of type "Another vault", Pull/Push read/write the absolute store path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.

Both features are disabled until you configure a remote, and never run without an explicit Pull or Push command.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

Develop against a dedicated test vault (never a real one).

## Releasing

1. `npm version <x.y.z>` — bumps `manifest.json` + `versions.json` (via `version-bump.mjs`), commits, and tags.
2. `git push --follow-tags`
3. The "Release Obsidian plugin" workflow builds, attests build provenance, and creates a **draft** GitHub release with `main.js`, `manifest.json`, `styles.css`.
4. Publish the draft on GitHub — BRAT only sees published releases.
