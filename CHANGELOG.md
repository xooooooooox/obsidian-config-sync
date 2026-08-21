# Changelog

## 2.25.0

- Fixed a setting held back in both directions reading as unfinished work forever. Those two values are meant to differ, so they no longer count as a difference: the item stops asking to be pulled every time the other device saves, and its card stops listing a file you could never reconcile
- Added holding a single setting back from a remote instead of the whole item. Pull takes everything else and leaves your value where it is; Push sends everything else and leaves **their** value where it is — a setting you hold back is never blanked out on the other side, which is what would happen if it were simply left out of what gets sent
- Fixed a Push overwriting the other side's record of things it never sent. An item you keep out of a remote — Config Sync's own settings, or anything set to travel one way — left the far end holding a record that described a file we had deliberately not written, and that record is what its own devices read to decide whether they are behind. Their record of those items stays theirs now, and so does the mark of how far they have pulled
- Changed every row to judge its own direction, so one list can hold items waiting to come in beside items waiting to go out. **In sync** now means "nothing left to do in a direction you allow": an item you set to travel one way stops nagging you when the other side edits it — open its card and it still says what changed over there, and that it stays there. An item whose settings match but whose recorded version moved on the other side is a plain waiting item again, so your other devices stop missing update news
- Added a per-item choice about what each remote gets: an item can travel both ways, only out, only in, or not at all. It lives on the item's card while that remote is selected. Config Sync's own settings are simply one of those items now — the switch in **Settings → Remotes** that only ever spoke for that one item is gone, and whatever you had set there is already on that item's card
- Changed the status bar to report both halves of your setup in one unit: how many **items** are waiting between this device and your store, and how many are waiting with your remotes. That second pair used to count remotes rather than items, so one line carried two meanings. Hovering says how far those items are spread, and names any remote that couldn't be counted item by item instead of quietly reading it as nothing to do
- Changed a remote from a screen of its own into the same list you already use for this device. Same sections, same rows, same cards, same checkboxes — only the words change: what was **To capture** and **To apply** reads **To push** and **To pull** while a remote is selected. You can now tick a few items and pull or push only those, instead of exchanging the whole store every time; the buttons count what you picked. Opening an item still shows its files and their differences, and a plugin list still spells out which plugins are on at one side and off at the other, now inside that item's own card. Searching and the filter pills work under a remote too, and the picker at the top counts a remote's waiting items once it has compared with it
- Changed the Sync Center's sidebar to answer one question instead of two. A view picker now sits at the top of it, and your remotes live in that picker rather than in the list below — each one showing its state right there, so you can see which remote needs attention without switching to it first. The list underneath is purely "which items do I want to see", and it no longer changes meaning depending on what else you had selected. On a narrow window or a phone, the same picker rides along in the compact section menu
- Changed how a remote records what it will and will not exchange: instead of one fixed answer about Config Sync's own settings, a remote now carries a direction for any item, and for any key inside one. Nothing you see or do changes in this release — **Keep Config Sync's own settings out of this remote** still reads and writes the same choice, and Pull, Push and the comparison behave exactly as they did — but the format of the plugin's own settings changes, so a device on an older version cannot read it until you update it. See [UPGRADING.md](UPGRADING.md)

## 2.24.3

- Changed a sharing control to light up whenever the shared answer is narrower than **All devices**, in the same color as the card's own `N device-scoped` badge. The badge and the rows it counts now match at a glance, instead of leaving you to hunt for which row it meant
- Changed **Enabled on** for a plugin that can only run on desktop: it offers **Desktop only** and **Not shared**, and nothing else. **All devices** was never true there — a phone can't install the plugin at all — and the parenthetical that used to explain that away is gone. Every device keeps behaving exactly as before; a **Desktop only** rule you had already set on such a plugin is dropped the next time you touch its control, since it was never doing anything
- Fixed a plugin that can only run on desktop showing two desktop badges when you had also given it a **Desktop only** rule. That rule repeats what the plugin already is and changes nothing, so it no longer draws a badge of its own, and no longer counts toward `N device-scoped`. A choice you made for this one device still shows, because that one does say something new
- Fixed the Sync Center's **Enabled on** offering a plugin stops the same plugin's Settings card refused. Both now offer the same answers for the same plugin
- Changed when the Sync Center keeps its sidebar: it stays for as long as it can show every count a section carries with the name still readable beside them, and hands over to the compact section picker when it can't. It used to switch at a fixed window width, which was both too eager on a quiet vault and far too late on a busy one — at its worst the `All items` row showed five counts and no name at all
- Fixed a narrow window getting the compact layout without any of what makes it readable: the filter pills now take their own line in their short form, and the search box fills that line instead of floating in the middle of it
- Changed the conflict choice, **Use theirs** / **Keep mine**, to look like the other controls on the card it sits on. Same shape, same size; each side still carries its own direction colour, and the side you pick is clearer than before. The same control in a diff's toolbar changes with it

