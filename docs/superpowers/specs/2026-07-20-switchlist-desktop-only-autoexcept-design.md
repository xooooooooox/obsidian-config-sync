# Auto-except desktop-only plugins from the enabled-plugins switch-list

## Problem (a real footgun)

`community-plugins.json` is a **switch list** — the array of *enabled* community
plugin ids. On a phone, Obsidian never enables a desktop-only plugin, so it is
absent from the phone's list; the store (captured on desktop) has it. config-sync
therefore reads this as "the phone dropped it" and:

- **Capturing on the phone removes the desktop-only plugin from the store's list**
  → the next desktop apply *disables it on desktop*.
- The phone shows "Enabled community plugins ↑1 to-capture" with the desktop-only
  ids struck through (real-vault repro: `DEVONlink-obsidian`, `better-export-pdf`).

The existing escape hatch is the per-list **switch exceptions** (`switchExceptions`,
device-local, edited in Settings): an excepted id is preserved on capture and not
force-applied. But requiring the user to hand-exclude every desktop-only plugin is
tedious and redundant — config-sync already knows which plugins are desktop-only
(the `desktopOnly` flags in the store lock, from 1.1.3).

## Design — treat desktop-only ids as automatic switch exceptions

config-sync derives the desktop-only plugin ids and folds them into the switch
exceptions **used at runtime**, identically to a manual exclude. The persisted
`settings.switchExceptions` is left untouched, so the Settings UI keeps showing
only the user's own excludes.

### 1. Derive the ids (pure, lock-based)

New function in `src/core/availability.ts` (next to `desktopOnlyDrift`):

```ts
// Plugin ids the store records as desktop-only (from the lock's per-group flags).
// The lock is the source that also works on a phone, where the plugin isn't installed
// and its manifest can't be read.
export function desktopOnlyPluginIds(lock: StoreLock | null): Set<string> {
  const ids = new Set<string>();
  if (lock === null) return ids;
  for (const [name, entry] of Object.entries(lock.groups)) {
    if (entry.desktopOnly === true && name.startsWith("plugin-")) ids.add(name.slice("plugin-".length));
  }
  return ids;
}
```

Lock-based only: it works on the phone (reads the synced lock) and on desktop
(the flags are backfilled). The manifest source (`plugins.isDesktopOnly`) is not
needed — the footgun is a phone-capture problem, and the lock is authoritative
there. (Known blind spot, unchanged from before: a desktop-only plugin that is
neither in the sync list nor installed on this device can't be detected and still
needs a manual exclude — rare, since synced plugins have a group.)

### 2. Fold them into the runtime exceptions (single point)

In `src/main.ts` `coreContext()`, load the lock, compute the ids, and build an
augmented `switchExceptions` for the community-plugins list:

```ts
// after rootPath is resolved, before the return:
const io = this.configIO();
let lock: StoreLock | null = null;
const lockPath = `${rootPath}/store.lock.json`;
if (await io.exists(lockPath)) {
  try { lock = parseStoreLock(await io.read(lockPath)); } catch { lock = null; }
}
const dtoIds = desktopOnlyPluginIds(lock);
const switchExceptions =
  dtoIds.size === 0
    ? this.settings.switchExceptions
    : { ...this.settings.switchExceptions, "community-plugins": [...new Set([...(this.settings.switchExceptions["community-plugins"] ?? []), ...dtoIds])] };
```

and return `switchExceptions` (this augmented map) instead of
`this.settings.switchExceptions`.

Because `excFor` (`ConfigSyncCore.ts`) and `status.ts` both read
`ctx.switchExceptions`, they now receive the augmented set with **no change** —
capture preserves the ids (`fromStore` keeps excepted ids), apply doesn't force
them (`storeSynced` drops excepted ids), and status compares the list as a set
ignoring them (so the phantom `↑1` disappears).

### 3. Align `diffPair`

`diffPair` (`src/main.ts`) resolves its exceptions from `this.settings.switchExceptions`
directly, so it must use the same augmentation or the inline diff would still show
the desktop-only ids as removed. Extract the augmentation into a private
`private async augmentedSwitchExceptions(): Promise<Record<string, string[]>>`
used by both `coreContext()` and `diffPair` (DRY — one lock read per call site,
no duplicated logic).

## Data flow

Phone: lock (synced, carries `desktopOnly` flags) → `desktopOnlyPluginIds` →
folded into `ctx.switchExceptions["community-plugins"]` → capture keeps the
desktop-only ids, apply skips them, status shows no `↑`. Desktop: the ids are
enabled and already in the store, so excepting them changes nothing (capture
result identical) — desktop is unaffected.

## Testing

- **`tests/availability.test.ts`** — `desktopOnlyPluginIds`: a lock with
  `plugin-a.desktopOnly=true`, `plugin-b` (no flag), `hotkeys.sourceAppVersion`
  (app-anchored) → returns `{"a"}`; null lock → empty set; non-`plugin-` prefixed
  desktop-only entries ignored.
- The capture/apply/status behavior for an excepted id is already covered by the
  existing switch-list tests (`tests/switchList.test.ts` / core) — this change only
  feeds the id in as an exception, which those tests already exercise. No new
  behavior in the switch-list functions themselves.
- **Live (dev vault, mobile-forced or real phone):** with a desktop-only plugin
  enabled in the store's `community-plugins` list but absent locally, confirm the
  "Enabled community plugins" item no longer shows `↑ to-capture` and its diff no
  longer marks the desktop-only id as removed.

## Non-goals

- No change to the switch-list merge functions, to `settings.switchExceptions`
  persistence, or to the Settings UI (manual excludes still shown/editable there).
- No manifest-based id source (lock is sufficient and phone-reliable); deferred.
- Unrelated: the diff "collapse unchanged" view (separate spec).
