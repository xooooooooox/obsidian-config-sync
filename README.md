# obsidian-config-sync

Selective, on-demand distribution of Obsidian vault configuration (CSS snippets, hotkeys, plugin settings) across devices and vaults. Transport rides your existing note-sync (e.g. remotely-save); landing is an explicit, per-device **Apply**.

## How it works

- **Publish** (source vault): copies the config groups defined in `<root>/manifest.json` into `<root>/store/`, stripping credential keys (`sanitize` patterns) and recording source plugin versions in `<root>/store.lock.json`. The store is plain vault content — your note-sync carries it everywhere.
- **Apply** (any device): pick groups, get version-mismatch warnings, then land them into this device's config dir (`app.vault.configDir`, whatever its name). Sanitized keys keep their local values, so credentials entered once survive every apply. The previous state of every touched file is kept in a single-slot backup.
- **Revert last apply**: restores that backup.
- **Import from external source** (desktop): overwrite this vault's `<root>/` from another vault — via filesystem path, or via a read-only git remote (`fetch` + `ls-tree` + `show`, worktree untouched).

## Store layout

```
<root>/                      # default "config-sync", configurable
├── manifest.json            # group definitions (yours to edit)
├── store.lock.json          # publish metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/…
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

`manifest.json` example:

```json
{
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

## Install

Via [BRAT](https://github.com/TfTHacker/obsidian42-brat): add beta plugin `xooooooooox/obsidian-config-sync`.

## Development

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

Develop against a dedicated test vault (never a real one). Releases: tag `x.y.z`, attach `main.js` + `manifest.json` to the GitHub release.
