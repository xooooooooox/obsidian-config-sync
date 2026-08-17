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

**Update Config Sync on every device before any of them captures or pulls again.** This release changes the format of the plugin's own settings, and the change is one way: once a device has written the new format, there is no going back to the old one.

- A device on **2.21.0** that meets the new format refuses it, says so plainly, and changes nothing. Update it and it carries on where it left off.
- A device on **2.20.0 or earlier** has no such check. It **resets its Config Sync settings to defaults** — every rule, every custom rule, every card you had ticked. Nothing recovers that afterwards, which is why the order matters: update the device before it ever sees the new format.

The conversion itself asks nothing of you. The first device to run this version converts its own settings in place on load: your rules, your custom rules, your Beta list and this device's sync baselines all come across, and no item flips to "never synced". Take your usual vault backup first anyway — the conversion cannot be undone.

### What behaves differently afterwards

Deliberate changes, each of which you may notice:

- **A plugin nobody ever set a rule for now follows the shared on/off list, once that list itself is synced.** Before this version, an item with no rule at all had nothing forcing it to reconcile with your other devices, so the same plugin could quietly end up on here and off there with nothing to notice or fix it. Enablement is one of two answers now, always — the shared list, or `Not shared` — so **the first sync after upgrading may turn some plugins on or off**, converging whatever differences had silently built up between your devices before now. After that first sync this stops being a surprise: **Enabled on**, wherever you see it, is the actual, current answer, the same on every device, all the time.
- **Every card earns its place now, with no exception.** A community plugin your other devices sync but that isn't installed here always gets a card, the moment it carries anything of its own on this device — switched on, switched off, a rule, a companion folder. Installing the plugin here always brings its card's settings with it.
- **A display name in a store written by an older version stays stale until the next capture or pull.** Config Sync never writes to a store in the old format — a cosmetic fix is not worth rewriting a file your other devices may still be reading. The first capture or pull brings both the format and the names up to date.

### `scope:` is gone from both search boxes