## 2.24.2

- Added `CHANGELOG.md` and `UPGRADING.md`. A release's notes are its changelog entry, and the versions that ask you to do something before syncing again are in one place instead of scattered through the README and the guide
- Changed the README and the user guide to describe how the plugin behaves now. The upgrade notice that opened the README, and the guide's migration section, moved to `UPGRADING.md`. What the plugin does today about mixed versions and older stores stays in the guide, because that is current behaviour rather than history
- Fixed nine places where the architecture doc described code that had been renamed or refactored under it, among them two functions attributed to a module they do not live in, and a schema documenting six of a record's eight persisted fields

Nothing in the plugin itself changed: `main.js` is byte-identical to 2.24.1, and `styles.css` differs from it only in comments.

## 2.24.1

- Fixed an item reading the wrong direction after **Don't sync it** was turned on and then off again: a row that should have offered to capture offered to apply instead, and an item with companion folders rolled that up into a phantom `Changed on both sides`. Applying from that state could overwrite local changes that were still waiting to be captured. Items toggled before this release need their direction checked; see [UPGRADING.md](UPGRADING.md)
- Fixed **Don't sync it** being the only control of its family that left the panel stale instead of refreshing it
- Added the conflict choice inside the diff, next to the consequences of the choice. Both entrances write the same choice, and a multi-file item says so out loud: the run writes the item as a whole, so picking a side inside one file settles its siblings
- Fixed picking a side rebuilding the card underneath an open diff
- Improved **Refresh**: it spins for as long as the refresh runs instead of looking like a control that did nothing
- Improved the sidebar count badges: one size, one glyph weight, icons on a single vertical rule, and a digit width measured from the counts actually on screen, so a two-digit vault carries no three-digit gap
- Improved card and drawer control alignment: controls line up on their glyphs rather than their box edges, and a control without a picker affordance reserves that column instead of sitting 14px right of everything above it
- Improved a key governed by per-key rules: it states the fact and offers the jump as two separate lines
- Improved the user guide to say where each state can appear: the top pill, the summary badge, the sidebar, a section's own count and the fold lines inside it are five different surfaces

## 2.24.0

- Added a this-device layer to per-key rules: any key with a rule can be excepted on one device, which stops syncing that key there while leaving the stored value and every other device untouched
- Changed a rule row's two controls into one: two glyphs, one click target, and one menu holding both answers under **Shared with** (or **Enabled on**) and **On this device**. Hovering reads both in a line
- Changed the wording of every sharing answer: `Each device decides` is now `Not shared`, `Follows the default` is `Follow what's shared`, `On here` / `Off here` are `Always on` / `Always off`, and `Not synced here` is `Don't sync it`. Nothing stored changes; existing configurations read exactly as before
- Changed Sync Center: the header, the sidebar, the filter pills and the status bar count the same rows now, the ones the list actually shows. Totals include items that are not installed, disabled or behind on their version, so the numbers may read higher than before, and they agree with each other
- Added back the outdated / disabled / not installed / desktop-only groupings as folds at the bottom of each section, each explaining what applying would mean for the items inside. Anything a run would install stays at the top with the rest of the work
- Added a resizable window of its own for diffs, sharing the unified/split and collapse settings with the inline view
- Changed the Files row into one badge carrying both direction and count, expandable from anywhere in the row
- Improved error messages to follow one shape: what went wrong, then what to do, with technical detail on a quieter second line
- Improved a card drawer's controls to one size, aligned with the card's own toggle instead of stopping mid-card
- Changed glyphs that were unreadable at their real size, and gave `Not shared` a mark it does not share with anything else
- Changed Advanced rules to pick their mode with an icon, like the two rows above it

## 2.23.0

