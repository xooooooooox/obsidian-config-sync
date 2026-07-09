# obsidian-config-sync

Selective, on-demand distribution of Obsidian vault configuration (CSS snippets, hotkeys, plugin settings) across devices and vaults. Transport rides your existing note-sync (e.g. remotely-save); landing is an explicit, per-device **Apply**.

## How it works

- **Publish** (source vault): copies the config groups defined in `<root>/config-sync.json` into `<root>/store/`, stripping credential keys (`sanitize` patterns) and recording source plugin versions in `<root>/store.lock.json`. The store is plain vault content — your note-sync carries it everywhere.
- **Apply** (any device): pick groups, get version-mismatch warnings, then land them into this device's config dir (`app.vault.configDir`, whatever its name). Sanitized keys keep their local values, so credentials entered once survive every apply. The previous state of every touched file is kept in a single-slot backup.
- **Revert last apply**: restores that backup.
- **Import from external source** (desktop): overwrite this vault's `<root>/` from another vault — via filesystem path, or via a read-only git remote (`fetch` + `ls-tree` + `show`, worktree untouched).

All four commands have ribbon icons (Publish, Apply, Revert last apply; Import from external source is desktop-only).

Pick what to sync in Settings → Config Sync: tick items under **Obsidian** (hotkeys, appearance, CSS snippets, …) and **Community plugins** (a plugin's settings — the plugin itself still installs from the store or BRAT). No paths to type; each ticked item can be limited to desktop or mobile. The **Advanced** section holds custom rules for anything else — vault-root files, extra folders, or per-key credential protection (sanitize). Under the hood every choice is stored as a group in `<data folder>/config-sync.json` (JSON Schema included), created automatically on first use. **PKM mode** picks the default data folder — Auto detects IOTO via the `ioto-update` plugin and uses `<extraFolder>/config-sync` read from ioto-settings (fallback `0-Extra/config-sync`); otherwise `config-sync`. A non-empty Data folder always overrides the mode; leave it empty to follow.

## Store layout

```
<root>/                      # default "config-sync", configurable
├── config-sync.json         # group definitions (yours to edit)
├── store.lock.json          # publish metadata (machine-written)
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

Never syncable (hard blacklist): `remotely-save`, `ioto-update`, `slides-rup`, `obsidian-config-sync` plugin dirs and `workspace*.json`.

## Configuring what to sync — walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys**, **Appearance**, **CSS snippets**.
2. Run `Config Sync: Publish` (ribbon or command palette).
3. On each other device, run `Config Sync: Apply` once your note-sync has delivered the data folder.

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, tick the plugin.
2. Open *Advanced* — the rule the tick created is listed there. Add sanitize patterns for its credential keys, e.g. `*Token*, *Secret*, *APIKey*`.
3. Publish. Credentials never enter the store; each device keeps its locally-entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Publish, and let remotely-save carry it; other devices Apply.

## Install

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add beta plugin `xooooooooox/obsidian-config-sync`.

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
