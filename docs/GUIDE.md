# Config Sync — User Guide

Every behavior in one place; the [README](../README.md) is the 5-minute version.

- [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier)
- [Concepts](#concepts)
- [The Sync Center](#the-sync-center)
- [Settings](#settings)
- [Field rules & sensitive settings](#field-rules--sensitive-settings)
- [Transport](#transport)
- [Status bar & ribbon](#status-bar--ribbon)
- [Walkthroughs](#walkthroughs)

## Updating from 2.21.0 and earlier

**Update Config Sync on every device before any of them captures or pulls again.** This release changes the format of both the plugin's own settings and `store.lock.json`, and the change is one way: once a device has written the new format, there is no going back to the old one.

- A device on **2.21.0** that meets the new format refuses it, says so plainly, and changes nothing. Update it and it carries on where it left off.
- A device on **2.20.0 or earlier** has no such check. It **resets its Config Sync settings to defaults** — every rule, every custom rule, every card you had ticked. Nothing recovers that afterwards, which is why the order matters: update the device before it ever sees the new format.

The conversion itself asks nothing of you. The first device to run this version converts its own settings in place on load: your rules, your custom rules, your Beta list and this device's sync baselines all come across, and no item flips to "never synced". Take your usual vault backup first anyway — the conversion cannot be undone.

### What behaves differently afterwards

Three deliberate changes, each of which you may notice:

- **Runs on now decides where an item syncs, not just what the menu says.** A plugin's `Computers only` / `Phones only` choice used to be read by that menu and by nothing else — capture and apply followed a separate, invisible setting, so the two could disagree. They are one field now, and the choice masks capture and apply too. Your items keep doing exactly what they were already doing; it is the menu that starts telling the truth about it.
- **A community plugin you have only given a Runs-on rule, and never switched on here, has no card in Settings** until the plugin is installed on this device. It had no card before this release either — that rule used to live in a list of its own, apart from the plugin's card — so nothing changed hands and nothing was removed: the plugin is still in the store, your other devices still sync it, and it still has a row in the Sync Center, which is where you set the rule in the first place. Install it here and the card appears with the rule already on it.
  Switching a card **off** normally keeps it, so you can switch it back on. This one shape is the exception, and it cuts both ways — both intended. Switch **off** a plugin that isn't installed here and carries a Runs-on rule, and the rule is the only thing it has here any more, so its card goes with it. Clear that rule and the opposite happens: a card **appears** for a plugin you don't have installed, because an off card on its own is a choice this device remembers, and a Runs-on rule on its own is not. Its store copy, its Sync Center row and your other devices are unaffected either way, and installing the plugin here always brings the card back.
- **A display name in a store written by an older version stays stale until the next capture or pull.** Config Sync used to quietly repair out-of-date item names in `store.lock.json` at startup. It no longer writes to a store in the old format at all — a cosmetic fix is not worth rewriting a file your other devices may still be reading, and the rewrite could strand them. The first capture or pull brings both the format and the names up to date.

### `scope:` is gone from both search boxes

Both search boxes used to accept a `scope:` qualifier, and it meant a different thing in each. It is `section:` in both now, and there is no alias: typing `scope:core` searches for those words as plain text instead of filtering, so a search that stops working is telling you it changed. See [Search & qualifiers](#search--qualifiers).

## Concepts

Two planes, kept separate: a **local plane** (this device's live config ↔ the store) and a **transport plane** (how the store travels between devices — see [Transport](#transport)).

**Local plane:**

- **Capture** copies every enabled item's settings file and companion folders into `<data folder>/store/`, applying each field's `{sharing, encrypted}` rule (or the whole-file rule, for items with no per-key rules), skips OS junk files, and records source plugin versions (or the Obsidian app version, for Obsidian/core items) in `store.lock.json`. Only changed files are rewritten; the Sync Center's Capture button captures just what you've ticked.
- **Apply** picks items and lands them into this device's config dir (whatever its name) — there's no confirmation dialog; ticking and pressing Apply executes directly. For a community plugin that's outdated, disabled or not installed on this device, Apply can also update, enable or install it first (see [Availability facts and the install engine](#availability-facts-and-the-install-engine)). `This device` fields and encrypted content resolve per the item's rules; a `This device` field keeps its local value untouched.
- The **Sync Center** compares live config against the store per item; direction (↑ to capture, ↓ to apply) comes from a per-device sync baseline, not file times — each time this device sees an item in sync, it remembers a fingerprint of both sides, so a later difference can tell which side actually moved. Every row states its own verdict as a plain-language **fate sentence** (`↓ Installs · turns on · applies settings`, `↑ Captures settings`, `— In sync`…) instead of a bare status glyph — see [The Sync Center](#the-sync-center) for the full grammar. An item with no baseline on this device yet (a fresh install, or one pending its first sync since upgrading) defaults to apply; one that changed on both sides since this device's last sync reads `⚠ Changed on both sides` and stays unstageable until you resolve it. Remote freshness is still checked automatically.

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

What syncs, and each field's `{sharing, encrypted}` rule, is configured entirely through **Settings → Config Sync**'s cards (stored in the plugin's own settings, `schemaVersion: 3`) and, for anything a card doesn't cover, the **Advanced → Custom rules** editor in the same tab. OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never captured. See [Field rules & sensitive settings](#field-rules--sensitive-settings) for per-item rules and passphrase-protected encryption.

The settings schema is `schemaVersion: 3` and `store.lock.json` is `version: 3`. A document or store from 2.x is converted on load, once, in place; see [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier) for what that means for your other devices.

## The Sync Center

Open the **Sync Center** any time for the full picture; its header is its own status bar.

#### Rows, sections and fates

- Every synced thing — a plugin, an Obsidian option group, a folder — is **one row**. A row's companions (Appearance's `themes`/`snippets` presets, or any item's own `+ Add folder` companions) dissolve into that same row rather than getting rows of their own, so ticking or expanding the parent covers them too.
- Rows sort into four fixed sections — **Obsidian**, **Core plugins**, **Community plugins** (beta plugins included, the Config Sync self row pinned first, reading `your Sync Center — manages itself`) and **Your folders** — alphabetical within each. Click a section header to collapse/expand it (remembered while the pane stays open); its trailing count reads `N`, or `N of M` once a filter or search narrows it.
- Each row reads **checkbox · name · chips · fate sentence**. Chips call out only facts that deviate from the default — `not installed here`, `desktop only`, `stays off`, `off here — your rule` / `on here — your rule`, `🔒 encrypted`, a folder path. The **fate sentence** is the row's plain-language verdict on what the next run would do to it: `↓ Installs · turns on · applies settings`, `↓ Updates · applies settings`, `↑ Captures settings`, `↓ Applies theme & snippets — live` (Appearance), `↓ Applies N files` (a folder). Identical rows read `— In sync`; a row with nothing saved anywhere yet reads `— No settings yet`; one that changed on both sides since your last sync reads `⚠ Changed on both sides` and stays unstageable until you resolve it (below).
- In-sync, excluded, and no-settings rows sit dimmed with the checkbox hidden, folded behind a trailing line per section, in this order: `✓ N items in sync ▸`, `⊘ N items not synced on this device ▸`, `○ N items with no settings yet ▸` — click to expand in place.
- The checkbox means one thing everywhere: include this row in the next run. It never changes what would happen, only whether it happens — so a section's own select-all is always safe, and it skips the self row, in-sync/excluded/no-settings rows and any unresolved conflict.
- The filter pills — **All**, **To capture**, **To apply**, **In sync**, **Not synced here**, **No settings yet** — narrow every section by the same fate; they hide rows, they never move them between sections. **Not synced here** (and its matching fold/badges) only appears once at least one item is excluded — an empty bucket shows nothing, same as **In sync**/**No settings yet**.
- A rule that keeps an item off this device's class (e.g. Hotkeys set to `Desktop only` while you're on a phone) reads `— Not synced on this device` with a `your rule` chip, instead of a misleading `In sync` — and counts under **Not synced here**, not **In sync**. An item you opted THIS device out of (below) reads the identical row and counts the same way — the card's **State** clause is what tells the two causes apart.
- JSON diffs render with keys in a normalized order, so a pure key-order/formatting difference is called out instead of showing as noise.

#### The expanded card

Click a row's name to expand it into a card, in order (each row omitted when it doesn't apply):

- **On apply** / **On capture** / **State** — the fate sentence spelled out as a full clause: install source (`from the community catalog` / `via BRAT`), update versions (`Updates 2.14.0 → 2.15.1`), what capturing publishes (`Shares your settings with your other devices`).
- **Files** — direction-aware entries: incoming additions as `+ file` with `view ▸`/`diff ▸`, outgoing changes as `↑ file · diff ▸`, encrypted content as `changed — encrypted, no preview`.
- **Resolve** (conflicts only) — `Use theirs ↓` / `Keep mine ↑`; the row stays unstageable until you pick one, then reads as a normal directed row plus a `your choice` chip.
- **Runs on** (plugins, while the Core/Community on/off list itself is a synced item) — one menu unifying every way to say where a plugin turns on: `Follows your devices` (default) / `Computers only` / `Phones only` / `Always on here` / `Never on here`. `Computers only` / `Phones only` decide where the item syncs as well as where it turns on — one field, one meaning. Up to 2.21.0 that choice was read by this menu alone; see [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier).
- **After install** / **Enablement** — the fallback when the on/off list ISN'T itself synced (a section header's `on/off synced ✓` / `on/off not synced` chip toggles that, via a small popover — `Sync on/off` / `Stop syncing on/off`): `Turn it on` or `Leave it off`, offered for a plugin this run installs, or one that's already installed but off.
- **Settings sync** — the item's own file-level sharing rule, the same three-stop control (`All devices` / `Desktop only` / `Mobile only`) as its Settings-tab card. A fields-mode item has no whole-file rule to move, so it reads `Per-key rules decide — see More` instead of offering a menu that would persist nothing.
- **More** — a deep link that opens Settings scrolled to, and highlighting, this item's own card, for per-key rules, locks and companion folders.
- **Note** — an honest runtime aside, e.g. Hotkeys' `Takes effect after an app reload`.

#### Header chip and the this-device pane

The header chip opens the **Config Sync** pane, where the plugin's own configuration is captured and applied like any other item. A fresh device with no store yet reads `No store on this device yet`, offering `Pull from {remote}` when a remote is configured; once a store has arrived (via your note sync or a Pull), the pane instead offers **Adopt**, a one-time guide that imports the store's full sync list — every field it depends on, down to which plugins are tracked via BRAT — onto this device, without applying anything or capturing over it with empty defaults. When the list later changes in the store, an expandable *view change* shows the exact `data.json` delta.

#### Result strip and History

Capture, Apply, Pull and Push each finish by rendering a result strip **pinned to the top of the Sync Center**:

- A collapsible summary (changed/unchanged counts, per-item detail on demand) rather than a popup dialog, so it stays visible while you scroll a long list and doesn't interrupt further ticking.
- Its tone separates a clean run (green) from one with warnings-only notes (green frame, amber note count — e.g. a captured plugin version that's no longer downloadable, so the latest stable was installed instead) from one with real failures (`✗ Applied with N issue(s)`, expanded by default).

Every run is also recorded in a browsable, clearable **History**: a sidebar entry opens a table of past runs (a card list on narrow/mobile screens, so it reads top-to-bottom with no horizontal scroll), each expandable to its per-item detail.

#### Search & qualifiers

The **Filter by name…** search box lives in the Sync Center's sidebar and searches globally across every section at once (Obsidian, Core plugins, Community plugins, Beta, Custom). Beyond plain text it accepts `key:value` qualifiers, combined together and with free text:

| Qualifier | Values |
|---|---|
| `type:` | file / folder |
| `section:` | obsidian / core / community / beta / custom |
| `action:` | capture / apply / ok / none |
| `mode:` | plain / fields / encrypted |
| `device:` | all / desktop / mobile |

An autocomplete dropdown opens as soon as the box is focused, suggesting keys then values. The sidebar shows a hit count per section, and sections with a match auto-expand to show just the hits.

**Retired syntax:** `scope:` was this box's word for `section:` up to 2.21.0, and the settings panel's word for its own areas. It is not accepted any more, in either box, and there is no alias — a typed `scope:community` is treated as plain text and finds the items whose names contain those words, which is usually nothing. Retype it as `section:community`.

#### Leftovers

A card's quiet `⊘ Stop syncing` footer button opens a menu with two reaches: **On this device** applies instantly (no modal, reversible in place) — this device stops installing/applying/capturing the item while your other devices keep syncing it as normal (its row here now reads `— Not synced on this device`, with the card explaining `you turned it off here`); **Everywhere…** opens the existing confirm dialog, optionally deleting its store copy, and removes it from every device's sync list.

**On this device** is stored on the device itself, not in Config Sync's own settings, so it never travels: a Pull and Adopt from another device can no longer wipe the choice you made here, and each device's list is its own. It also means the choice does not follow you — reinstalling Obsidian, or setting the vault up again on a new machine, starts with nothing opted out. Store files left behind by an Everywhere removal with no matching item surface in their own **Leftover** section for one-click cleanup — an item merely switched off on this device (whether via **On this device** or a core plugin's own toggle) keeps its store settings attached to its card, never in Leftover.

### Availability facts and the install engine

An item's row already carries the facts that once lived in their own sections: `not installed here`, `desktop only` and `stays off` chips, plus a fate sentence naming exactly what Apply would do — `↓ Installs · turns on · applies settings`, `↓ Updates · applies settings`, `↓ Turns on · applies settings`, or plain `↓ Applies settings` once nothing about the plugin's own state needs to change. Ticking the row stages all of it as one action; expand the card (above) for the specific choice:

- **Outdated** — the `On apply` clause reads `Updates {local version} → {store version}`. Installs and updates fetch the plugin from the official community plugin catalog, **pinned to the version the store was captured on** (recorded in `store.lock.json`) so every device converges on the same version, falling back to the latest stable with a warning when that exact release is gone. A plugin ahead of the store's recorded version shows a quiet metadata line instead (capturing again refreshes the store).
- **Disabled here / not installed here** — the **Runs on** menu (while the on/off list is synced) or the card's **After install** / **Enablement** menu (while it isn't) decides whether the plugin turns on; the checkbox alone decides whether its settings are part of this run. A plugin that isn't in the catalog is staged (its config written, ready for a manual install) with a note to that effect.
- **Desktop-only on a phone** — informational chip only, nothing to stage.
- A failed update leaves the existing config untouched (an old version is assumed unsafe to overwrite blindly); a failed install still stages the config, since an uninstalled plugin can't be harmed by it. **A single failure never aborts a bulk run** — the offending plugin becomes one error row in the result strip and the rest of the batch still runs.

Obsidian and core-plugin items are anchored to the Obsidian app version rather than a plugin version — drift there is reminder-only in both directions and never drives an install/update action.

## Settings

- **General** — PKM mode (auto-detects IOTO vaults), the data folder location, status toggles (sync menu change counts, automatic remote checks, periodic local check), the status bar (item, remote push/pull counts, opt-in ribbon dot, mobile force-show), ribbon icons.

Every row across **Obsidian**, **Core plugins**, **Community plugins** and **Beta** is a card: name, badges (a grey `desktop-only plugin` chip when the plugin can't run on mobile; `on: desktop` / `on: mobile` / `on: this device` when a plugin's enabled state isn't the default; counts of device-scoped and encrypted rules), a sync toggle, and a chevron that opens its drawer.

- The **Obsidian** tab has three cards: **App settings** (the whole `app.json` — editing, new-note and link behavior, and other general options), **Appearance** (theme, fonts and CSS snippets) and **Hotkeys** (your custom keyboard shortcuts).
- **Core** and **Community** plugins are listed in full: a core plugin gets a full card even before it has written its settings file here — the file's path is known from the plugin itself, so its store copy stays attached wherever the file exists.
- A community plugin your other devices sync but that isn't installed here still gets a card, as soon as it carries anything of its own on this device — switched on, switched off, a settings rule, a companion folder. The one shape that earns no card is a **Runs-on rule and nothing else**: that rule is set from the plugin's row in the Sync Center rather than from a card, so it doesn't summon one, and switching such a card off makes it disappear (see [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier)). It keeps its store copy and its Sync Center row either way, and installing the plugin here always gives it a card.
- The **Search all settings…** box spans General, all picker tabs, Advanced and Remotes, and accepts `section:` (general/obsidian/core/community/advanced/remotes) and `type:` (file/folder) qualifiers with autocomplete alongside plain text. `section:` names a settings AREA here, so its list is the Sync Center's plus the areas that hold no items; custom rules and discovered files live on the Advanced tab, so `section:advanced` is what finds them. The old `scope:` is not accepted — see [Retired syntax](#search--qualifiers).
- The **Beta** tab tracks community plugins installed through [BRAT](https://github.com/TfTHacker/obsidian42-brat) — same card, same three drawer zones — so their configs sync like any other plugin.
- Each section lists its cards alphabetically; sensitive-looking keys (tokens, secrets) are highlighted inside a card's File preview so you see them before enabling syncing.

A card's drawer has up to three zones, and every sharing control in them is the same cycling icon: the glyph shows the current rule (a monitor+phone pair = `All devices`, a monitor = `Desktop only`, a phone = `Mobile only`, an airplay mark = `This device`), a click advances to the next value, and the default sits dimmed while anything narrower lights up in the accent color.

#### Enabled on

A plugin's on/off state lives on its own card, in its **Enabled on** zone. Plugin cards only: one cycling sharing icon for which devices turn the plugin itself on; it reads and writes the same enabled-plugins list Obsidian maintains.

#### Settings file

Starts as one path row: the file's path, a sharing icon (no `This device` here) and a lock toggle that encrypts the whole file. The path text itself is the edit entry point:

- Click it to edit in place (Enter commits, Esc cancels).
- While editing a committed custom path, a quiet **Reset to default** action restores the built-in default.

Below the path row, a collapsed **File preview** (`▸ File preview`) expands into a read-only view of the file, keys colored by their rule, with a color-dot legend underneath (blue = desktop only, amber = mobile only, red = this device, a lock mark = encrypted); click a key to add a rule for it directly.

The moment a card has any per-key rule, it switches to per-key mode:

- The path row's own sharing/lock dim (each ruled key now governs itself).
- A row appears per configured key with its own sharing icon, a lock toggle (greyed out at `This device`) and a ✕ to remove the rule.
- A string-array key's rule adds a **Per-item device rules** toggle so each element gets its own sharing icon instead of one rule for the whole key.
- Removing the last rule reverts the card to whole-file mode.

#### Companion folders

Lists any vault-relative folder that travels with the item — Appearance ships `themes/` and `snippets/` as presets, and every card's drawer ends with a quiet **+ Add folder** row to add any other path (duplicates and paths already claimed by another item are rejected).

- Each folder row has a sharing icon and a sync toggle (plus a ✕ on any folder you added yourself), and clicking the folder's name opens its path for editing.
- A folder's file list is collapsed behind a `· N files`/`· N themes` count — click to expand it.
- Opening `snippets/` lists each file as its own row with a sharing icon: the file itself always syncs, and the icon only decides which devices turn it on.
- A file that has been deleted but still holds a device choice stays listed — struck through, marked `file deleted` — until you press **Forget**, which clears the choice (the next capture then removes it from the store); the folder's count only counts files that still exist.
- Any other companion folder syncs as a whole, so its files are listed for information only, without a per-file sharing rule.

#### Advanced

**Custom rules** (fully yours: vault-root files, extra folders, sync modes) and **Discovered files** (config files we couldn't classify; toggle to sync — name and path are fixed by the file), each row using its own field-rule editor (a `This device`/`Encrypted`/`Desktop only`/`Mobile only` action dropdown, separate from a card's icon-based Settings file zone). When any managed item is customized (path, fields or mode diverge from its default), a summary row lists them with a **Reset all to defaults** button.

#### Remotes

Desktop only. Add a **git repository** (URL, branch, optional folder) or **another vault**: click **Browse…**, pick the vault folder, and the store inside it is auto-detected. Each remote also has a **Keep Config Sync's own settings out of this remote** toggle: turn it on for a remote vault that keeps its own setup, and Pull, Push and the comparison stop touching Config Sync's own settings there. An https git remote can also carry an **access token** (a GitLab/GitHub personal access token): press **Link** to store it in Obsidian's keychain — or pick a secret already there — and Config Sync authenticates with it directly, with no reliance on the machine's git sign-in. Only the secret's name is written to the settings, and the remotes list is a this-device field Config Sync never sends anywhere — so every device links its own token once, and one that hasn't (because you copied `data.json` across, or removed the secret here) says so plainly instead of failing obscurely. Leave **Username** empty unless the host checks it: GitHub and GitLab.com ignore the username on token auth, while a self-hosted GitLab rejects anything but the account's own name.

## Field rules & sensitive settings

Every field or file rule is a `{sharing, encrypted}` pair, set per key (or per file, when the item has no per-key rules) from a card's Settings file zone.

- **Sharing** — `All devices` keeps the key shared and identical everywhere; `Desktop only`/`Mobile only` keep it shared but let each device class hold its own value, in a `__scopes__` sidecar next to the file's store copy (that filename is a stored path, unchanged since 1.x, so existing stores keep working — e.g. `app.json`'s `userIgnoreFilters`, per-device search-ignore patterns, is commonly set `Desktop only`); `This device` (per-key rules only, not the whole-file rule) keeps a key out of the store entirely and never leaves this machine — Apply preserves the local value.
- **Encrypt** — stores the value (or, for the whole-file rule, the whole file) as an encrypted envelope and decrypts it on Apply, so credentials can travel safely; a value that hasn't actually changed keeps its existing envelope, so an unrelated edit never makes it look changed in a diff. Greyed out at `This device`, since a value that never leaves the device has nothing to encrypt for transit.
- **Per-item device rules** — a string-array key (a plugin's enabled elements, a CSS-snippets list, `userIgnoreFilters`…) can give each element its own sharing rule instead of one rule for the whole key, so each entry travels or stays local independently.

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

- On a **fresh device** with no remote and no store yet, the Config Sync pane (see [The Sync Center](#the-sync-center)) says so plainly — `No store on this device yet` — until your note sync delivers the data folder; it then discovers the arrived store on its own and offers **Adopt**, a one-time guide that imports the store's full sync list onto this device and warns against capturing over it with the new device's empty defaults.
- Until you adopt, a dismissible banner at the top of the item list explains that the diffs below aren't trustworthy yet — adopt the plugin's own settings first, since they carry the device rules the comparison depends on.

**Pull / Push (desktop, optional)** — config-sync's own transport for a git repo or another vault on this machine, run from the Sync Center's Remotes block.

- Pull overwrites this vault's store from a remote (repeatable — cold start and ongoing use are the same action); on a store-less fresh device with a remote configured, the Config Sync pane offers a `Pull from {remote}` shortcut straight into this. Push sends it out.
- The git transport clones to a temp dir and never touches your vault's own repo.
- The Sync Center's Remotes block auto-checks whether a git or vault remote was captured after your local store.
- Expand a remote for a Pull/Push preview: the same four sections as the main list group its entries (companion families folded together the same way), a divergent Core/Community on/off list surfaces as one pinned `On/off list · differs for N plugins ▸` line naming which plugins flip on which side (capped at five names, or `its entire list — N plugins` on a fresh device), and each file entry expands into content diffs — the summary separates what Pull would bring from files that exist only in your store (Pull never removes files).

**Mixed versions** — from 2.21.0 onward, updating every device at once is not required: the store's own settings travel wholesale, so Config Sync refuses anything it would have to guess at rather than resetting it. Updating *to* this version is the exception, because 2.20.0 and earlier have no such refusal — see [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier).

- If this device's own Config Sync settings were written by a **newer** version of the plugin, Config Sync stops here and says so as soon as the vault opens: `These settings were written by a newer Config Sync`. The Sync Center repeats it at the top of the item list, nothing on disk is changed, and everything that would write — Capture, Apply, Pull, Push, Stop syncing (both "On this device" and "Everywhere"), the leftover cleanup, the settings screens — declines until you update this device. A declined action changes nothing and is not written to the run history either. What still works: reading, comparing, and this device's own scratch preferences (the passphrase, dismissing a banner, clearing the run history). Nothing is lost: the file is exactly as the newer version left it.
- Same rule for content arriving from elsewhere: applying the store's Config Sync settings when they came from a newer version fails that one item (the rest of the run is unaffected).
- And the same rule for the store itself. Your store lives in the vault, so another device's newer Config Sync can update it through whatever syncs your notes — no Pull required. If the store's own bookkeeping is newer than this device understands, Capture, Pull and Push all refuse it rather than writing this version's shape over it. A remote in that state reads as *can't be compared* in the Remotes block rather than inviting a Pull it would then refuse.

**While the fleet is mixed** — some devices updated, some not — expect this:

- Nothing breaks in either direction. A device on an older build reads the store fine; it simply doesn't understand the newer bookkeeping and drops it when it writes the store back. The next Capture from an updated device writes it again. That coming and going is not itself compared — bookkeeping only one side records is skipped rather than counted as a change.
- Freshness gets more precise as devices update. Once both ends of a comparison are on this version, the Remotes block weighs the store **item by item** rather than by one whole-store timestamp: a purely cosmetic change (a plugin renamed on one device) stops reading as something to Pull, and a store that is merely older in clock terms while holding the same items can read as up to date. Two cases keep the older, coarser reading. An item whose store copy is encrypted can't be fingerprinted — every device encrypts to different bytes — so it is judged by when it was captured; capture it on one device and the others will still offer a Pull, even though the settings are identical. And when two stores are each ahead of the other in different items, the whole-store timestamps decide, exactly as before.
- **On this device** is remembered on the device itself, so a Pull or an Adopt cannot erase it. The fleet-wide copy that older versions also kept in your settings file is gone as of this version: it existed only so that a device too old to refuse a newer file would still find its own choice there, and every device that can read this file is new enough to refuse instead. Your own choices are untouched by the removal — they were already stored here, and the conversion reads the old list one last time before dropping it.

## Status bar & ribbon

- **Status bar** — sync status at a glance: ↑ to capture, ↓ to apply, plus per-remote ⇡ push / ⇣ pull counts; click opens the **Sync Center**. All in sync shows just a dimmed icon. A mobile-only toggle can force Obsidian's hidden status bar visible on phones.
- **Ribbon** — everything hangs off one **Config Sync** ribbon icon; clicking it opens a menu with **Sync Center** (badged with the pending capture/apply counts), which opens (or focuses, if already open) the Sync Center, where Capture/Apply/Pull/Push all happen. The status bar is the primary always-visible indicator; the ribbon icon's own status dot is opt-in and off by default (**Settings → General → Status bar**). An individual ribbon icon for the Sync Center is available under **Settings → General**, off by default. Quick commands live in the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin.

## Walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys** and **Appearance** (its card covers the settings file plus the `themes/` and `snippets/` companion folders).
2. Open **Sync Center** from the ribbon menu and press **Capture N items**.
3. On each other device, once your note sync has delivered the data folder: open **Sync Center** and press **Apply N items**.
4. Open the Appearance card's `snippets/` companion folder to give any snippet its own sharing rule: `All devices` (synced everywhere) / `Desktop only` / `Mobile only` (shared, travels, and is enforced on the other device class) / `This device` (keeps its own on/off here, never synced). A plugin's **Enabled on** zone works the same way for which devices turn it on (a desktop-only plugin's cycle skips the mobile stop).

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, open the plugin's card.
2. In its **File preview**, click each credential key to add a rule, set its sharing to `This device` (or turn on its lock if you want it to travel).
3. Capture. This-device credentials never enter the store; each device keeps its locally entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Capture from the Sync Center, and let remotely-save carry it; other devices Apply from their own Sync Center.

**Seed a second vault from another one, without a shared note sync (desktop)**
1. In the target vault: Settings → Config Sync → **Remotes** → add a remote of type **Another vault**, click **Browse…** and pick the source vault's folder — its store is auto-detected into **Store path** (or add a git remote: URL + branch, optionally a folder in the repo).
2. Open **Sync Center**, expand the remote, and press **Pull from `<name>`**; then tick what to apply and press **Apply N items**.
3. Later, from the source vault, expand the remote in its own Sync Center and press **Push to `<name>`** to publish updates for the other vault to pull.