- Changed the plugin's own settings to a new format, and the change is one way. Update every device before any of them captures or pulls again: a device on 2.21.0 or 2.22.0 declines the new format and changes nothing, but one on 2.20.0 or earlier resets its setup to defaults, which cannot be undone. See [UPGRADING.md](UPGRADING.md)
- Changed a plugin nobody ever wrote a rule for to follow the shared on/off list once that list is itself synced. The first sync after upgrading converges whatever switch differences had accumulated between devices, so some plugins may turn on or off. A plugin kept deliberately off on one device says so on its card's **Enabled on** row
- Changed on/off into two layers: shared rules live in the store, a "just here" exception never leaves the device that made it. Precedence is this device's exception, then a rule for the item, then the device class, then the shared list
- Changed the vocabulary to one word each: an item is *synced*, a plugin is *enabled*. Cards, filters and search all follow
- Changed the settings drawer to speak the Sync Center's language: the same rows, the same pickers, the same lock. Card headers show compact badges with counts instead of word-tags
- Changed per-key rules to be edited like everything else: each pattern is a row with the sharing picker and the lock, and the File preview underneath adds a rule for any key you click. Editing a rule no longer makes the panel flash
- Removed the four-option per-key dropdown, which could not express every combination
- Fixed a rule that encrypts a whole file losing its encryption when its sharing was later changed from the Sync Center, which silently downgraded the file to plain text on the next capture
- Added confirmations to destructive switches: leaving *Per-key rules*, changing a rule from file to folder, and deleting leftover store files each spell out the consequence first
- Improved validation errors to pin a boxed message under the thing that caused it and say what to fix
- Fixed discovered files reordering themselves: the list keeps one stable order, turning a file on changes that row only, the drawer names the file it belongs to, and a file's type can no longer be flipped to something it isn't
- Improved leftover store files: grouped by section, named by what they belonged to, collapsed by default, with an amber filter pill while any exist and a confirm before deleting
- Removed the Username field from the remote form; a linked token is enough, self-hosted included. Browse sits inside the path box and the token's explanation lives in a tooltip
- Removed the remotes group's header and its own refresh button from the sidebar; the panel's one refresh re-checks the remotes too
- Improved search: `section:` also finds folders and custom rules, and a remote whose store carries no lock is refused with a message that says so instead of failing later

## 2.22.0

- Changed the settings and the store to a new format. Update every device before any of them captures or pushes: a device on 2.21.0 declines the new format and changes nothing, but one on 2.20.0 or earlier resets its setup to defaults. See [UPGRADING.md](UPGRADING.md)
- Changed `scope:` to `section:` in both search boxes, with no alias, because the old word named three different things: the settings area in one box, the item category in the other, and which devices share a value in the stored file. `scope:community` now finds nothing; `section:community` is what you want. The settings box keeps its own `general`, `advanced` and `remotes`
- Changed where an item runs and where it is forced on or off into two separate choices. One consequence: *Runs on → Computers only* (or *Phones only*) now also decides whether that item takes part in Capture and Apply, where before the menu was the only thing that read it
- Changed sharing to say what it means: shared everywhere, kept per device class, or never leaving this device. A whole-file rule can no longer be set to *This device*, which never worked
- Changed a community plugin's card to disappear after the migration if you had switched the card off and the plugin is not installed on this device. Its settings and rules are untouched; installing it here brings the card back
- Fixed the startup name-repair rewriting a store it did not write, which produced a file older devices could neither refuse nor read. A display name on an old-format store now stays stale until the next capture or pull

## 2.21.0

- Fixed an item you had sat out on one device coming back: *Stop syncing → On this device* was stored in the shared settings under an identity that never leaves the machine it belongs to, so the first arriving settings from another device erased the choice. It now lives on the device that made it. A choice made before this release may already be gone; set it again and it stays. See [UPGRADING.md](UPGRADING.md)
- Changed *Stop syncing → On this device* to live on the device rather than in synced settings, so it is not part of a backup and a reinstalled or replaced device needs it set again
- Fixed an older device stripping a newer one's bookkeeping: the store's record of what was captured, and when, was rebuilt from a fixed field list on every read, so an older version silently dropped anything newer and published the loss. It is carried through untouched now
- Fixed a *Runs-on* choice written by a newer version being deleted on sight and the deletion shared with every device. An unrecognised rule is ignored where it is used and left exactly as found
- Fixed a device without BRAT emptying the shared beta list for the devices that have it
- Added refusal instead of reset for settings from a newer version: a device says so plainly, changes nothing, and declines every action that would write. The same holds for a store written by a newer version, where Capture, Apply, Pull and Push all decline. The check runs before anything is written
- Changed "the store has newer settings" to answer by content: each item records its own capture time and a fingerprint of what was stored, so the prompt reflects what actually differs rather than which clock ran last
- Changed a setting added inside a nested option to fall back to its default when an older document is loaded, instead of arriving empty

