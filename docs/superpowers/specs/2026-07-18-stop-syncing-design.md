# Remove an item + clean up the store (0.31.0)

Real-vault finding 2026-07-18: an uninstalled, no-settings plugin ("Editor Syntax
Highlight") lingered in "Not installed on this device" with nothing to sync. Diagnosis: the
`plugin-<id>` group persists in `settings.groups`; the not-installed section lists every
plugin-* group whose plugin isn't installed (`catalog.ts:318`). Removal is only possible via
the settings-tab toggle, and it never cleans the store's captured copy — leaving orphans
that are invisible except in a remote diff.

Three parts, mockup-approved (`remove-item-mockup.html`, `leftover-pill-mockup.html`):

## A. "Stop syncing" — remove an item from the Sync Center

The item's expanded detail gains a **Stop syncing** button on the same row as the state
action segment (Install & enable / Install …), pushed right, red, with a circle-slash icon.
Available on any tracked item (`group !== undefined`), not the self item.

Clicking opens a confirm modal:
- Title: `Stop syncing {label}?`
- Body: "Config Sync will forget this item on all your devices. Nothing installed is
  touched." (the tracked-item list is config-sync's own synced settings, so removal
  propagates.)
- When the store holds captured data for this group, a checkbox (default **checked**):
  `Also delete its settings saved in the store (N files)` — sub: "Recommended — otherwise
  they stay in the store, unused. You can re-add the item later either way."
- Buttons: Cancel / Stop syncing (warning-styled).

On confirm: `host.stopSyncing(groupName, deleteStore)` splices the group out of
`settings.groups`; if `deleteStore`, deletes the group's store files. Save + reload.

## B. "Leftover" filter pill — see & clean store orphans

Store files that belong to no current group (e.g. from an old settings-toggle removal, or
from unchecking A's box) are otherwise invisible locally.

- A **Leftover N** pill joins the All-items filter row, after "No settings yet", amber,
  **only in the All-items scope and only when N > 0**.
- Selecting it renders a leftover section (dashed amber frame, like the availability
  sections): a header "Settings Config Sync saved for items you no longer sync. Safe to
  delete." with a **Delete all** action, then one row per orphan — a derived **name**
  (`configdir/plugins/<id>/…` → `<id>`; other paths → the relative path), the **path**
  (monospace, small), the **size**, and a **Delete** action.
- Deleting removes the store file(s) (which then sync-delete out via the vault sync). The
  pill/section disappear when the last orphan is cleared.

## C. Enumeration (core, pure)

`listLeftoverStoreFiles(io, rootPath, groups)`: list files under `rootPath`, keep those
whose rel `startsWith("store/")` and where `groupForStoreRel(groups, rel).name === ""`
(unmatched) — excluding junk paths. Returns `{ rel, name, size }[]`, name derived from the
path. Store bookkeeping (`store.lock.json`, `config-sync.json`) sits outside `store/`, so it
is naturally excluded.

## Host interface additions

```ts
stopSyncing(groupName: string, deleteStore: boolean): Promise<void>;
storeFileCount(groupName: string): Promise<number>; // for the modal's "(N files)" and whether to show the checkbox
listLeftoverStoreFiles(): Promise<{ rel: string; name: string; size: number }[]>;
deleteLeftoverStoreFiles(rels: string[]): Promise<void>;
```

`stopSyncing` and `deleteLeftoverStoreFiles` operate on the local store directory
(`resolvedRootPath()`), then rely on the vault's own sync (remotely-save) to propagate
deletions — no store-lock rewrite needed (removing a group's files doesn't change other
groups' lock entries; the group is gone from the manifest).

## Semantics (product-facing)

- "Stop syncing" (not "stop tracking"): the user thinks "don't sync this anymore".
- "Leftover in the store" (not "orphan / untracked files"): "settings kept for items you no
  longer sync."
- Both confirm modals stress "affects all your devices" and "nothing installed is touched"
  to prevent the "did I uninstall the plugin?" misread.

## Styling

Follows DESIGN.md. Stop-syncing button: red text + `rgba(--color-red-rgb,0.4)` border,
circle-slash icon (drawn inline, 14px). Leftover pill: amber, reuses `.config-sync-fpill`
with an amber active state. Leftover section reuses the availability-section dashed frame
(amber). Delete actions: `--color-red`.

## Testing

- Core: `listLeftoverStoreFiles` finds unmatched store files, excludes tracked groups' files
  and bookkeeping; name derivation for plugin vs non-plugin paths.
- Host: `stopSyncing` removes the group; with `deleteStore` also removes its store files;
  without it leaves them (which then surface as leftover). `deleteLeftoverStoreFiles` removes
  the named files.
- View: leftover pill appears only in All-items scope with N>0; selecting it renders the
  section; Stop syncing modal shows the checkbox only when store data exists.
- Live dev-vault: stop syncing the no-settings not-installed item → gone, no leftover; add a
  synthetic orphan store file → Leftover pill shows it → Delete clears it; stop syncing an
  item with store data + delete → its store files are gone.
- Gates: npm test, lint 67-warning baseline, no hardcoded colors.

## Non-goals

Auto-pruning on capture (rejected earlier — it would silently mutate the shared manifest and
could drop a group another device still uses); a settings-tab mirror of the leftover cleaner
(the Sync Center is the home for store state).
