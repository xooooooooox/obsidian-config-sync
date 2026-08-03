# Config Sync — User Guide

Every behavior in one place; the [README](../README.md) is the 5-minute version.

- [Concepts](#concepts)
- [The Sync Center](#the-sync-center)
- [Settings](#settings)
- [Field rules & sensitive settings](#field-rules--sensitive-settings)
- [Transport](#transport)
- [Status bar & ribbon](#status-bar--ribbon)
- [Walkthroughs](#walkthroughs)

## Concepts

Two planes, kept separate: a **local plane** (this device's live config ↔ the store) and a **transport plane** (how the store travels between devices — see [Transport](#transport)).

**Local plane:**

- **Capture** copies every enabled item's settings file and companion folders into `<data folder>/store/`, applying each field's `{scope, encrypted}` rule (or the whole-file rule, for items with no per-key rules), skips OS junk files, and records source plugin versions (or the Obsidian app version, for Obsidian/core items) in `store.lock.json`. Only changed files are rewritten; the Sync Center's Capture button captures just what you've ticked.
- **Apply** picks items and lands them into this device's config dir (whatever its name) — there's no confirmation dialog; ticking and pressing Apply executes directly. For a community plugin that's outdated, disabled or not installed on this device, Apply can also update, enable or install it first (see [Availability sections and the install engine](#availability-sections-and-the-install-engine)). This-device-scoped fields and encrypted content resolve per the item's rules; a `This device` field keeps its local value untouched.
- The **Sync Center** compares live config against the store per item; direction (↑ to capture, ↓ to apply) comes from a per-device sync baseline, not file times — each time this device sees an item in sync, it remembers a fingerprint of both sides, so a later difference can tell which side actually moved. An item with no baseline on this device yet (a fresh install, or one pending its first sync since upgrading) shows as **not synced on this device yet** and defaults to apply; one that changed on both sides since this device's last sync shows as `≠ differs`. Remote freshness is still checked automatically.

**On-disk store layout:**

```
<data folder>/               # default "config-sync", configurable
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/… (device-independent)
    │   └── *.__scopes__.desktop.json / *.__scopes__.mobile.json   # Desktop-only/Mobile-only field sidecars
    │   # a whole-file-encrypted item sits at its normal path as an encrypted JSON envelope ("csenc": 1)
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

What syncs, and each field's `{scope, encrypted}` rule, is configured entirely through **Settings → Config Sync**'s cards (stored in the plugin's own settings, `schemaVersion: 2`) and, for anything a card doesn't cover, the **Advanced → Custom rules** editor in the same tab. OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never captured. See [Field rules & sensitive settings](#field-rules--sensitive-settings) for per-item rules and passphrase-protected encryption.

The store format and settings schema are `schemaVersion: 2`; installs older than that have no migration path — upgrade every device together, then re-tick what to sync before capturing or applying again.

## The Sync Center

Open the **Sync Center** any time for the full picture; its header is its own status bar.

#### Awareness at a glance

- A **this device** chip: a green check when everything is in sync, an orange **update available** when this device's Config Sync is older than the version the store was captured on (the pane then points at **Community plugins** to update first), otherwise the current state and a shortcut into settings.
- Followed by totals for every pending action, including per-remote push/pull counts.
- Every item is badged by state: `✓ in sync`, changed-on-this-device, store-is-newer, not-synced-on-this-device-yet, `≠ differs`, `— not captured yet`.
- Each sync action (Capture, Apply, Push, Pull) has its own icon.
- JSON diffs render with keys in a normalized order, so a pure key-order/formatting difference is called out instead of showing as noise.
- Remotes are checked automatically.
- A group that comes from a card's own companion folder or switch list — CSS snippets, a `themes/` folder, any user-added folder — shows as `Parent › Name` (parent faint), so it sorts and searches under its host card instead of reading as an unrelated standalone row.

#### Header chip and the this-device pane

The chip opens the **this device** pane, where Config Sync's own configuration (its item list, field rules and options) is captured and applied like any other item. When that list changes, an expandable *view change* shows the exact `data.json` delta and what capturing will publish.

#### Result strip and History

Capture, Apply, Pull and Push each finish by rendering a result strip **pinned to the top of the Sync Center**:

- A collapsible summary (changed/unchanged counts, per-item detail on demand) rather than a popup dialog, so it stays visible while you scroll a long list and doesn't interrupt further ticking.
- Its tone reflects the outcome — green when the run is clean, amber or red when items need attention, with failures expanded by default.

Every run is also recorded in a browsable, clearable **History**: a sidebar entry opens a table of past runs (a card list on narrow/mobile screens, so it reads top-to-bottom with no horizontal scroll), each expandable to its per-item detail.

#### Search & qualifiers

The **Filter by name…** search box lives in the Sync Center's sidebar and searches globally across every scope at once (Obsidian, Core plugins, Community plugins, Beta, Custom). Beyond plain text it accepts `key:value` qualifiers, combined together and with free text:

| Qualifier | Values |
|---|---|
| `type:` | file / folder |
| `scope:` | obsidian / core / community / beta / custom |
| `action:` | capture / apply / ok / none |
| `mode:` | plain / fields / encrypted |
| `device:` | all / desktop / mobile |

An autocomplete dropdown opens as soon as the box is focused, suggesting keys then values. The sidebar shows a hit count per scope, and sections with a match auto-expand to show just the hits.

#### Deciding where a plugin belongs

When a plugin is switched on on one side only, its row explains the consequence and a "where it runs" menu sets Desktop only / Mobile only / this-device / everywhere on the spot (impossible options are hidden).

#### Leftovers

Stop syncing an item at any time from its card's sync toggle — optionally deleting its store copy. Store files left behind with no matching item surface as **Leftover** for one-click cleanup.

### Availability sections and the install engine

Beyond the main list, the Sync Center groups community/core plugin items by what's true on *this* device, in collapsed, opt-in sections that never count into the header pills, sidebar badges, filter pills or footer until you tick something inside them:

- **Outdated on this device** — enabled plugins whose installed version is behind what the store was captured on.
- **Disabled on this device** — plugins whose config is tracked but the plugin itself is switched off here.
- **Not installed on this device** — plugins the store has config for but that aren't installed here at all.
- **Desktop-only** (phones) — plugins in your config that can't run on this device; informational only, nothing to stage.

Each row in these sections carries an **On apply** choice alongside the usual checkbox — the checkbox decides whether the item's config is part of this run, the On apply choice decides what happens to the plugin's state before that config lands:

- Outdated: `⤓ Update to {store version}` (default) or `Keep {version}`.
- Disabled, no version drift: `⏻ Enable` (default) or `Keep disabled`.
- Disabled and outdated: `⤓ Update & enable` (default), `⏻ Enable`, or `Keep disabled`.
- Not installed: `⤓ Install & enable` (default), `⤓ Install`, or `Settings only`.

Installs and updates fetch the plugin from the official community plugin catalog, **pinned to the version the store was captured on** (recorded in `store.lock.json`) so every device converges on the same version; when that exact release is missing it falls back to the latest stable with a warning. A plugin that isn't in the catalog is staged (its config is written, ready for whenever you install it manually) with a note to that effect. A failed update leaves the existing config untouched (an old version is assumed unsafe to overwrite blindly); a failed install still stages the config, since an uninstalled plugin can't be harmed by it. **A single failure never aborts a bulk install** — the offending plugin becomes one error row in the result and the rest of the batch still installs.

A plugin ahead of the store's recorded version shows a quiet metadata line instead of a section (capturing again will refresh the store). Obsidian and core-plugin items are anchored to the Obsidian app version rather than a plugin version — drift there is reminder-only in both directions and never drives an install/update action.

## Settings

- **General** — PKM mode (auto-detects IOTO vaults), the data folder location, status toggles (sync menu change counts, automatic remote checks, periodic local check), the status bar (item, remote push/pull counts, opt-in ribbon dot, mobile force-show), ribbon icons.

Every row across **Obsidian**, **Core plugins**, **Community plugins** and **Beta** is a card: name, badges (a grey `desktop-only plugin` chip when the plugin can't run on mobile; `on: desktop` / `on: mobile` / `on: this device` when a plugin's enabled state isn't the default; counts of device-scoped and encrypted rules), a sync toggle, and a chevron that opens its drawer.

- The **Obsidian** tab has three cards: **App settings** (the whole `app.json` — editing, new-note and link behavior, and other general options), **Appearance** (theme, fonts and CSS snippets) and **Hotkeys** (your custom keyboard shortcuts).
- **Core** and **Community** plugins are listed in full: a core plugin with no settings file yet is a state-only card (just its **Enabled on** zone) until it writes one.
- The **Search all settings…** box spans General, all picker tabs, Advanced and Remotes, and accepts `scope:` (general/obsidian/core/community/advanced/remotes) and `type:` (file/folder) qualifiers with autocomplete alongside plain text.
- The **Beta** tab tracks community plugins installed through [BRAT](https://github.com/TfTHacker/obsidian42-brat) — same card, same three drawer zones — so their configs sync like any other plugin.
- Each section lists its cards alphabetically; sensitive-looking keys (tokens, secrets) are highlighted inside a card's File preview so you see them before enabling syncing.

A card's drawer has up to three zones, and every scope control in them is the same cycling icon: the glyph shows the current scope (a monitor+phone pair = `All devices`, a monitor = `Desktop only`, a phone = `Mobile only`, an airplay mark = `This device`), a click advances to the next value, and the default sits dimmed while anything narrower lights up in the accent color.

#### Enabled on

A plugin's on/off state lives on its own card, in its **Enabled on** zone. Plugin cards only: one cycling scope icon for which devices turn the plugin itself on; it reads and writes the same enabled-plugins list Obsidian maintains.

#### Settings file

Starts as one path row: the file's path, a scope icon (no `This device` here) and a lock toggle that encrypts the whole file. The path text itself is the edit entry point:

- Click it to edit in place (Enter commits, Esc cancels).
- While editing a committed custom path, a quiet **Reset to default** action restores the built-in default.

Below the path row, a collapsed **File preview** (`▸ File preview`) expands into a read-only view of the file, keys colored by their rule, with a color-dot legend underneath (blue = desktop only, amber = mobile only, red = this device, a lock mark = encrypted); click a key to add a rule for it directly.

The moment a card has any per-key rule, it switches to per-key mode:

- The path row's own scope/lock dim (each ruled key now governs itself).
- A row appears per configured key with its own scope icon, a lock toggle (greyed out at `This device`) and a ✕ to remove the rule.
- A string-array key's rule adds a **Per-item scopes** toggle so each element gets its own scope icon instead of one rule for the whole key.
- Removing the last rule reverts the card to whole-file mode.

#### Companion folders

Lists any vault-relative folder that travels with the item — Appearance ships `themes/` and `snippets/` as presets, and every card's drawer ends with a quiet **+ Add folder** row to add any other path (duplicates and paths already claimed by another item are rejected).

- Each folder row has a scope icon and a sync toggle (plus a ✕ on any folder you added yourself), and clicking the folder's name opens its path for editing.
- A folder's member list is collapsed behind a `· N files`/`· N themes` count — click to expand it.
- Opening `snippets/` lists each file as its own row with a scope icon: the file itself always syncs, and the icon only decides which devices turn it on.
- A member whose file has been deleted but still holds a device choice stays listed — struck through, marked `file deleted` — until you press **Forget**, which clears the choice (the next capture then removes it from the store); the folder's member count only counts files that still exist.
- Any other companion folder syncs as a whole, so its members list for information only, without a per-file scope.

#### Advanced

**Custom rules** (fully yours: vault-root files, extra folders, sync modes) and **Discovered files** (config files we couldn't classify; toggle to sync — name and path are fixed by the file), each row using its own field-rule editor (a `This device`/`Encrypted`/`Desktop only`/`Mobile only` action dropdown, separate from a card's icon-based Settings file zone). When any managed item is customized (path, fields or mode diverge from its default), a summary row lists them with a **Reset all to defaults** button.

#### Remotes

Desktop only. Add a **git repository** (URL, branch, optional folder) or **another vault**: click **Browse…**, pick the vault folder, and the store inside it is auto-detected. Each remote also has a **Keep Config Sync's own settings out of this remote** toggle: turn it on for a remote vault that keeps its own setup, and Pull, Push and the comparison stop touching Config Sync's own settings there. An https git remote can also carry an **access token** (a GitLab/GitHub personal access token): press **Link** to store it in Obsidian's keychain — or pick a secret already there — and Config Sync authenticates with it directly, with no reliance on the machine's git sign-in. Only the secret's name is written to the settings, and the remotes list is a this-device field Config Sync never sends anywhere — so every device links its own token once, and one that hasn't (because you copied `data.json` across, or removed the secret here) says so plainly instead of failing obscurely. Leave **Username** empty unless the host checks it: GitHub and GitLab.com ignore the username on token auth, while a self-hosted GitLab rejects anything but the account's own name.

## Field rules & sensitive settings

Every field or file rule is a `{scope, encrypted}` pair, set per key (or per file, when the item has no per-key rules) from a card's Settings file zone.

- **Scope** — `All devices` keeps the key shared and identical everywhere; `Desktop only`/`Mobile only` keep it shared but let each device class hold its own value, in a `__scopes__` sidecar next to the file's store copy (e.g. `app.json`'s `userIgnoreFilters`, per-device search-ignore patterns, is commonly set `Desktop only`); `This device` (per-key rules only, not the whole-file rule) keeps a key out of the store entirely and never leaves this machine — Apply preserves the local value.
- **Encrypt** — stores the value (or, for the whole-file rule, the whole file) as an encrypted envelope and decrypts it on Apply, so credentials can travel safely. Greyed out at `This device`, since a value that never leaves the device has nothing to encrypt for transit.
- **Per-item scopes** — a string-array key (a plugin's enabled elements, a CSS-snippets list, `userIgnoreFilters`…) can turn on per-element scopes instead of one rule for the whole key, so each entry travels or stays local independently.

#### Passphrase & keychain

Encrypt modes need a vault-level **Passphrase**, set once per device in Settings → General:

- It's never written to any file and never synced; the same passphrase on each device is all that's needed.
- On Obsidian 1.12+ it is stored encrypted in the app's keychain (Settings → Keychain); older installs keep it in plain app storage.
- An item with encrypted content but no passphrase set on the current device shows a *locked* state (marked with a key icon) and won't capture or apply until the passphrase is set.
- A wrong passphrase on Apply fails cleanly without writing anything.

#### Sensitive-key detection

Every installed plugin is scanned for sensitive-looking keys (API keys, tokens, secrets, passwords, emails) or an opaque encrypted blob before you ever enable syncing; this only informs, you still choose the rule.

A card's Settings file zone includes a read-only preview of the file, collapsed behind a **File preview** disclosure by default:

- Detected keys are called out with a purple, dotted-underline highlight inside the card's File preview.
- A lock icon marks encrypted, and other keys are colored by rule state: red = this device, blue = desktop only, amber = mobile only, plain keys faint.
- Clicking a key adds it as a rule directly — the escape hatch for anything the built-in detection misses.

Each card is badged with its own summary — `N device-scoped` and `N encrypted` counts, plus its **Enabled on** chip when non-default — and capture reports state exactly what was encrypted or stripped.

Every plugin — including `remotely-save`, `ioto-update`, `slides-rup` and `config-sync` itself — is a normal item like any other (e.g. `remotely-save` can be whole-file encrypted; `ioto-update` works well with per-key rules).

## Transport

How the store travels between devices, beyond this device's own Capture/Apply (see [Concepts](#concepts)).

**Your note sync (default)** — the store is plain vault content: remotely-save, Obsidian Sync, iCloud or anything else carries it everywhere, mobile included, zero configuration.

- On a **fresh device**, once the store arrives, the Sync Center discovers it on its own and shows an **Adopt** banner; adopting it runs a one-time guide that walks you through applying the store to set the device up — and warns against capturing over it with the new device's empty defaults.
- Until you adopt, a dismissible banner at the top of the item list explains that the diffs below aren't trustworthy yet — adopt the plugin's own settings first, since they carry the device rules the comparison depends on.

**Pull / Push (desktop, optional)** — config-sync's own transport for a git repo or another vault on this machine, run from the Sync Center's Remotes block.

- Pull overwrites this vault's store from a remote (repeatable — cold start and ongoing use are the same action); Push sends it out.
- The git transport clones to a temp dir and never touches your vault's own repo.
- The Sync Center's Remotes block auto-checks whether a git or vault remote was captured after your local store.
- Expand a remote for a Pull/Push preview, where each diff row expands into per-file detail with content diffs, and the summary separates what Pull would bring from files that exist only in your store (Pull never removes files).

## Status bar & ribbon

- **Status bar** — sync status at a glance: ↑ to capture, ↓ to apply, plus per-remote ⇡ push / ⇣ pull counts; click opens the **Sync Center**. All in sync shows just a dimmed icon. A mobile-only toggle can force Obsidian's hidden status bar visible on phones.
- **Ribbon** — everything hangs off one **Config Sync** ribbon icon; clicking it opens a menu with **Sync Center** (badged with the pending capture/apply counts), which opens (or focuses, if already open) the Sync Center, where Capture/Apply/Pull/Push all happen. The status bar is the primary always-visible indicator; the ribbon icon's own status dot is opt-in and off by default (**Settings → General → Status bar**). An individual ribbon icon for the Sync Center is available under **Settings → General**, off by default. Quick commands live in the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin.

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