## 2.20.0

- Added **Stop syncing** in two forms: *On this device* takes effect immediately and is undone from the same menu, *Everywhere* asks first and can clean up the stored copy. An item sat out on this device reads **Not synced on this device**, drops out of every count and the select-all, and is skipped by both Apply and Capture, while other devices keep syncing it
- Added a fold for items excluded by your own rules, `1 item not synced on this device`, with a matching **Not synced here** filter, so "in sync" counts only what is genuinely in sync
- Improved the list's structure: section bodies sit on their own filled surface with the header above them, an expanded item's detail panel steps down to an outline, and a section's summary lines use the same leading chevron and evenly weighted icons as everything else. A section holding nothing but summary lines no longer shows an empty block
- Improved the sidebar filter, which rebuilt the entire panel on every keystroke and lagged behind fast typing. It settles once you pause, over a fraction of the work

## 2.19.0

- [Mobile] Changed the Sync Center so an item's first line carries only its name, what a run would do, and the checkbox. Badges move to an indented line beneath; items without badges stay on one line; a badge line too tight for text shrinks to bare icons that read on tap
- [Mobile] Changed section headers back to one line: full title, a compact `5/73` count, the select-all checkbox, and the on/off-list sync control as a small toggle icon, green when the list syncs and grey when it does not. Press and hold reads its state
- [Mobile] Changed the expanded card to stack, rendering each label above a full-width value instead of folding long values into narrow columns
- [Mobile] Fixed `Use theirs ↓` / `Keep mine ↑` clipping: they split the card's full width with comfortable touch targets

## 2.18.0

- Added an icon to every fact badge: `not installed here`, `desktop only`, `stays off`, `encrypted`, the your-rule family and `your choice` each render a themed icon beside their text
- Changed how narrow panes degrade: an item's name is never truncated, badges never wrap or clip but shrink together to icon-only form with the full text a hover or tap away, and only the action sentence gives way, shortening to its direction arrow because the expanded card repeats it in full
- [Mobile] Changed section headers to keep their full title on one line with the on/off-sync badge beneath, counts compacting to `2/73`, and removed the per-section "N selected" note, which the checkbox state and the footer already say
- Changed a plugin whose settings are in sync but whose installed version is ahead of the store to read `Records version X`, with the card explaining that capture records the newer version so other devices can update
- Fixed the row-end checkbox being pushed out of its column in a narrow desktop pane
- [Mobile] Fixed section headers wrapping onto two broken lines
- Changed the encrypted badge to a themed lock icon everywhere, retiring the last emoji in the panel

## 2.17.0

- Changed the main list, the remote panes and the run reports to one grammar: one item, one row, one sentence saying what Apply or Capture would do, such as `Installs from the community catalog · turns on · applies settings` or `Records version 2.2.3`. Counts, filters and the footer all derive from that sentence, so they cannot disagree
- Changed a plugin's companion files and folders to fold into the plugin's own row, and grouped the list into four sections: Obsidian, Core plugins, Community plugins including beta installs, and your custom folders, each with its own select-all and count
- Changed rows to state their consequence rather than their state: direction glyphs pair with a verb sentence and chips carry the facts. An item with nothing anywhere reads `No settings yet` and folds away; one your Settings-sync rule excludes says `Not synced on this device` instead of masquerading as in sync
- Added in-place conflict resolution: an item changed on both sides offers `Use theirs ↓` / `Keep mine ↑` on its card, replacing a global direction choice
- Changed remote panes to render the same rows and folded companions, and to summarize on/off differences per plugin by display name. Expanded folds survive refreshes
- Changed run reports to separate failure from notes: only real failures show `✗ Applied with N issues`, and a successful run with remarks reads `Applied · N notes` in amber. A version that fell forward during install is a note, not a failure
- Changed a brand-new device's pane to say there is no store yet and point at Pull, with an Open-remote shortcut, instead of offering to adopt a configuration that is not there. Adopt imports the store's full self-configuration, including which plugins are beta installs
- Added display names to the store, healing older stores automatically, so remote panes and on/off summaries show real names instead of plugin ids
- Fixed partial on/off staging writing more than you selected: checking some of a section's rows applies or captures only those plugins, and force-on/off choices scope to the staged set
- Removed controls that did nothing: the whole-file scope menu on per-key-rule items whose choice was silently discarded, and the dead select-all on empty sections
- Fixed capture rewriting every encrypted field on every run. Unchanged envelopes keep their bytes, and diff previews stop flagging unchanged encrypted values as changes
- Improved full-list rendering to about three times faster, and stopped expanding or collapsing a section from repainting the whole panel

