# Loose ends — design

Date: 2026-08-12 · Branch: `loose-ends` (BASE `2bb6783`, after 2.22.0) · Status: §1-§2
need a mockup and a ruling; §3-§5 are 定稿.

Five things this release family kept deferring. Each was deferred for a reason that no
longer holds: three were held back by 2.22.0's "rename the vocabulary, freeze the
behaviour" constraint, one by an eleventh-hour discovery, and one has been sitting under
three reviews' reasoning without anyone noticing it was dead.

## §1 Three host methods with no caller (NEEDS RULING + MOCKUP)

`clearMemberLocal`, `addSwitchExceptions` and `setMemberDevice` are declared on
`SyncCenterHost`, wired in `main.ts`, exercised by tests — and **called from nowhere in
`src/ui/`**. The card's own Runs-on menu goes through `setRunsOn`, which writes
`runsOn: { device: "all" }` rather than deleting the key.

Why it matters more than dead code usually does: **three separate reviews reasoned about
`clearMemberLocal` as a live user gesture**, including the final review that graded a
Critical by the sequence it made possible. Dead code does not merely sit there; it
underwrites arguments about severity and reachability.

## §2 The documented way back does not exist (NEEDS RULING + MOCKUP, with §1)

GUIDE tells the user that an item which lost its Settings card can be recovered by
clearing its Runs-on rule. There is no control that clears a rule — `setRunsOn` only ever
writes one. So for a plugin **not installed on this device** carrying a rule and nothing
else, the card is gone until the plugin is installed.

This is the last knot from 2.22.0's NEW-I1 loop: `itemEarnsDef` deliberately excludes the
rule-only shape so that a migrated orphan rule does not grow a card for a plugin you do
not have. The exclusion is right; what is missing is a way out of the shape.

Two candidate directions — **the mockup decides**:
- **(a) Give the Runs-on menu a way to say "no rule"**, which deletes the key and lets the
  entry fall back to the card it had. Keeps `itemEarnsDef` as is; adds one menu entry and
  gives §1's `clearMemberLocal` a real caller.
- **(b) Let a rule-only entry earn its card back** and accept the migrated-orphan cards
  that 2.22.0's loop was trying to avoid — simpler code, more cards for plugins you do not
  have.

Whichever wins, §1's other two methods are then either wired by the same design or
deleted; a method with no caller does not survive this release either way.

## §3 `type:folder` matches nothing in the settings panel (定稿)

`buildSearchIndex` hardcodes every item as `{ type: "file" }`, so the settings panel's
`type:folder` has always returned zero hits while its autocomplete offers it. Teach the
index the real type. Hit counts for `type:file` change accordingly — that is the point,
and it is why this waited for a release that is allowed to change search results.

## §4 `section:custom` works in one panel only (定稿)

The Sync Center has `section:custom`; the settings panel indexes custom rules and
discovered files under `advanced`, so the same word answers differently depending on which
box you are typing in — the exact defect 2.22.0 set out to remove, left in place because
fixing it moves a query from zero hits to N.

`section:custom` finds custom items in BOTH panels. `section:advanced` keeps meaning that
tab's non-item settings; a custom rule is therefore reachable by either word in the
settings panel, which is honest — it IS a custom item, and it DOES live in that tab.

## §5 A remote with content but no readable lock is refused (定稿)

Found by a controller mistyping a remote path: pointed one level too deep, a 2.21.0 device
found no `store.lock.json`, **treated a directory full of store content as a brand-new
remote, and pulled all 94 files** without a word. No lock ⇒ no version ⇒ no gate.

The version gate is only as strong as the lock being FOUND, and "there is nothing here
yet" is not the same statement as "I cannot see the bookkeeping". A remote that holds
store-shaped content but no readable lock is refused with a message naming what is
missing, the way a higher version already is. A genuinely empty remote — no lock, no
content — stays a first-push target, because that case is real and common.

Pre-existing at BASE, not a v3 defect; a mistyped path is a realistic way for a user to
reach it, and the outcome is silent and wholesale.

## §6 Frozen

No schema bump: `data.json` stays 3 and the store lock stays 3. §3 and §4 change what a
query returns; nothing else changes what syncs.

## §7 Tests & gates

- §3: an item that IS a folder answers `type:folder` and stops answering `type:file`.
- §4: `section:custom` finds a custom rule in both panels; `section:advanced` still finds
  the tab's own settings.
- §5: a directory with store content and no lock is refused by pull and push, with the
  local store untouched; an empty directory is still accepted as a first-push target.
- §1/§2: per the ruling.
- Suite green (1515 baseline), build clean, lint 0 errors / no new warnings (58).
- NO commits; no Claude attribution.

## §8 Verification

kickstart and llm only until the user says otherwise; main.vault is theirs and now runs
2.22.0. §5 is verified by reproducing the controller's original mistake: point a remote at
`<vault>/0-Extra/config-sync/store` instead of `<vault>/0-Extra/config-sync` and confirm
it is now refused rather than pulled.