Both search boxes used to accept a `scope:` qualifier, and it meant a different thing in each. It is `section:` in both now, and there is no alias: typing `scope:core` searches for those words as plain text instead of filtering, so a search that stops working is telling you it changed. See [Search & qualifiers](#search--qualifiers).

## Concepts

Two planes, kept separate: a **local plane** (this device's live config ↔ the store) and a **transport plane** (how the store travels between devices — see [Transport](#transport)).

**Local plane:**

- **Capture** copies every enabled item's settings file and companion folders into `<data folder>/store/`, applying each field's sharing and encryption rule (or the whole-file rule, for items with no per-key rules), skips OS junk files, and records source plugin versions (or the Obsidian app version, for Obsidian/core items) in `store.lock.json`. Only changed files are rewritten; the Sync Center's Capture button captures just what you've ticked.
- **Apply** picks items and lands them into this device's config dir (whatever its name) — there's no confirmation dialog; ticking and pressing Apply executes directly. For a community plugin that's outdated, disabled or not installed on this device, Apply can also update, enable or install it first (see [Availability facts and the install engine](#availability-facts-and-the-install-engine)). `Not shared` fields and encrypted content resolve per the item's rules; a `Not shared` field keeps its local value untouched.
- The **Sync Center** compares live config against the store per item; direction (↑ to capture, ↓ to apply) comes from a per-device sync baseline, not file times — each time this device sees an item in sync, it remembers a fingerprint of both sides, so a later difference can tell which side actually moved. A directional row shows a colored arrow icon (orange ↑ to capture, an accent-colored ↓ to apply) whose hover text — its **fate sentence** — states the verdict in plain language (`Installs · turns on · applies settings`, `Captures settings`…); expanding the row spells the same sentence out in full. See [The Sync Center](#the-sync-center) for the grammar. An item with no baseline on this device yet (a fresh install, or one pending its first sync since upgrading) defaults to apply; one that changed on both sides since this device's last sync reads `⚠ Changed on both sides` and stays unstageable until you resolve it. Remote freshness is still checked automatically.

**On-disk store layout:**

```
<data folder>/               # default "config-sync", configurable
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/… (device-independent)
    │   └── *.__scopes__.desktop.json / *.__scopes__.mobile.json   # per-class values for Desktop only/Mobile only keys
    │   # a whole-file-encrypted item sits at its normal path as a sealed, unreadable envelope
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

What syncs, and each field's sharing and encryption rule, is configured entirely through **Settings → Config Sync**'s cards (stored in the plugin's own settings, `schemaVersion: 4`) and, for anything a card doesn't cover, the **Advanced → Custom rules** editor in the same tab. OS junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is never captured. See [Field rules & sensitive settings](#field-rules--sensitive-settings) for per-item rules and passphrase-protected encryption.

The plugin's settings and the store's bookkeeping each carry a format version. A document or store from an older version is converted on load, once, in place; see [Updating from 2.21.0 and earlier](#updating-from-2210-and-earlier) for what that means for your other devices.

## The Sync Center

Open the **Sync Center** any time for the full picture; its header is its own status bar.

#### Rows, sections and fates

- Every synced thing — a plugin, an Obsidian option group, a folder — is **one row**. A row's companions (Appearance's `themes`/`snippets` presets, or any item's own `+ Add folder` companions) dissolve into that same row rather than getting rows of their own, so ticking or expanding the parent covers them too.
- Rows sort into four fixed sections — **Obsidian**, **Core plugins**, **Community plugins** (beta plugins included, the Config Sync self row pinned first, reading `your Sync Center — manages itself`) and **Your folders** — alphabetical within each. Click a section header to collapse/expand it (remembered while the pane stays open); its trailing count reads `N`, or `N/M` once a filter or search narrows it.
- Each row reads **name · … · chips · direction icon · checkbox** — the chips sit on the row's right, just before the direction icon, as quiet icons whose hover text says the fact in full (`not installed here`, `desktop only`, `stays off`, `off here — your rule` / `on here — your rule`, `encrypted`). A chip appears only when a fact deviates from the default. A directional row's icon (orange ↑ capture / accent-colored ↓ apply) carries the row's **fate sentence** as its hover text; `— In sync` / `— No settings yet` / `⚠ Changed on both sides` rows keep the sentence inline (a conflict must shout). The **fate sentence** is the row's plain-language verdict on what the next run would do to it: `↓ Installs · turns on · applies settings`, `↓ Updates · applies settings`, `↑ Captures settings`, `↓ Applies theme & snippets — live` (Appearance), `↓ Applies N files` (a folder). Identical rows read `— In sync`; a row with nothing saved anywhere yet reads `— No settings yet`; one that changed on both sides since your last sync reads `⚠ Changed on both sides` and stays unstageable until you resolve it (below).
- In-sync, excluded, and no-settings rows sit dimmed with the checkbox hidden, folded behind a trailing line per section, in this order: `N items in sync`, `N items not synced on this device`, `N items with no settings yet` — each led by its own small state icon and a fold arrow; click to expand in place.
- The checkbox means one thing everywhere: include this row in the next run. It never changes what would happen, only whether it happens — so a section's own select-all is always safe, and it skips the self row, in-sync/excluded/no-settings rows and any unresolved conflict.
- The filter pills — **All**, **To capture**, **To apply**, **In sync**, **Not synced here**, **No settings yet** — narrow every section by the same fate; they hide rows, they never move them between sections. **Not synced here** (and its matching fold/badges) only appears once at least one item is excluded — an empty bucket shows nothing, same as **In sync**/**No settings yet**. An amber **Leftover** pill appears the same conditional way, only while the store holds files nothing syncs any more; it shows the Leftover section alone (see [Leftovers](#leftovers)).
- A rule that keeps an item off this device's class (e.g. Hotkeys set to `Desktop only` while you're on a phone) reads `— Not synced on this device` with a `your rule` chip, instead of a misleading `In sync` — and counts under **Not synced here**, not **In sync**. An item you opted THIS device out of (below) reads the identical row and counts the same way — the card's **State** clause is what tells the two causes apart.
- JSON diffs render with keys in a normalized order, so a pure key-order/formatting difference is called out instead of showing as noise.

#### The expanded card

Click a row's name to expand it into a card, in order (each row omitted when it doesn't apply):

- **On apply** / **On capture** / **State** — the fate sentence spelled out as a full clause: install source (`from the community catalog` / `via BRAT`), update versions (`Updates 2.14.0 → 2.15.1`), what capturing publishes (`Shares your settings with your other devices`).
- **Files** — collapsed behind one small badge carrying both the direction and the count (hover it for `N files change` and which side they land on: into the store while capturing, onto this device while applying). Click anywhere on it to expand a `+`/`~`/`−` entry per file (added / updated / removed), in both directions — hover any entry for what happens (`New in the store — starts syncing to your other devices`, `Deleted from this device`, and so on). The badge fills in while the list is open. A diffable/viewable entry ends in one small icon; click it to view the change (or the incoming content, if there's nothing local yet to diff against). Encrypted content reads `changed — encrypted, no preview` instead.
- **Resolve** (conflicts only) — `Use theirs ↓` / `Keep mine ↑`; the row stays unstageable until you pick one, then reads as a normal directed row plus a `your choice` chip.
- **Enabled on** (plugins, while the Core/Community on/off list itself is a synced item) — one small control holding two glyphs, no wordmark on the row itself: the shared answer, then this device's own state. Hovering it reads both in one line — what the shared answer actually does (`Every device turns it on.`, `Desktops turn it on. On phones it stays off.`, and so on), then what this device does about it. Most of the time the second glyph just says this device matches the shared answer (`This device: follows what's shared.`) — there's nothing to say, because this device does whatever the shared answer says. The moment you tell it to do something else here, that glyph turns purple (`This device: always on.` / `always off.`). Clicking anywhere on the control opens one menu carrying both answers under their own headings — **Enabled on** for the shared one, **On this device** for this machine's. See [Not shared, and this device's own exceptions](#not-shared-and-this-devices-own-exceptions) below for what that second glyph means and where else it shows up.
- **After install** / **Enablement** — the fallback when the on/off list ISN'T itself shared (a section header's small read-only chip shows which it is: hover it for `Which plugins are on is shared with your other devices` or `…stays on this device`, and click it to jump to where that's set — the on/off list's own card in Settings, see below): `Turn it on` or `Leave it off`, offered for a plugin this run installs, or one that's already installed but off.
- **Settings sync** — the item's own file-level sharing rule, in the same two-glyph control as above (hover reads `Every device syncs this file.` / `Only desktops sync this file. Phones don't sync it at all.` / its mobile mirror, then `This device: not synced. Your other devices keep sharing it.` once you've opted this one out). Its menu's shared heading is **Shared with**. An item under per-key rules has no whole-file rule to move, so instead of a list of values that half of the menu offers a single entry — **Per-key rules decide — jump to them** — which opens the item's own card at its rules; this device's own opt-out still works as usual.
- **More** — an icon-only deep link (hover it for what it opens) that opens Settings scrolled to, and highlighting, this item's own card, for per-key rules, locks, companion folders, and — for a whole item — stopping its sync entirely (see [Leftovers](#leftovers) below).
- **Note** — an honest runtime aside, e.g. Hotkeys' `Takes effect after an app reload`.

#### Not shared, and this device's own exceptions

Every plugin's on/off state answers to one of two shared rules, plus whatever this one device wants for itself:

- **All devices** / **Desktop only** / **Mobile only** — a shared answer. Every device that matches follows it, unless it has told this one device otherwise (below).
- **Not shared** — there is no shared answer at all. What this device already has stays exactly as it is, and every other device keeps its own, independently. Nothing here ever tries to make them agree.

Whatever the shared rule says, **this device can still say something different** — a plugin you always want on here regardless of what your other devices do, or one you'd rather leave off on just this machine. That's "leave it to me on this device," and it lives in one place, the same place everywhere the plugin's row appears — its own card, the on/off list's own card, the Sync Center row: the second glyph of the row's own control, right beside the shared answer, and the **On this device** section of the menu that control opens. It reads `This device: follows what's shared.` until you say otherwise, then `This device: always on.` or `always off.` in purple once you have. It never travels: setting it here doesn't touch your other devices, and a Pull or an Apply from another device can't reset it out from under you.

#### Which devices turn each plugin on

The Core plugins and Community plugins on/off lists are cards of their own now, under the **Obsidian** tab in Settings, alongside App settings/Appearance/Hotkeys — not just a list of individual plugin cards. Each carries a badge for how many plugins have a shared rule set (`N device-scoped`) and how many this device has excepted for itself (`N left to me`), and its drawer lists every plugin under an **Enabled on** header (hover it for the full sentence: which devices turn each plugin on) — one row per plugin, same shared-answer-plus-this-device control as everywhere else.

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

Stopping a whole item's sync has two reaches, and each lives where the choice belongs:

- **On this device** — the **On this device** half of the row's own **Settings sync** control (above): applies instantly (no modal, reversible in place), this device stops installing/applying/capturing the item while your other devices keep syncing it as normal (its row here now reads `— Not synced on this device`, with the card explaining `you turned it off here`).
- **Everywhere…** — the item's own card in Settings, next to its sync toggle: opens a confirm dialog, optionally deleting its store copy, and removes it from every device's sync list. Reach it from the Sync Center through the row's **More** link.

**On this device** is stored on the device itself, not in Config Sync's own settings, so it never travels: a Pull and Adopt from another device can no longer wipe the choice you made here, and each device's list is its own. It also means the choice does not follow you — reinstalling Obsidian, or setting the vault up again on a new machine, starts with nothing opted out.

Store files that no synced item claims any more surface in their own amber **Leftover** section (and its matching filter pill), under the **All** view. It collapses and expands like any other section — click its header (the **Leftover** pill opens it expanded); inside, files group under the familiar section names (Obsidian, Core plugins, Community plugins, Other files), one row per file — named by what it really belongs to (a plugin's own name, a snippet as `Appearance › name.css`; hover the path line for the full path), its size, and a trash icon (hover: `Delete from the store`) that deletes it in one click. The head's own trash icon (`Delete all — N files…`) asks first, because the consequence crosses devices: after your next sync or Push, the deleted files are gone from your other devices too. What lands here: files left behind by an **Everywhere** removal that kept its store copy, and items switched off in Settings on every device. What never lands here: an item you opted out via **On this device**, or a plugin merely turned off with its own toggle — both keep their store settings attached to their card. On a device that hasn't adopted the configuration yet, the section stays hidden behind a one-line hint instead — until you adopt, this device can't tell leftover from not-yet-adopted.

#### Availability facts and the install engine

An item's row already carries the facts that once lived in their own sections: `not installed here`, `desktop only` and `stays off` chips, plus a fate sentence naming exactly what Apply would do — `↓ Installs · turns on · applies settings`, `↓ Updates · applies settings`, `↓ Turns on · applies settings`, or plain `↓ Applies settings` once nothing about the plugin's own state needs to change. Ticking the row stages all of it as one action; expand the card (above) for the specific choice:

- **Outdated** — the `On apply` clause reads `Updates {local version} → {store version}`. Installs and updates fetch the plugin from the official community plugin catalog, **pinned to the version the store was captured on** (recorded in `store.lock.json`) so every device converges on the same version, falling back to the latest stable with a warning when that exact release is gone. A plugin ahead of the store's recorded version shows a quiet metadata line instead (capturing again refreshes the store).
- **Disabled here / not installed here** — the **Enabled on** row (while the on/off list is synced) or the card's **After install** / **Enablement** menu (while it isn't) decides whether the plugin turns on; the checkbox alone decides whether its settings are part of this run. A plugin that isn't in the catalog is staged (its config written, ready for a manual install) with a note to that effect.
- **Desktop-only on a phone** — informational chip only, nothing to stage.
- A failed update leaves the existing config untouched (an old version is assumed unsafe to overwrite blindly); a failed install still stages the config, since an uninstalled plugin can't be harmed by it. **A single failure never aborts a bulk run** — the offending plugin becomes one error row in the result strip and the rest of the batch still runs.

Obsidian and core-plugin items are anchored to the Obsidian app version rather than a plugin version — drift there is reminder-only in both directions and never drives an install/update action.

## Settings

- **General** — PKM mode (auto-detects IOTO vaults), the data folder location, status toggles (sync menu change counts, automatic remote checks, periodic local check), the status bar (item, remote push/pull counts, opt-in ribbon dot, mobile force-show), ribbon icons.

Every row across **Obsidian**, **Core plugins**, **Community plugins** and **Beta** is a card: name, then — on the right, beside the sync toggle — its badges as quiet icons with a small corner count and the sentence in the hover text: a grey monitor when the plugin itself can't run on mobile (grey = innate), a colored device icon when YOU set its enabled state (`on: desktop` / `on: mobile` / `on: this device` — color = your choice), a two-device icon counting device-scoped rules, a lock counting encrypted ones. Then the sync toggle and a chevron that opens the drawer.

- The **Obsidian** tab has five cards: **App settings** (the whole `app.json` — editing, new-note and link behavior, and other general options), **Appearance** (theme, fonts and CSS snippets), **Hotkeys** (your custom keyboard shortcuts), and **Core plugins** / **Community plugins** — the two on/off lists themselves, each showing **Which devices turn each plugin on** (see [Not shared, and this device's own exceptions](#not-shared-and-this-devices-own-exceptions)).
- **Core** and **Community** plugins also get a full card of their own each, one per plugin: a core plugin's card exists even before it has written its settings file here — the file's path is known from the plugin itself, so its store copy stays attached wherever the file exists.
- A community plugin your other devices sync but that isn't installed here always gets a card too, the moment it carries anything of its own on this device — switched on, switched off, a settings rule, a companion folder. It keeps its store copy and its Sync Center row either way, and installing the plugin here always brings the card's settings with it.
- The **Search all settings…** box spans General, all picker tabs, Advanced and Remotes, and accepts `section:` (general/obsidian/core/community/advanced/custom/remotes) and `type:` (file/folder) qualifiers with autocomplete alongside plain text. `section:` names a settings AREA here, so its list is the Sync Center's plus the areas that hold no items; custom rules and discovered files live on the Advanced tab, so `section:advanced` finds them — and so does `section:custom`, the same word the Sync Center uses for them, since both are true of a custom rule. `type:` reads each item's real kind: a rule pointing at a folder answers `type:folder`, and an item that syncs only a plugin's on/off state answers neither. The old `scope:` is not accepted — see [Retired syntax](#search--qualifiers).
- The **Beta** tab tracks community plugins installed through [BRAT](https://github.com/TfTHacker/obsidian42-brat) — same card, same three drawer zones — so their configs sync like any other plugin.
- Each section lists its cards alphabetically; sensitive-looking keys (tokens, secrets) are highlighted inside a card's File preview so you see them before enabling syncing.

A card's drawer has up to three zones. Every row reads the same way: the row's name on the left, its controls in one shared column beside it — so all the controls in a card line up — and every sharing control shows the current rule as a glyph (a monitor+phone pair = `All devices`, a monitor = `Desktop only`, a phone = `Mobile only`); the fourth stop, where there is no shared answer at all, reads `Not shared` (a split mark) wherever the row also carries this device's own answer as a second glyph — a per-key rule, a plugin's Enabled on — or plain `This device` (an airplay mark) wherever it doesn't, since nothing there could hold a separate exception anyway — an array element's own rule, a folder's device class, the Advanced tab's custom rules. A click opens the menu, and the default sits dimmed while anything narrower lights up in the accent color.

#### Enabled on

A plugin's on/off state lives on its own card, in its **Enabled on** zone — the same two-glyph control described in [Not shared, and this device's own exceptions](#not-shared-and-this-devices-own-exceptions), reading and writing the same enabled-plugins list Obsidian maintains. Plugin cards only, and only for a plugin whose on/off list is itself tracked.

#### Settings sync

Starts as one path row: the file's path, a lock toggle that encrypts the whole file — it shows **open** until you encrypt, closed and colored once you have — and the same two-glyph control the Sync Center's `Settings sync` row shows. Its shared half is the file's sharing rule (no `This device`/`Not shared` stop here — a whole file is either shared or it isn't, nobody can be its sole owner); its second glyph is this device's own opt-out: turn it on and this device stops syncing the file at all, still without touching what's already there or affecting any other device, and it stays put whether the card is in whole-file or per-key mode (below). The path text itself is the edit entry point:

- Click it to edit in place (Enter commits, Esc cancels).
- While editing a committed custom path, a quiet **Reset to default** action restores the built-in default.

The eye icon, riding the same line as the filename, opens the **File preview** — a read-only view of the file, keys colored by their rule, with a color-dot legend underneath (blue = desktop only, amber = mobile only, red = not shared, a lock mark = encrypted). Any key you can add a rule for wears a dashed underline, and the line above the preview says it plainly: **click any key to add a rule for it**.

The moment a card has any per-key rule, it switches to per-key mode:

- The path row's lock disappears and its shared glyph goes dim — there is no whole-file rule left to show once per-key rules govern the keys individually. In its menu, the shared half now offers a single entry, **Per-key rules decide — jump to them**, which scrolls straight down to the Key rules list (the **Key rules** heading there makes the same point permanently). For a card whose only rule lives elsewhere — Appearance, whose one rule is its snippets list — the jump lands on that row instead, under **Folders → snippets**. This device's own opt-out (above) stays exactly where it was; it still stops the whole file, per-key rules included.
- A **Key rules** list appears with a row per configured key: a lock toggle and the same two-glyph control, whose second glyph is this device's own exception for that key (see **This device's own exception** in [Field rules & sensitive settings](#field-rules--sensitive-settings) below for what setting it does, and which keys don't get one). A key that can't be encrypted — its rule is `Not shared`, or Per-item device rules are on — shows no lock at all. To remove the rule, open the key's menu and pick **Remove rule** at the bottom.
- A string-array key's rule adds a **Per-item device rules** icon (a small checklist, lit when on) so each element gets its own sharing icon instead of one rule for the whole key.
- Removing the last rule reverts the card to whole-file mode.

#### Folders

Lists any vault-relative folder that travels with the item — Appearance ships `themes/` and `snippets/` as presets, and every card's drawer ends with a quiet **+ Add folder** row to add any other path (duplicates and paths already claimed by another item are rejected). The two on/off-list cards — **Core plugins** and **Community plugins** — are the exception: a folder has nothing to attach to there, so they carry no Add-folder row (to sync an arbitrary folder, add a custom rule under Advanced).

- Each folder row has a sharing icon and a sync toggle, and clicking the folder's name opens its path for editing. A folder you added yourself is removed from its sharing menu's **Remove folder** entry; presets can only be relocated, never removed.
- A folder's file list is collapsed behind a small count pill (hover it for `N files`/`N themes`) — click the row to expand it.
- Opening `snippets/` lists each file as its own row with a sharing icon: the file itself always syncs, and the icon only decides which devices turn it on.
- A file that has been deleted but still holds a device choice stays listed — struck through, marked `file deleted` — until you press **Forget**, which clears the choice (the next capture then removes it from the store); the folder's count only counts files that still exist.
- Any other companion folder syncs as a whole, so its files are listed for information only, without a per-file sharing rule.

#### Advanced

**Custom rules** (fully yours: vault-root files, extra folders) and **Discovered files** (config files we couldn't classify; toggle to sync — the file fixes its name, path AND type, and its card names the file it belongs to). The discovered list keeps one stable order whether a file is on or off, so a fresh toggle never makes rows trade places. A rule's editor is one field per line: a name (e.g. `templates`), a path box whose leading segment picks the base (`Vault root` or `Config folder`) before you type the relative path, a file/folder type icon (changing it away from a file asks first — it drops the rule's key rules and encryption settings), a devices picker, a **Mode** (`Whole file` syncs the file as-is · `Per-key rules` gives each key its own rule · `Encrypted` stores the whole file encrypted; leaving Per-key rules with rules configured asks first too), and an optional description.

With **Per-key rules** on, the editor works much like an item card's Settings sync zone: each configured key is a row with its own sharing icon and lock, a **File preview** below shows the file with every key clickable (**click any key to add a rule for it**), and a pattern box at the bottom takes hand-typed globs like `*Token*` for keys the preview can't show — a custom rule's own key rows have no **this device** exception column of their own, unlike an item card's key rules (above). When any managed item is customized (path, fields or mode diverge from its default), a summary row lists them with a **Reset all to defaults** button.

#### Remotes

Desktop only. Add a **git repository** (URL, branch, optional folder) or **another vault**: click **Browse…**, pick the vault folder, and the store inside it is auto-detected. Each remote also has a **Keep Config Sync's own settings out of this remote** toggle: turn it on for a remote vault that keeps its own setup, and Pull, Push and the comparison stop touching Config Sync's own settings there. An https git remote can also carry an **access token** (a GitLab/GitHub personal access token): press **Link** to store it in Obsidian's keychain — or pick a secret already there — and Config Sync authenticates with it directly, with no reliance on the machine's git sign-in. Only the secret's name is written to the settings, and the remotes list is a this-device field Config Sync never sends anywhere — so every device links its own token once, and one that hasn't (because you copied `data.json` across, or removed the secret here) says so plainly instead of failing obscurely.

## Field rules & sensitive settings

Every field or file rule answers two independent questions — who shares the value, and whether it travels encrypted — set per key (or per file, when the item has no per-key rules) from a card's Settings sync zone. Independently of both, this device can except itself from a per-key rule, or from the whole file, without touching what the shared answer says for everyone else — see **This device's own exception** below.

- **Sharing** — `All devices` keeps the key shared and identical everywhere; `Desktop only`/`Mobile only` keep it shared but let each device class hold its own value, in a `__scopes__` sidecar next to the file's store copy (that filename is a stored path, unchanged since 1.x, so existing stores keep working — e.g. `app.json`'s `userIgnoreFilters`, per-device search-ignore patterns, is commonly set `Desktop only`); `Not shared` (per-key rules only, not the whole-file rule) keeps a key out of the store entirely and never leaves this machine — Apply preserves the local value.
- **Encrypt** — stores the value (or, for the whole-file rule, the whole file) as an encrypted envelope and decrypts it on Apply, so credentials can travel safely; a value that hasn't actually changed keeps its existing envelope, so an unrelated edit never makes it look changed in a diff. Not offered at `Not shared` (the lock disappears from the row), since a value that never leaves the device has nothing to encrypt for transit.
- **Per-item device rules** — a string-array key (a plugin's enabled elements, a CSS-snippets list, `userIgnoreFilters`…) can give each element its own sharing rule instead of one rule for the whole key, so each entry travels or stays local independently.
- **This device's own exception** — the second glyph of a per-key rule's control, and of the whole-file row's (above), is one-device-only: turn it on and this device stops syncing that key — or, on the whole-file row, that entire file — full stop. Wherever the shared answer put a value, that value is left exactly as found: an `All devices` key keeps the shared value, a `Desktop only`/`Mobile only` key keeps the one in its device-class sidecar, and an encrypted key keeps its existing envelope. This device neither publishes its own copy over any of them nor deletes them, and no other device is affected either way. (Two things this does not cover: a `Not shared` key has no stored value to preserve — it never enters the store at all, which is also why that row shows no second glyph; and a stale class-scoped key left in the shared copy by an older rule is purged on capture rather than preserved.) It's the same **On this device** menu section, with the same two choices (`Follow what's shared` / `Don't sync it`), as the Sync Center's own `Settings sync` row, and it never travels. A key with **Per-item device rules** on shows no second glyph either: its items are governed one at a time by their own rules, and those have no this-device layer for an exception to act on. Wherever there is no second glyph, the menu has no **On this device** section — what you can see and what you can pick always match.

#### Passphrase & keychain

Encrypt modes need a vault-level **Passphrase**, set once per device in Settings → General:

- It's never written to any file and never synced; the same passphrase on each device is all that's needed.
- On Obsidian 1.12+ it is stored encrypted in the app's keychain (Settings → Keychain); older installs keep it in plain app storage.
- An item with encrypted content but no passphrase set on the current device shows a *locked* state (marked with a key icon) and won't capture or apply until the passphrase is set.
- A wrong passphrase on Apply fails cleanly without writing anything.

#### Sensitive-key detection

Every installed plugin is scanned for sensitive-looking keys (API keys, tokens, secrets, passwords, emails) or an opaque encrypted blob before you ever enable syncing; this only informs, you still choose the rule.

A card's Settings sync zone includes a read-only preview of the file, opened from the eye icon beside the filename (collapsed by default):

- Detected keys are called out with a purple, dotted-underline highlight inside the card's File preview.
- A lock icon marks encrypted, and other keys are colored by rule state: red = this device, blue = desktop only, amber = mobile only, plain keys faint.
- Clicking a key adds it as a rule directly — the escape hatch for anything the built-in detection misses.

Each card is badged with its own summary — `N device-scoped` and `N encrypted` counts, plus its enabled-on chip when non-default (`on: desktop` / `on: mobile` / `on: this device`) — and capture reports state exactly what was encrypted or stripped.

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
- A remote that holds files but **no** `store.lock.json` is refused the same way, by both Pull and Push: without that file there is no version to check, so "nothing here yet" and "this is unreadable" would otherwise look identical. It reads as *can't be compared* rather than as an empty remote.
  - Two things cause it, and the message names both: the path points one folder too deep (at the `store` folder instead of the folder holding it), or the target simply isn't empty yet — which is what you get from a repository created with a README or a licence file. In that second case Config Sync stops instead of pushing over (and mirror-deleting) whatever is already there. Clear the target, or point the remote at an empty subfolder, and Push again.
  - Two remotes are unaffected: a genuinely empty one — that is how a new remote starts, and the first Push is what fills it — and an old store still carrying the root `config-sync.json` from before `store.lock.json` existed, which says what it is and is pulled the way it always was.

**While your devices are on mixed versions** — some updated, some not — expect this:

- Nothing breaks in either direction. A device on an older build reads the store fine; it simply doesn't understand the newer bookkeeping and drops it when it writes the store back. The next Capture from an updated device writes it again. That coming and going is not itself compared — bookkeeping only one side records is skipped rather than counted as a change.
- Freshness gets more precise as devices update. Once both ends of a comparison are on this version, the Remotes block weighs the store **item by item** rather than by one whole-store timestamp: a purely cosmetic change (a plugin renamed on one device) stops reading as something to Pull, and a store that is merely older in clock terms while holding the same items can read as up to date. Two cases keep the older, coarser reading. An item whose store copy is encrypted can't be fingerprinted — every device encrypts to different bytes — so it is judged by when it was captured; capture it on one device and the others will still offer a Pull, even though the settings are identical. And when two stores are each ahead of the other in different items, the whole-store timestamps decide, exactly as before.
- **On this device** is remembered on the device itself, so a Pull or an Adopt cannot erase it. The shared copy that older versions also kept in your settings file is gone as of this version: it existed only so that a device too old to refuse a newer file would still find its own choice there, and every device that can read this file is new enough to refuse instead. Your own choices are untouched by the removal — they were already stored here, and the conversion reads the old list one last time before dropping it.

## Status bar & ribbon

- **Status bar** — sync status at a glance: ↑ to capture, ↓ to apply, plus per-remote ⇡ push / ⇣ pull counts; click opens the **Sync Center**. All in sync shows just a dimmed icon. A mobile-only toggle can force Obsidian's hidden status bar visible on phones.
- **Ribbon** — everything hangs off one **Config Sync** ribbon icon; clicking it opens a menu with **Sync Center** (badged with the pending capture/apply counts), which opens (or focuses, if already open) the Sync Center, where Capture/Apply/Pull/Push all happen. The status bar is the primary always-visible indicator; the ribbon icon's own status dot is opt-in and off by default (**Settings → General → Status bar**). An individual ribbon icon for the Sync Center is available under **Settings → General**, off by default. Quick commands live in the standalone [Ribbon Organizer](https://github.com/xooooooooox/obsidian-ribbon-organizer) plugin.

## Walkthroughs

**Sync hotkeys, appearance and CSS snippets everywhere**
1. Settings → Config Sync → under *Obsidian*, tick **Hotkeys** and **Appearance** (its card covers the settings file plus the `themes/` and `snippets/` companion folders).
2. Open **Sync Center** from the ribbon menu and press **Capture N items**.
3. On each other device, once your note sync has delivered the data folder: open **Sync Center** and press **Apply N items**.
4. Open the Appearance card's `snippets/` companion folder to give any snippet its own enablement rule: `All devices` / `Desktop only` / `Mobile only` (shared, travels, and is enforced on the other device class) / `Not shared` (no shared answer — each device keeps whatever it already has). A plugin's **Enabled on** zone works the same way for which devices turn it on (a desktop-only plugin's menu skips the `Mobile only` stop).

**Sync a plugin's settings but keep credentials out of the store**
1. Under *Community plugins*, open the plugin's card.
2. In its **File preview**, click each credential key to add a rule, set its sharing to `Not shared` (or turn on its lock if you want it to travel).
3. Capture. This-device credentials never enter the store; each device keeps its locally entered values across applies.

**IOTO vault, from zero**
1. Install the plugin — PKM mode auto-detects IOTO and stores data under `0-Extra/config-sync` (from your ioto-settings aux folder).
2. Tick what you want to sync, Capture from the Sync Center, and let remotely-save carry it; other devices Apply from their own Sync Center.

**Seed a second vault from another one, without a shared note sync (desktop)**
1. In the target vault: Settings → Config Sync → **Remotes** → add a remote of type **Another vault**, click **Browse…** and pick the source vault's folder — its store is auto-detected into **Store path** (or add a git remote: URL + branch, optionally a folder in the repo).
2. Open **Sync Center**, expand the remote, and press **Pull from `<name>`**; then tick what to apply and press **Apply N items**.
3. Later, from the source vault, expand the remote in its own Sync Center and press **Push to `<name>`** to publish updates for the other vault to pull.