## 2.16.0

- Fixed a fresh device offering to delete your other devices' core-plugin settings. The store's copies of core plugins not turned on here piled up under **Leftover in the store** labelled "Safe to delete", pointed at settings other devices were using. They are ordinary **To apply** rows under Core plugins now, and Leftover means only files for items you stopped syncing
- Changed a disabled core plugin into a real item: its store settings attach to its card even while the plugin is off here, Apply writes them and can enable the plugin, and Capture with no local file reports "nothing to capture yet" and leaves the store alone
- Changed a two-way on/off split to read as one list: two summary lines with Apply first, a one-line caution, and a single per-plugin rule list grouped by direction, replacing the red diverge box and the "Keep extras on this device" pop-up
- Changed one-sided lists to carry no direction labels on their rows, since the summary line above says it once
- Changed the layout so the summary and rule list render above the scoped-to-specific-devices section, and removed the item header's duplicate device-scoped note

## 2.15.0

- Changed the plugins on/off view to lead with one line stating what Apply will turn on, instead of a separate row per plugin repeating the same sentence. The full per-plugin list is a collapsible **Set a per-plugin rule** with a search box for long lists
- Changed where a plugin runs to use the same click-to-cycle icon as the settings cards, all devices to desktop to mobile to this device, replacing the pop-up menu. Desktop-only plugins skip the mobile stop
- Added a short list of already-scoped plugins, each editable in place

## 2.14.2

- Fixed a device-only value already sitting in the store with nothing else to capture never being offered for cleanup, because the setting read as in sync. It surfaces as **to capture** on its own now, and one capture removes the leftover value. After updating, capture the affected setting once on the device that owns it

## 2.14.1

- Fixed a value that reached the store before its setting became device-only staying stranded there, where another vault could read it. The next capture of that setting rewrites the store without the device-local value

## 2.14.0

- Fixed a Pull erasing a plugin pinned to *this device*. The choice is stored as a device-local fact now, so it no longer shows as a permanent pending difference
- Fixed device-only settings leaking to other vaults, including a vault sitting mid-chain and relaying onward. The store's own rules decide what stays on-device, so a machine that has not taken on the shared setup cannot publish its own device-specific values downstream
- Fixed choosing Desktop only, then This device, then Everywhere silently keeping the earlier Desktop-only scope

## 2.13.3

- Fixed the "remote has newer version info" banner surviving a Pull. When a remote's contents already match your store, Pull brings your records fully in line with it, so the banner resolves instead of returning on every re-check
- Improved the compare feedback: a spinner, a running timer and what it is actually doing, fetching then comparing, instead of one frozen `Comparing…` line
- Fixed a comparison fetching the remote twice. Opening a remote reuses the check it just made rather than pulling the whole store down again
- Changed the top-right refresh to re-check every remote too, showing `Checking N remotes… M done` while each settles

## 2.13.2

- Fixed comparing or pulling a git remote doing that work inside your vault's own git repository, which could wedge the next comparison with "couldn't reach this remote" and quietly change how your repository was wired. The comparison runs in an isolated, disposable workspace now and removes it when done. A vault an earlier build already marked needs a one-time cleanup; see [UPGRADING.md](UPGRADING.md)

## 2.13.1

- Fixed Compare, Pull and Push downloading the whole repository to reach a store folder inside it, which never finished within the one-minute limit on a repository of any real size. They use a shallow, blobless partial clone that brings down only the store folder's data; on a host without partial clone, git falls back to a shallow transfer on its own
- Changed the remote form to mark Name, URL, branch and store path with a red `*`, and dropped the "(optional)" tag from the rest
- Fixed the access-token control and the Username field sitting at different heights, and stopped the row crowding the URL above it

## 2.13.0

- Added a per-remote access token linked from Obsidian's keychain. Compare, Test connection, Pull and Push authenticate with it and bypass the machine's credential helpers entirely, so nothing can pop a window or stall. Leaving it unlinked keeps the previous behaviour
- Added an optional Username for hosts that validate it, such as a self-hosted GitLab that rejects the conventional `token`. Empty keeps sending `token`
- Added a line under the token field naming which of three states this device is in: token linked, a token named but not present here, or none at all
- Changed a remote whose token this device never linked to fail with exactly that, and to name the fix, instead of "Couldn't reach this remote" over an empty Git-output expander
- Changed every git subprocess to refuse interactive credential prompts at the helper level as well as at git's, so a remote that cannot authenticate fails in a fraction of a second
- Changed the minimum Obsidian version to 1.11.4, which is where the keychain API this rests on arrives. Installs older than that stay on 2.12.1

