<p align="center"><img src="assets/logo.svg" width="96" alt="Config Sync logo"></p>

# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)
[![Static Badge](https://img.shields.io/badge/README-EN-blue)](./README.md)
[![Static Badge](https://img.shields.io/badge/README-中-red)](./README.zh.md)

Selective, on-demand sync of Obsidian settings — hotkeys, CSS snippets, themes, plugin configs — across devices and vaults. The data rides your existing note sync (remotely-save, Obsidian Sync, iCloud…) by default, or config-sync's own git / vault remotes. Nothing ever lands on a device without an explicit **Apply** from the Sync Center.

> **Breaking upgrade.** This version changes both the store format and the settings schema (`schemaVersion: 2`) — there is no migration from an older install. Upgrade every device to this version together, then revisit **Settings → Config Sync** on each one and re-tick what you want to sync before capturing or applying again.

![Settings picker](docs/assets/settings-picker.png)

## Features

- **One card per item** — every synced thing (an Obsidian option group, a core or community plugin, a snippet) is the same row + expandable drawer: name, badges, a sync on/off toggle, and — once opened — up to three zones: **Enabled on** (which devices turn a plugin on), **Settings file** (its rules), **Companion folders** (themes, snippets, or any folder you add). No more separate "Enabled community plugins" / "Enabled core plugins" rows — a plugin's on/off state lives on its own card.
- **Orthogonal rules, per key** — every field rule is a `{scope, encrypted}` pair you can combine freely: `All devices`, `Desktop only`, `Mobile only` or `This device`, each independently encryptable. A whole file can also be marked encrypted, not just individual fields. String-array keys (a plugin's enabled-elements list, CSS snippets, `app.json`'s `userIgnoreFilters`…) get a **Per-item scopes** toggle so every element carries its own scope instead of one rule for the whole key — one mechanism behind per-plugin enablement, per-snippet scope and per-ignore-pattern scope alike.
- **Credential-safe** — per-key or whole-file encryption keeps sensitive keys out of the store in plaintext; each device keeps its locally entered `This device` values across applies.
- **Explicit Apply** — pick items, land them directly (no confirmation dialog); every run's changes stay visible in the pinned result strip and **History**.
- **Removable and tidy** — stop syncing an item at any time (optionally deleting its store copy), and store files left behind with no matching item surface as **Leftover** for one-click cleanup.
- **Always-visible awareness** — open the **Sync Center** any time for the details; its header is its own status bar: a *this device* chip (a green check when everything is in sync, otherwise the current state and a shortcut into settings) followed by the totals for every pending action, including per-remote push/pull counts. Every item is badged by state (`✓ in sync`, changed-on-this-device, store-is-newer, not-synced-on-this-device-yet, `≠ differs`, `— not captured yet`), each sync action (Capture, Apply, Push, Pull) has its own icon, JSON diffs render with keys in a normalized order so a pure key-order/formatting difference is called out instead of showing as noise, and remotes are checked automatically.
- **Status bar** — sync status at a glance: ↑ to capture, ↓ to apply, plus per-remote ⇡ push / ⇣ pull counts; click opens the **Sync Center**. All in sync shows just a dimmed icon. The old ribbon-icon dot is now opt-in (off by default), and a mobile-only toggle can force Obsidian's hidden status bar visible on phones.
- **Availability-aware** — plugins that are outdated, disabled, or not installed on this device get their own collapsed sections with a plugin-install/update engine, so applying can also update, enable or install a community plugin in the same step. A **Beta** tab tracks community plugins installed through BRAT, so their configs sync like any other.
- **Remote-aware** — the Sync Center's Remotes block auto-checks whether a git or vault remote was captured after your local store; expand a remote for a Pull/Push preview.
- **Fast filtering & search** — both search boxes accept `key:value` qualifiers with autocomplete: in the Sync Center `type:`/`scope:`/`action:`/`mode:`/`device:`, in settings `scope:`/`type:` — combined freely with plain text.
- **Mobile-friendly** — capture, apply and the Sync Center all work on phones; the store is plain vault content, so any note sync carries it.

## Install

From Obsidian: **Settings → Community plugins → Browse**, search **Config Sync**, install and enable.

Beta builds: via [BRAT](https://github.com/TfTHacker/obsidian42-brat), add `xooooooooox/obsidian-config-sync`.

## Quick start

1. **Settings → Config Sync** — tick what you want to sync (Obsidian / Core plugins / Community plugins tabs).
2. Open **Sync Center** from the ribbon menu (or the **Sync: open the sync panel** command), tick what to capture, and press **Capture N items**.
3. On another device, once your note sync has delivered the data folder: open **Sync Center**, tick what to apply, and press **Apply N items**.

## How it works

Two planes, kept separate.

**Local plane** — this device's live config ↔ the store:

- **Capture** copies every enabled item's settings file and companion folders into `<data folder>/store/`, applying each field's `{scope, encrypted}` rule (or the whole-file rule, for items with no per-key rules), skips OS junk files, and records source plugin versions (or the Obsidian app version, for Obsidian/core items) in `store.lock.json`. Only changed files are rewritten; the Sync Center's Capture button captures just what you've ticked.
- **Apply** picks items and lands them into this device's config dir (whatever its name) — there's no confirmation dialog; ticking and pressing Apply executes directly. For a community plugin that's outdated, disabled or not installed on this device, Apply can also update, enable or install it first (see below). This-device-scoped fields and encrypted content resolve per the item's rules; a `This device` field keeps its local value untouched.
- The **Sync Center** compares live config against the store per item; direction (↑ to capture, ↓ to apply) comes from a per-device sync baseline, not file times — each time this device sees an item in sync, it remembers a fingerprint of both sides, so a later difference can tell which side actually moved. An item with no baseline on this device yet (a fresh install, or one pending its first sync since upgrading) shows as **not synced on this device yet** and defaults to apply; one that changed on both sides since this device's last sync shows as `≠ differs`. Remote freshness is still checked automatically.

### Availability sections and the install engine

Beyond the main list, the Sync Center groups community/core plugin items by what's true on *this* device, in collapsed, opt-in sections that never count into the header pills, sidebar badges, filter pills or footer until you tick something inside them:

- **Outdated on this device** — enabled plugins whose installed version is behind what the store was captured on.
- **Disabled on this device** — plugins whose config is tracked but the plugin itself is switched off here.
- **Not installed on this device** — plugins the store has config for but that aren't installed here at all.

Each row in these sections carries an **On apply** choice alongside the usual checkbox — the checkbox decides whether the item's config is part of this run, the On apply choice decides what happens to the plugin's state before that config lands:

- Outdated: `⤓ Update to latest` (default) or `Keep {version}`.
- Disabled, no version drift: `⏻ Enable` (default) or `Keep disabled`.
- Disabled and outdated: `⤓ Update & enable` (default), `⏻ Enable`, or `Keep disabled`.
- Not installed: `⤓ Install & enable` (default), `⤓ Install`, or `Stage only`.

Installs and updates fetch the plugin from the official community plugin catalog, **pinned to the version the store was captured on** (recorded in `store.lock.json`) so every device converges on the same version; when that exact release is missing it falls back to the latest stable with a warning. A plugin that isn't in the catalog is staged (its config is written, ready for whenever you install it manually) with a note to that effect. A failed update leaves the existing config untouched (an old version is assumed unsafe to overwrite blindly); a failed install still stages the config, since an uninstalled plugin can't be harmed by it. **A single failure never aborts a bulk install** — the offending plugin becomes one error row in the result and the rest of the batch still installs.

A plugin ahead of the store's recorded version shows a quiet metadata line instead of a section (capturing again will refresh the store). Obsidian and core-plugin items are anchored to the Obsidian app version rather than a plugin version — drift there is reminder-only in both directions and never drives an install/update action.

**Transport plane** — how the store travels:

- **Your note sync (default)**: the store is plain vault content — remotely-save, Obsidian Sync, iCloud or anything else carries it everywhere, mobile included, zero configuration. On a **fresh device**, once the store arrives, the Sync Center discovers it on its own and shows an **Adopt** banner; adopting it runs a one-time guide that walks you through applying the store to set the device up — and warns against capturing over it with the new device's empty defaults. Until you adopt, a dismissible banner at the top of the item list explains that the diffs below aren't trustworthy yet — adopt the plugin's own settings first, since they carry the scopes and device rules the comparison depends on.
- **Pull / Push (desktop, optional)**: config-sync's own transport for a git repo or another vault on this machine, run from the Sync Center's Remotes block. Pull overwrites this vault's store from a remote (repeatable — cold start and ongoing use are the same action); Push sends it out. The git transport clones to a temp dir and never touches your vault's own repo.

Everything hangs off one **Config Sync** ribbon icon; clicking it opens a menu with **Sync Center** (badged with the pending capture/apply counts), which opens (or focuses, if already open) the Sync Center, where Capture/Apply/Pull/Push all happen. The status bar is the primary always-visible indicator; the ribbon icon's own status dot is opt-in and off by default (**Settings → General → Status bar**). An individual ribbon icon for the Sync Center is available under **Settings → General**, off by default. Quick commands moved to the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin.

Capture, Apply, Pull and Push each finish by rendering a result strip **pinned to the top of the Sync Center** — a collapsible summary (changed/unchanged counts, per-item detail on demand) rather than a popup dialog, so it stays visible while you scroll a long list and doesn't interrupt further ticking. Its tone reflects the outcome — green when the run is clean, amber or red when items need attention, with failures expanded by default. Every run is also recorded in a browsable, clearable **History**: a sidebar entry opens a table of past runs (a card list on narrow/mobile screens, so it reads top-to-bottom with no horizontal scroll), each expandable to its per-item detail.

The Sync Center header is a status bar: a **this device** chip shows Config Sync's own sync state — a green check when in sync, otherwise its state plus a Settings shortcut — followed by totals for every pending action, including per-remote push/pull counts. The chip opens the **this device** pane, where Config Sync's own configuration (its item list, field rules and options) is captured and applied like any other item; when that list changes, an expandable *view change* shows the exact `data.json` delta and what capturing will publish.

The **Filter by name…** search box lives in the Sync Center's sidebar and searches globally across every scope at once (Obsidian, Core plugins, Community plugins, snippets, themes, dotfiles). Beyond plain text it accepts `key:value` qualifiers — `type:` (file/folder), `scope:` (obsidian/core/community/beta/custom), `action:` (capture/apply/ok/none), `mode:` (plain/fields/encrypted) and `device:` (all/desktop/mobile) — that narrow together and combine with free text, with an autocomplete dropdown that opens as soon as the box is focused, suggesting keys then values. The sidebar shows a hit count per scope and sections with a match auto-expand to show just the hits.

![Sync Center](docs/assets/sync-panel.png)

## Settings guide

- **General** — PKM mode (auto-detects IOTO vaults), the data folder location, status toggles (sync menu change counts, automatic remote checks, periodic local check), the status bar (item, remote push/pull counts, opt-in ribbon dot, mobile force-show), ribbon icons.
- **Obsidian / Core plugins / Community plugins / Beta** — every row is a card: name, badges (a grey `desktop-only plugin` chip when the plugin can't run on mobile, `on: desktop`/`on: mobile`/`on: this device` when a plugin's enabled state isn't the default, plus counts of device-scoped and encrypted rules), a sync toggle, and a chevron that opens its drawer. The **Obsidian** tab has three cards: **App settings** (the whole `app.json` — editing, new-note and link behavior, and other general options), **Appearance** (theme, fonts and CSS snippets) and **Hotkeys** (your custom keyboard shortcuts). Core and Community plugins are listed in full: a core plugin with no settings file yet is a state-only card (just its **Enabled on** zone) until it writes one. The **Search all settings…** box spans General, all picker tabs, Advanced and Remotes, and accepts `scope:` (general/obsidian/core/community/advanced/remotes) and `type:` (file/folder) qualifiers with autocomplete alongside plain text. The **Beta** tab tracks community plugins installed through [BRAT](https://github.com/TfTHacker/obsidian42-brat) — same card, same three drawer zones — so their configs sync like any other plugin. Each section lists its cards alphabetically; sensitive-looking keys (tokens, secrets) are highlighted inside a card's File preview so you see them before enabling syncing.
- A card's drawer has up to three zones, and every scope control in them is the same cycling icon: the glyph shows the current scope (a monitor+phone pair = `All devices`, a monitor = `Desktop only`, a phone = `Mobile only`, an airplay mark = `This device`), a click advances to the next value, and the default sits dimmed while anything narrower lights up in the accent color. **Enabled on** (plugin cards only) is one such icon for which devices turn the plugin itself on; it reads and writes the same enabled-plugins list Obsidian maintains. **Settings file** starts as one path row — the file's path, a scope icon (no `This device` here) and a lock toggle that encrypts the whole file; the path text itself is the edit entry point — click it to edit in place (Enter commits, Esc cancels, and while editing a committed custom path a quiet **Reset to default** action restores the built-in default). Below it, a collapsed **File preview** (`▸ File preview`) expands into a read-only view of the file, keys colored by their rule, with a color-dot legend underneath (blue = desktop only, amber = mobile only, red = this device, a lock mark = encrypted); click a key to add a rule for it directly. The moment a card has any per-key rule, it switches to per-key mode: the path row's own scope/lock dim (each ruled key now governs itself), and a row appears per configured key with its own scope icon, a lock toggle (greyed out at `This device`) and a ✕ to remove the rule; a string-array key's rule adds a **Per-item scopes** toggle so each element gets its own scope icon instead of one rule for the whole key. Removing the last rule reverts the card to whole-file mode. **Companion folders** lists any vault-relative folder that travels with the item — Appearance ships `themes/` and `snippets/` as presets, and every card's drawer ends with a quiet **+ Add folder** row to add any other path (duplicates and paths already claimed by another item are rejected); each folder row has a scope icon and a sync toggle (plus a ✕ on any folder you added yourself), and clicking the folder's name opens its path for editing. A folder's member list is collapsed behind a `· N files`/`· N themes` count — click to expand it. Opening `snippets/` lists each file as its own row with a scope icon: the file itself always syncs, and the icon only decides which devices turn it on. Any other companion folder syncs as a whole, so its members list for information only, without a per-file scope.
- **Advanced** — **Custom rules** (fully yours: vault-root files, extra folders, sync modes) and **Discovered files** (config files we couldn't classify; toggle to sync — name and path are fixed by the file), each row using its own field-rule editor (a `This device`/`Encrypted`/`Desktop only`/`Mobile only` action dropdown, separate from a card's icon-based Settings file zone). When any managed item is customized (path, fields or mode diverge from its default), a summary banner lists them with a **↺ Reset all to defaults** button.
- **Remotes** (desktop) — add a **git repository** (URL, branch, optional folder) or **another vault**: click **Browse…**, pick the vault folder, and the store inside it is auto-detected.

## Store layout

```
<data folder>/               # default "config-sync", configurable
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/… (device-independent)
    │   └── *.__scopes__.desktop.json / *.__scopes__.mobile.json   # Desktop-only/Mobile-only field sidecars
    │   # a whole-file-encrypted item sits at its normal path as an encrypted JSON envelope ("csenc": 1)
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

There is no hand-edited rule file anymore — what syncs, and each field's `{scope, encrypted}` rule, is configured entirely through **Settings → Config Sync**'s cards (stored in the plugin's own settings, `schemaVersion: 2`) and, for anything a card doesn't cover, the **Advanced → Custom rules** editor in the same tab. OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never captured. See [Sensitive settings](#sensitive-settings) for per-item rules and passphrase-protected encryption.

## Walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys** and **Appearance** (its card covers the settings file plus the `themes/` and `snippets/` companion folders).
2. Open **Sync Center** from the ribbon menu and press **Capture N items**.
3. On each other device, once your note sync has delivered the data folder: open **Sync Center** and press **Apply N items**.
4. Open the Appearance card's `snippets/` companion folder to give any snippet its own scope: `All devices` (synced everywhere) / `Desktop only` / `Mobile only` (shared, travels, and is enforced on the other device class) / `This device` (keeps its own on/off here, never synced). A plugin's **Enabled on** zone works the same way for which devices turn it on (a desktop-only plugin's cycle skips the mobile stop).

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, open the plugin's card.
2. In its **File preview**, click each credential key to add a rule, set its scope to `This device` (or turn on its lock if you want it to travel).
3. Capture. This-device credentials never enter the store; each device keeps its locally entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Capture from the Sync Center, and let remotely-save carry it; other devices Apply from their own Sync Center.

**Seed a second vault from another one, without a shared note sync (desktop)**
1. In the target vault: Settings → Config Sync → **Remotes** → add a remote of type **Another vault**, click **Browse…** and pick the source vault's folder — its store is auto-detected into **Store path** (or add a git remote: URL + branch, optionally a folder in the repo).
2. Open **Sync Center**, expand the remote, and press **Pull from `<name>`**; then tick what to apply and press **Apply N items**.
3. Later, from the source vault, expand the remote in its own Sync Center and press **Push to `<name>`** to publish updates for the other vault to pull.

## Security & privacy

Everything the plugin does by default stays inside your vault: Capture/Apply copy files between your config folder and the data folder, and your own note sync moves them between devices. Two **optional, desktop-only** remote features go further and are disclosed here:

- **Network use (git remotes only).** If you add a git remote under Settings → Remotes, Pull/Push run the `git` binary against the URL you configured — that is the only network access the plugin ever performs. No telemetry, no other endpoints.
- **Files outside the vault (vault remotes and git temp clones).** If you add a remote of type "Another vault", Pull/Push read/write the absolute store path you configured (typically another vault's data folder). Git pushes additionally use a temporary clone directory that is removed afterwards.

Both features are disabled until you configure a remote, and never run without an explicit Pull or Push from the Sync Center.

## Sensitive settings

Every field or file rule is a `{scope, encrypted}` pair, set per key (or per file, when the item has no per-key rules) from a card's Settings file zone:

- **Scope** — `All devices` keeps the key shared and identical everywhere; `Desktop only`/`Mobile only` keep it shared but let each device class hold its own value, in a `__scopes__` sidecar next to the file's store copy (e.g. `app.json`'s `userIgnoreFilters`, per-device search-ignore patterns, is commonly set `Desktop only`); `This device` (per-key rules only, not the whole-file rule) keeps a key out of the store entirely and never leaves this machine — Apply preserves the local value.
- **Encrypt** — stores the value (or, for the whole-file rule, the whole file) as an encrypted envelope and decrypts it on Apply, so credentials can travel safely. Greyed out at `This device`, since a value that never leaves the device has nothing to encrypt for transit.
- **Per-item scopes** — a string-array key (a plugin's enabled elements, a CSS-snippets list, `userIgnoreFilters`…) can turn on per-element scopes instead of one rule for the whole key, so each entry travels or stays local independently.

Encrypt modes need a vault-level **Passphrase**, set once per device in Settings → General — it's never written to any file and never synced; the same passphrase on each device is all that's needed. On Obsidian 1.12+ it is stored encrypted in the app's keychain (Settings → Keychain); older installs keep it in plain app storage. An item with encrypted content but no passphrase set on the current device shows a *locked* state (marked with a key icon) and won't capture or apply until the passphrase is set. A wrong passphrase on Apply fails cleanly without writing anything.

Every installed plugin is scanned for sensitive-looking keys (API keys, tokens, secrets, passwords, emails) or an opaque encrypted blob before you ever enable syncing — a `⚠ N keys` / `⚠ opaque blob` badge appears on the row and sorts it to the top of its section; this only informs, you still choose the rule. A card's Settings file zone includes a read-only preview of the file, collapsed behind a **File preview** disclosure by default: keys are colored by rule state (teal = encrypted · red = this device · blue = desktop only · amber = mobile only; detected-but-unruled keys are purple, plain keys faint), and clicking a key adds it as a rule directly — the escape hatch for anything the built-in detection misses. Each card is badged with its own summary — `N device-scoped` and `N encrypted` counts, plus its **Enabled on** chip when non-default — and capture reports state exactly what was encrypted or stripped.

There is no hard blacklist anymore — `remotely-save`, `ioto-update`, `slides-rup` and `config-sync` are now normal items like any other (e.g. `remotely-save` can be whole-file encrypted; `ioto-update` works well with per-key rules).

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
4. Publish the draft on GitHub — the directory and BRAT only see published releases.

## License

[MIT](LICENSE)
