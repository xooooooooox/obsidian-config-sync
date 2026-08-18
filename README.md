<p align="center"><img src="assets/logo.svg" width="96" alt="Config Sync logo"></p>

# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)
[![Static Badge](https://img.shields.io/badge/README-EN-blue)](./README.md)
[![Static Badge](https://img.shields.io/badge/README-中-red)](./README.zh.md)

Selective, on-demand sync of Obsidian settings — hotkeys, CSS snippets, themes, plugin configs — across devices and vaults. The data rides your existing note sync (remotely-save, Obsidian Sync, iCloud…) by default, or config-sync's own git / vault remotes. Nothing ever lands on a device without an explicit **Apply** from the Sync Center.

> [!IMPORTANT]
> **Update every device before any of them captures or pulls again.**
> **2.23.0** moved the settings to a new format, and the move is one way. A device still on **2.21.0** or **2.22.0** meets the new format, refuses it with a plain message and changes nothing. A device on **2.20.0 or earlier resets its Config Sync settings to defaults** — that one cannot be fixed afterwards. Update Config Sync everywhere first, then carry on as usual.
> A plugin nobody ever set a rule for now follows the shared on/off list, once that list itself is synced — so **the first sync after upgrading may turn some plugins on or off**, converging whatever differences had silently built up between your devices. See [Updating from 2.21.0 and earlier](docs/GUIDE.md#updating-from-2210-and-earlier).

![Sync Center](docs/assets/sync-panel.png)

## Features

- **One card per item** — every synced thing (an Obsidian option group, a core or community plugin, a snippet) is one row with an expandable drawer holding its rules; a plugin's on/off state lives on its own card. ([details](docs/GUIDE.md#settings))
- **Orthogonal field rules** — every key answers two independent questions, who shares it (`All devices` / `Desktop only` / `Mobile only` / `Not shared`) and whether it travels encrypted; list-shaped keys can rule each element separately, and any key — or the whole file — can also be excepted on just this device, leaving the shared answer untouched for everyone else. ([details](docs/GUIDE.md#field-rules--sensitive-settings))
- **Credential-safe** — `Not shared` keys never leave the machine, and a per-device passphrase encrypts what should travel.
- **Explicit Apply** — nothing changes a device until you tick items and press Apply; every run stays visible in the pinned result strip and a browsable **History**.
- **A Sync Center that knows the state** — every row spells out its own fate in plain language (*turns on · installs · applies settings*), normalized JSON diffs, a *this device* status chip and totals for every pending action. ([tour](docs/GUIDE.md#the-sync-center))
- **Install engine** — plugins that are outdated, disabled or missing on this device can be updated, enabled or installed during Apply, pinned to the captured version. ([rules](docs/GUIDE.md#availability-facts-and-the-install-engine))
- **Remotes (desktop)** — pull/push the store against a git repo or another vault, with per-file diff previews. ([details](docs/GUIDE.md#transport))
- **Safe to update one device at a time** — anything written by a newer Config Sync is refused with a plain message, never reset or overwritten (protection starts at 2.21.0 — see the notice above for older devices). ([details](docs/GUIDE.md#transport))
- **Search everywhere** — both search boxes accept `key:value` qualifiers with autocomplete, combined freely with plain text: the Sync Center takes `section:` · `type:` · `action:` · `mode:` · `device:`, the settings search `section:` · `type:`.
- **Status bar** — ↑ capture / ↓ apply plus per-remote ⇡ push / ⇣ pull counts at a glance; click opens the Sync Center.
- **Mobile-friendly** — capture, apply and the Sync Center work on phones; the store is plain vault content, so any note sync carries it.

## Install

From Obsidian: **Settings → Community plugins → Browse**, search **Config Sync**, install and enable.

Beta builds: via [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `xooooooooox/obsidian-config-sync`.

## Quick start

1. **Settings → Config Sync** — tick what you want to sync (Obsidian / Core plugins / Community plugins / Beta tabs).
2. Open **Sync Center** from the ribbon menu (or the **Open Sync Center** command), tick what to capture, and press **Capture N items**.
3. On another device, once your note sync has delivered the data folder: open **Sync Center**, tick what to apply, and press **Apply N items**.

![Settings picker](docs/assets/settings-picker.png)

## How it works

Two planes, kept separate.

- **Local plane** — **Capture** copies every enabled item's settings files and companion folders into the store, applying each field's sharing and encryption rule; **Apply** lands the items you tick into this device's config dir. Direction (↑ capture, ↓ apply) comes from a per-device sync baseline, not file times, so the Sync Center can tell which side actually moved.
- **Transport plane** — by default the store is plain vault content and rides your note sync; a fresh device discovers an arriving store on its own and offers an **Adopt** guide. Optionally (desktop), Pull/Push move the store against a git repo or another vault from the Sync Center's Remotes block.

The full tour — Sync Center anatomy, field rules, encryption, the install engine, remotes, walkthroughs — lives in the **[user guide](docs/GUIDE.md)**.

## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note sync moves them between devices. Three **optional, desktop-only** remote behaviors go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (vault remotes and git temp clones).** If you add a remote of type "Another vault", Pull/Push read/write the absolute store path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.
- **Access tokens (git remotes only).** A token you link to a git remote is held in Obsidian's own keychain on that device and handed to `git` through the environment, never through the command line. Only the secret's *name* is written to the plugin's settings — the token itself never enters `data.json`, the store, or any error message. Config Sync never sends the remotes list anywhere either (it is a locked this-device field), so the name reaches another device only if your own vault sync copies the plugin's `data.json`; each device links its own token, or none at all.

All three are inert until you configure a remote, and never run without an explicit Pull or Push from the Sync Center.

## Documentation

- **[User guide](docs/GUIDE.md)** — every behavior in one place: the Sync Center, field rules, sensitive settings, transport, walkthroughs.
- **[Architecture](docs/ARCHITECTURE.md)** — code map and invariants, for contributors.
- **[Design system](docs/design/DESIGN.md)** — the UI's tokens, icon vocabulary and component rules.
- **[schema/](schema/)** — JSON Schemas documenting every persisted shape (`data.json`, the store lock, local storage, run history).

## Development

See **[CONTRIBUTING.md](CONTRIBUTING.md)** for setup, commands, the dev-vault smoke
workflow and the release process. Develop against a dedicated test vault, never a real one.

## License

[MIT](LICENSE)