## 2.12.1

- Fixed authenticated https remotes failing with "could not read Username … terminal prompts disabled" even where the same URL worked in a terminal. Obsidian launched from the Dock runs on a minimal PATH, so a credential helper installed by Homebrew or under `/usr/local/bin` was invisible to the git subprocess. That subprocess now appends `/usr/local/bin` and `/opt/homebrew/bin` to its PATH on macOS and Linux

## 2.12.0

- Fixed a git remote sitting on `comparing…` forever when a fetch stalled on a credential prompt nobody can answer, or on a host that never replies. Every git call runs with credential prompts disabled and a 60-second timeout, so a compare always ends in a result or an error
- Changed compare failures into a card: one sentence about what happened, a login was needed, the remote timed out, or it could not be reached, with the raw git output one click away. Folder-vault remotes get the same card without the git framing
- Fixed the three git fields in the Remotes tab losing their shared baseline when the long third label wrapped to two lines
- Changed the tab bar to collapse to icons on desktop as well, with the active tab showing its label and the rest revealing theirs on hover, because Obsidian 1.13 opens Settings in its own narrower window

## 2.11.0

- Added the [user guide](docs/GUIDE.md), holding every behaviour in one place: the Sync Center tour, the availability sections and the install engine's rules, the settings cards and their drawer zones, field rules and sensitive settings, transport, and all four walkthroughs
- Changed the README into a landing page: one-sentence features linking into the guide, a short "How it works", and the security and privacy disclosure kept intact
- Changed the legacy-settings migration error to point at the sensitive-settings guide instead of a README section that no longer exists

## 2.10.1

- Fixed the "remote has newer version info" hint that no amount of pulling could clear. Version info for store content outside this vault's sync list could never take up residence locally: Pull only adopted entries it could attribute to a local item, and Capture rebuilt the record from the local list alone. Pull attributes against both sides' lists now, and Capture carries foreign entries forward
- Fixed a remote comparison resolving the other vault's sync list only from its legacy format, so vaults on the current format looked list-less and their files showed under *(other store files)*
- Fixed the matched list naming Config Sync while *Keep Config Sync's own settings out of this remote* was on. An excluded item is neither changed nor matched, and the standing note remains the one place that says where it went

## 2.10.0

- Added **Keep Config Sync's own settings out of this remote**, a per-remote toggle for vaults that keep their own setup. Pull and Push skip Config Sync's settings in both directions, Push's mirror pass leaves the remote's copy untouched, and the comparison stops reporting them. The pane carries a standing note while it is on, and the pull-conflict dialog points at the setting whenever Config Sync's own file is the conflict
- Added expandable remote diff rows: every row opens to added, changed and only-in-your-store files, each with an inline diff. A file that exists on one side only diffs against an empty *not at {remote}* or *not in your store* side, and rows use the same two-tone names as the device list
- Fixed the direction summary promising changes Pull would never make. The pane separates what the aligned action carries from what it deliberately will not do, giving files that exist only in your store their own muted line

## 2.9.0

- Added an update-available advisory for Config Sync itself. When this device runs an older Config Sync than the version the store's settings were captured on, the header chip, the sidebar entry and the pane pill turn orange, and the Config Sync pane names both versions with an **Open Community plugins** shortcut. It is guidance rather than an action, since Config Sync cannot update itself mid-run
- Fixed the Outdated / Disabled / Not installed section heads counting content drift rather than their own rows, which made "Outdated on this device" read `0` beside a green `✓ 1`. They count their rows now, and the misleading in-sync pill is gone

## 2.8.0

- Fixed the result strip's `✗` and `⚠` counters rendering with no colour at all
- Fixed a settings hint pointing at a panel that no longer exists, rather than at the Appearance card's companion folders where snippet device rules live
- Changed the command palette entry to **Open Sync Center**, and gave the ribbon icon a tooltip saying what it opens
- Improved copy across settings and the Sync Center: consistent terms, device-and-consequence phrasing instead of internals, proper plurals, sentence case
- Changed icons and glyphs: the compact switcher uses the real settings icon, Stop syncing uses a standard icon, the conflict dialog's collapse arrows match the rest of the app, and close buttons are real icons
- Changed colour semantics: the encryption lock carries the encryption colour, and destructive text actions read red

