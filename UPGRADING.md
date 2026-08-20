# Upgrading

Versions that ask something of you. Everything else upgrades in place: install the new
version on each device whenever you get to it, in any order. What changed in every release
is in [CHANGELOG.md](CHANGELOG.md).

Read from the version you are on upward, and do the oldest step first.

## 2.25.0

**Nothing to do.** This release changes the format of the plugin's own settings again, and the
conversion happens on its own: the first time each device runs this version it converts its own
settings in place on load, and everything you had set comes across. If you had ticked **Keep Config
Sync's own settings out of this remote** on a remote, that remote keeps behaving exactly as it did
and the toggle is still ticked where you left it.

The one thing worth knowing is the same as it was for 2.23.0, and for the same reason: **a device
still on an older version cannot read the new format.** From 2.21.0 onward it refuses it, says so
plainly, and changes nothing at all — so an un-updated device waits rather than losing anything.
Update it whenever you get to it, in any order, and it carries on where it left off.

## 2.24.1

**Check the direction of any item you had switched to Don't sync it.**

Before this release, turning **Don't sync it** on and then off again deleted that item's sync
baseline. The baseline is this device's record of when it last agreed with the store, and
2.24.1 does not invent a replacement: a baseline is a record of what happened, and guessing
one would report a guess as knowledge.

Those items settle themselves. Where the two sides match, the next comparison reseeds the
record. Where they genuinely differ, the item reads **No settings yet**, which is the honest
answer once the record is gone. Look at the direction before applying such an item.

## 2.23.0

**Update Config Sync on every device before any of them captures or pulls again.** This
release changes the format of the plugin's own settings, and the change is one way: once a
device has written the new format, there is no going back to the old one.

- A device on **2.21.0 or 2.22.0** that meets the new format refuses it, says so plainly, and
  changes nothing. Update it and it carries on where it left off.
- A device on **2.20.0 or earlier** has no such check. It **resets its Config Sync settings to
  defaults**: every rule, every custom rule, every card you had ticked. Nothing recovers that
  afterwards, which is why the order matters. Update the device before it ever sees the new
  format.

The conversion itself asks nothing of you. The first device to run this version converts its
own settings in place on load: your rules, your custom rules, your Beta list and this device's
sync baselines all come across, and no item flips to "never synced". Take your usual vault
backup first anyway, since the conversion cannot be undone.

### What behaves differently afterwards

Deliberate changes, each of which you may notice.

- **A plugin nobody ever set a rule for now follows the shared on/off list, once that list
  itself is synced.** Before this version, an item with no rule at all had nothing forcing it
  to reconcile with your other devices, so the same plugin could quietly end up on here and off
  there with nothing to notice or fix it. Enablement is one of two answers now, always: the
  shared list, or `Not shared`. So **the first sync after upgrading may turn some plugins on or
  off**, converging whatever differences had silently built up between your devices before now.
  If you kept a plugin deliberately off on one device only, say so before you sync; its card's
  **Enabled on** row is where that choice lives. After that first sync this stops being a
  surprise: **Enabled on**, wherever you see it, is the actual, current answer, the same on
  every device, all the time.
- **Every card earns its place now, with no exception.** A community plugin your other devices
  sync but that isn't installed here always gets a card, the moment it carries anything of its
  own on this device: switched on, switched off, a rule, a companion folder. Installing the
  plugin here always brings its card's settings with it.
- **A display name in a store written by an older version stays stale until the next capture or
  pull.** Config Sync never writes to a store in the old format; a cosmetic fix is not worth
  rewriting a file your other devices may still be reading. The first capture or pull brings
  both the format and the names up to date.

## 2.22.0

**Update every device before any of them captures or pushes.** Your settings and your store
move to a new format. A device still on 2.21.0 meets the new format, declines politely and tells
you to update, and nothing is damaged. A device on **2.20.0 or earlier resets its setup to
defaults**.

Nothing else is asked of you. Your settings migrate the first time this version opens them, and
your store is read as it is until a capture or a pull rewrites it.

### `scope:` is gone from both search boxes

Both search boxes used to accept a `scope:` qualifier, and it meant a different thing in each:
the settings area in one box, the item category in the other, and, in the file that stores your
choices, which devices share a value. It is `section:` in both now, and there is no alias.
Typing `scope:core` searches for those words as plain text instead of filtering, so a search
that stops working is telling you it changed. Retype it as `section:core`.

### One thing worth knowing

Choosing *Runs on → Computers only* (or *Phones only*) now also decides whether that item takes
part in Capture and Apply. Before, that choice was read by the menu and nothing else.

## 2.21.0

**If you used *Stop syncing → On this device* before this release, check it.** That choice was
stored in the shared settings under an identity that never leaves the machine it belongs to, so
the first time another device's settings arrived, the choice was erased and the item reappeared
in To apply. Setting it again is all it takes, and it stays this time.

**The choice now lives on the device, not in your synced settings.** It is therefore not part of
a backup, and a device you reinstall or replace starts with nothing opted out.

## 2.13.2

**Only if an earlier build already compared or pulled a git remote in this vault.** Those builds
did that work inside the vault's own git repository, which could leave it in a state where the
next comparison failed with "couldn't reach this remote". Install this version first, then run
these once per affected vault, per machine, replacing `<vault>` with the vault's folder:

```
git -C <vault> remote remove config-sync-import
rm -f <vault>/.git/FETCH_HEAD <vault>/.git/shallow
git -C <vault> gc --prune=now
git -C <vault> rev-parse --is-shallow-repository   # expect: false
```

Your vault's own history and working tree are untouched by this. It removes the leftover import
remote and clears the state that made comparisons fail.

## 2.0.0

**Upgrade every device at the same time, then re-configure which items sync.** Both the settings
schema and the store format changed here, with no migration from 1.x, so a 1.x device cannot read
a 2.0 store and the reverse is equally true. Your notes and the plugins' own config files are
untouched; only Config Sync's item selections need to be set up again.
