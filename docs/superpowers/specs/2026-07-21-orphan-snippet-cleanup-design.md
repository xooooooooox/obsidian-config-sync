# Orphan enabled-snippet cleanup (no-file names)

## Problem

`appearance.json → enabledCssSnippets` is Obsidian's list of enabled snippet
**names**; Obsidian appends a name when you enable a snippet but **never removes
it when the `.css` file is deleted or renamed**. So renamed/deleted snippets
leave "orphan" names — permanently enabled, pointing at nothing. Obsidian's own
Appearance UI hides them (it renders a toggle only for files that exist).

config-sync's snippet drawer computes its row universe as
`fromDir ∪ store ∪ local` (`main.ts:1129`, where `local` = `enabledCssSnippets`),
so it surfaces every orphan as a normal manageable row. In the owner's vault:
15 `.css` files but 18 enabled names → 4 orphans (`callouts`, `dashboard`,
`hideProperties`, `table` — bare names left after renaming to `IOTO-*`). They
read "on here · store has off" — enabled locally, no file, not shared. Besides
cluttering the list, a Capture would push these dead names into the store and
sync them to other devices.

Deleting an orphan from `enabledCssSnippets` is **harmless**: Obsidian can't load
a snippet whose file is gone, so the enabled name already does nothing — removing
it changes no rendering and no behavior on this device.

## Decision (定稿)

Detect orphans, drop them from the normal list, and offer a **manual, opt-in
prune** — never automatic (定稿 mockup `mockup-orphan-snippets.html` V2).

- **Orphan** = a name in `enabledCssSnippets` (local) that is **not** a `.css`
  file locally (`fromDir`) **and not** in the store's shared list. The
  "not in store" clause is what makes this safe: a legitimately-synced enabled
  snippet always carries its name in the store (that is how the enabled-state
  travels), so a fresh device mid-sync — enabled-list arrived, `snippets/`
  folder not yet — is **not** misclassified as orphan. Only locally-added,
  never-shared, fileless names qualify.
- The normal drawer list becomes `fromDir ∪ store` (orphans excluded) — so the
  list finally matches real snippets.
- Orphans collect in a **collapsed notice** at the bottom of the snippet drawer:
  `○ N enabled snippets have no file · Clean up ▸`, shown only when N > 0.
  Expanding reveals each orphan (dimmed, `no file` tag) with a `Remove` action
  plus a `Remove all N`.
- `Remove` deletes the name(s) from `enabledCssSnippets`. **Nothing is ever
  auto-deleted** — the transient-missing-file case is dodged entirely because you
  only prune names you recognize as dead.
- **Capture is left untouched.** Filtering orphans out of Capture would
  reintroduce the transient-file destruction risk (a fresh device could drop a
  not-yet-synced enabled name from the shared store). The prune action is the
  sync remedy: once removed from `appearance.json`, an orphan can't be captured.

## Architecture

### 1. Detection — pure helper (`src/core/availability.ts`, beside `scopedAwaySnippets`)

```ts
// Enabled snippet names with no local .css file and not in the shared store —
// dead leftovers (deleted/renamed snippets). "not in store" excludes a fresh
// device whose snippets/ dir hasn't synced yet (its names are in the store).
export function snippetOrphans(local: string[], fromDir: string[], store: string[]): string[] {
  const files = new Set(fromDir);
  const shared = new Set(store);
  return local.filter((n) => !files.has(n) && !shared.has(n)).sort();
}
```

### 2. List exclusion (`src/main.ts` `switchListRows`, `:1120-1136`)

The `enabled-css-snippets` branch already reads `fromDir`, `store`, `local`.
Change the universe from `fromDir ∪ store ∪ local` to **`fromDir ∪ store`**
(dropping `...local` drops exactly the orphans — any non-orphan local name is
already in `fromDir` or `store`). Rows returned are orphan-free; hints still read
`local` for on/off.

### 3. Host methods (`src/main.ts`, exposed on the `SettingTab` host interface)

- `snippetOrphans(): Promise<string[]>` — reads `fromDir` / `store` / `local`
  (the same inputs `switchListRows` uses; factor the read into a shared private
  helper to avoid duplicating the three reads) and returns
  `snippetOrphans(local, fromDir, store)`.
- `removeSnippetOrphans(names: string[]): Promise<void>` — removes the names
  from the enabled set in **both** places so Obsidian can't rewrite them back:
  1. On disk: read `appearance.json`, filter `enabledCssSnippets` (via
     `readLocalSwitchList` → filter → `writeLocalSwitchList`, preserving sibling
     fields), write it back.
  2. In memory: `this.app.customCss.enabledSnippets.delete(name)` for each (a
     `Set`), so a later Obsidian appearance-write serializes the cleaned set.

  (Guard both against a name that isn't actually an orphan — callers only pass
  names from `snippetOrphans()`.)

### 4. UI (`src/ui/SettingTab.ts` `renderLocalDecisions`, snippet drawer only)

After the row loop, when `isSnippetGroup` and `snippetOrphans()` is non-empty,
render the collapsed notice (V2). It uses a session-local expanded flag. Expanded:
each orphan row (name + `no file` tag + `Remove`) and a `Remove all N`. `Remove`
/ `Remove all` call `removeSnippetOrphans(...)` then `reload()` (which re-fetches
rows and re-renders, updating both the list and the notice count; the notice
disappears at 0). The host interface gains `snippetOrphans` + `removeSnippetOrphans`.

### 5. CSS (`styles.css`)

New rules for the notice (`config-sync-orphan-notice`) and orphan rows
(`config-sync-orphan-row`, `-orphan-tag`, `-orphan-remove`): dimmed/faint, a
low-key red for Remove (theme vars only — `rgba(var(--color-red-rgb), α)` /
`--text-faint` / `--text-muted`; no hardcoded color, release-gated).

## Testing

- **Unit (`tests/availability.test.ts`):** `snippetOrphans` —
  - `local` name with a matching `fromDir` file → not orphan.
  - `local` name present in `store` (no file) → not orphan (fresh-device case).
  - `local` name with no file and not in store → orphan.
  - empty `local` → `[]`; result sorted; no duplicates.
- **Live (dev vault, the real verification):** the vault has 4 real orphans
  (`callouts`/`dashboard`/`hideProperties`/`table`).
  - The normal list no longer shows them (row count == real snippets).
  - The notice reads "4 enabled snippets have no file"; expand shows all four.
  - `Remove` one → it leaves `appearance.json`'s `enabledCssSnippets` and the
    notice count drops to 3; `Remove all` → notice gone,
    `enabledCssSnippets` == the real file/store set. Confirm Obsidian's in-memory
    `app.customCss.enabledSnippets` no longer lists the removed names.
  - Desktop 390×844: the collapsed notice + expanded rows fit without overflow.
- **Gates:** `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (+ the new
  unit tests), `npx eslint .` **0 errors / 67 warnings**,
  `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- **No automatic pruning** — no scan/capture-time deletion (transient-file risk).
- **No change to Capture/Apply** of the snippet list, to `snippetScopes`,
  pins, or the Sync Center.
- **No pruning of names present in the store** — those are managed cross-device;
  only locally-added, unshared, fileless names are offered for removal.
- No handling of orphans in the plugin/core switch lists (this is snippet-only).