## 2.7.2

- [Mobile] Fixed a section header overflowing when items are selected: the `✓ 1` pill folded into a tall circle and the `N selected` note broke across two lines. Pills and note hold their shape now, and only the section title wraps when the row runs out of room

## 2.7.1

- Fixed the `file deleted` tag on an orphaned snippet row being squeezed into the narrow icon column and wrapping, with **Forget** dropping onto its own line

## 2.7.0

- Added the owning card's name to items that live under one, so a companion folder reads `Appearance › CSS snippets` with the card name dimmed. The list sorts them under their card and searching the card's name finds them. Nothing changes in what is stored or synced
- Added a row for a snippet file you deleted while it still carries a device choice: struck name, a `file deleted` tag, and a **Forget** button that clears the choice so the next capture removes the snippet everywhere. A file merely mid-sync keeps its choice
- Fixed the member count beside the snippets folder counting more than real files

## 2.6.1

- Fixed "This device decides for itself" rendering as a small text glyph in the where-it-runs menu instead of the This-device icon its neighbours use, at their size

## 2.6.0

- Changed the Community and Core plugin rows to say what they are, **Community plugins on/off**, **Core plugins on/off** and **CSS snippets on/off**, instead of carrying raw internal names as titles
- Changed the remaining internal vocabulary out of the UI: tooltips say "Where it syncs", the settings toggle is **Per-item device rules**, the conflict view says **Rule**, and the Advanced tab's dropdowns show **File/Folder** and **All devices/Desktop only/Mobile only**
- Improved error messages to keep their detail and say what to do next: a failed pull or push names the remote's URL or path, and an invalid rule points at Settings → Advanced
- Changed the confirmation for changing a preset folder to state the consequence: the old folder stops syncing, the new path syncs as its own item
- Removed **Mobile only** from the where-it-runs menu for plugins that only run on desktop. The menu reads the installed plugin's own manifest, so a rule that could never take effect is not offered
- Changed the Config Sync pane's state marker to a real icon matching the rest of the panel, and routed the last stray emoji through the icon system

## 2.5.0

- Added plain-language explanations to the Community and Core plugin rows when a plugin is switched on on one side only, in place of a raw diff line
- Added a **where it runs** menu on the spot, offering *Desktop only*, *Mobile only*, *this device decides for itself*, or everywhere, with the choice matching where the plugin is actually used listed first. These are the same **Enabled on** rules as the settings card and work for plugins not installed here
- Improved the settings picker, which repeated "Plugin files, settings and on/off state." on a hundred rows. One line per section says it once, rows are single-line, and only deviations speak up
- Fixed the adopt card listing ghost members: items already in this device's sync list whose plugin is not installed here reappeared as "Updates from the store" forever. Membership is computed the same way on both sides now
- [Mobile] Fixed the cold-start banner squeezing its text into a narrow column

## 2.4.0

- Changed sync direction to come from what your device actually synced rather than file timestamps. Each device keeps a private baseline of an item's content as of the last time it saw that item in sync, and a differing item is compared three ways against it, so `↑` means this device changed it, `↓` means the store did, and `≠` means both did since this device last synced
- Fixed the failure modes the old file-time heuristic carried: a fresh install screaming "everything to capture", and capturing one item flipping every other pending item to "store is newer"
- Added the state **not synced on this device yet** for a differing item with no baseline here. It defaults to apply, counts into the apply bucket, and is not pre-checked
- Added a dismissible cold-start banner on a device that has not adopted the plugin's own settings yet, since those settings carry the rules that make the diffs trustworthy. It disappears once settings are adopted
- Improved JSON diff previews to normalise key order when both sides parse, and to say plainly when a difference is only ordering or formatting
- Changed the `community-plugins` and `core-plugins` on/off lists to appear under their Community and Core categories instead of Custom

## 2.3.4

- Fixed the status bar showing a permanent `↓2` on a device the Sync Center called in sync. The bar counted the raw state of items living in the *Not installed*, *Desktop-only*, *Disabled on this device* and *Outdated* sections; it counts through the centre's lens now, main-section rows only

## 2.3.3

- Fixed the status bar sticking to a stale snapshot, so it caught up only on the next periodic check or after a run. Every Sync Center recompute updates that snapshot now, including the version-drift presentation

## 2.3.2

- Fixed both halves of the on/off-list mask silently requiring the plugin's files to exist on the comparing device. An **Enabled on** scope adopted from the store was dead config on a device without the plugin installed, and a desktop-only flag in `store.lock.json` never reached such a device, so both kinds of plugin reappeared in every diff. Scopes come from the item config and flags from the lock entries now, while an installed plugin's manifest still wins

## 2.3.1

- Fixed the Config Sync pane listing the entire sync list under "Local changes not yet in the store" while the `data.json` diff below it showed zero changes. The parser for the store's own copy still read the schema-v1 `groups` array, so any store captured by a 2.x version parsed as an empty list and every local group looked new
- Fixed leftover detection losing its protection for the same reason, which let store data pulled from another device but not yet adopted here show up in the cleanup list. Restored, including for plugins not installed on this device

## 2.3.0

- Changed the **Enabled on** tooltip on a desktop-only plugin to read "All devices, mobile is excluded automatically", since "all" was never going to touch mobile for these plugins
- Changed **Stop syncing** to render as the drawer's last row, a muted text link under a divider that turns red only under the pointer, instead of a bright pill under the file row where it was an easy mis-tap. Mobile gets a larger gap and tap target

## 2.2.0

- Added a neutral **desktop-only plugin** chip to every community or beta plugin whose manifest says it cannot run on mobile, ahead of the config badges, so the innate property is never confused with your own `on: desktop` choice
- Changed the **Enabled on** cycle to skip the meaningless mobile stop for those plugins, running all devices to desktop to this device. A stale `mobile` value stored earlier is not rewritten
- Fixed hovering a scope or lock icon stacking Obsidian's tooltip on top of the browser's native one
- Changed both search boxes to open the qualifier dropdown on focus, so an empty box lists every available `key:` and typing prefix-filters it

## 2.1.0

- Changed where the encryption passphrase is stored on Obsidian 1.12 and later, to Obsidian's keychain rather than plain app storage. An existing plaintext passphrase migrates on first load and the plaintext copy is removed. Older installs keep the previous behaviour, and the passphrase description says which storage this device uses
- Removed **Revert last apply**, its command, ribbon option and menu entry, along with the one-slot backup Apply used to write. What each run changed stays visible in the pinned result strip and **History**, and a leftover `config-sync-backup` folder is cleaned up on the next Apply
- Fixed changing a scope re-rendering the whole card, which lost the settings panel's scroll position. Cycling a snippet's scope, clicking a key in **File preview** and removing the last rule all update in place
- Fixed **File preview** losing its scroll position when you click a key deep in a long file, and removing a card's last rule leaving the whole-file controls disabled
- Changed the preview legend to show real colour dots for desktop only, mobile only and this device, and replaced its lock emoji with the panel's lock icon
- Fixed Escape while editing a companion folder's path closing the settings window instead of cancelling the edit
- Fixed rapid scope changes racing the card body's file reads into showing stale content

## 2.0.0

- Changed both the settings schema and the store format, with no migration from 1.x. Upgrade every device together, then re-configure which items sync; your notes and the plugins' own config files are untouched. A 1.x device cannot read a 2.0 store or the reverse. See [UPGRADING.md](UPGRADING.md)
- Changed every picker tab to one card model: name, badges, a sync toggle, and a drawer with up to three zones for Enabled on, Settings file and Companion folders
- Changed App settings into one card for the whole `app.json`, retiring the hand-mapped Editor / Files and links / Other split that drifted permanently from Obsidian's real tabs
- Added a **Sync all** master toggle per plugin tab, and changed enable/disable toggles to update the panel in place
- Added per-key rules: expand **File preview** and click any key to give it its own device scope or encryption, with sensitive-looking keys highlighted before you enable syncing. A string-array key can scope each element individually
- Added whole-file encryption alongside the per-key rules, and derived mode from the rules themselves, so there is no Plain/Fields switch to manage. Removing the last rule returns the card to whole-file mode
- Added companion folders on every card, where opening `snippets/` lists each file with its own scope: the file always syncs, the scope decides where it is turned on
- Changed every scope control to one cycling icon whose glyph is the state, advancing on click, with defaults dimmed and narrowed scopes in the accent colour
- Removed the edit and reset buttons from path rows; the path text itself is the edit entry point, with Enter committing, Escape cancelling just the edit, and **Reset to default** inside the edit row
- Changed panel copy to the product's perspective, with no file names or internals in descriptions
- Fixed turning encryption off after turning it on, community plugin ordering, per-item rows wrapping onto two lines, and stacked dim opacity on locked rows

Releases before 2.0.0 are on [GitHub](https://github.com/xooooooooox/obsidian-config-sync/releases).
