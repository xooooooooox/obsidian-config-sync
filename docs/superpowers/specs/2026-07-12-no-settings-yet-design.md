# "No settings yet" State & Remote-Diff De-noise (iter17)

Approved mockup: `.superpowers/brainstorm/9047-1783841141/content/nothing-to-sync.html` (wording option B chosen: filter pill "No settings yet"; the mockup's other copy stands as drawn, with one item-generic adjustment noted in the copy table).

## Problems

1. **Panel offers un-capturable items.** `not-captured` today means only "the store lacks it" — local existence is never checked (`compareFile` / `compareDir` return `not-captured` on store absence alone). An item with a file on NEITHER side lands in the ↑ bucket, shows under "To capture", and can be checked; capturing it can only produce the error `nothing to capture yet: <path> does not exist in this vault`. In a real vault this dominates: a user saw "To capture 16" where only 1 item was genuinely capturable.
2. **Remote deep-diff constant noise.** `store.lock.json` is rewritten on every capture, so the `""` store-metadata pseudo-entry appears as `store metadata ~1` in nearly every remote deep-diff. It carries no actionable information (store freshness is already shown by the row's `captured <age>` text).

## Design

### 1. New group state: `no-settings`

`GroupState` gains a sixth value, `no-settings`: **neither this device nor the store has any file for the item**. Detection in `src/core/status.ts`:

- `compareFile`: store file missing AND real file missing → `no-settings`.
- `compareDir`: store has no (non-junk) files AND the live dir has no (non-junk) files → `no-settings`.

`not-captured` (`—`) narrows to its honest meaning: **this device has files, the store doesn't** — Capture performs first-time storage.

The item flows automatically: once the plugin/item writes its file(s), the state flips `no-settings` → `not-captured` and enters the ↑ bucket.

### 2. Counting: fourth bucket

`BucketCounts` gains `none` (`no-settings` count). Buckets everywhere become: ↑ = `local-changed` + `not-captured`; ↓ = `store-newer` + `differs`; ✓ = `in-sync`; ○ = `no-settings`. Counting stays coherent: `All = up + down + ok + none` on every surface (title pills, section-head pills, filter pills).

- **Title pills**: a dim gray `○ {n}` pill, shown only when n > 0, after the ✓ pill.
- **Section-head pills**: same `○ {n}` gray pill, nonzero only.
- **Filter pills**: fifth pill `No settings yet {n}` (`PanelFilter` key `"none"`); selecting it shows only `no-settings` rows.
- **Ribbon dot / tooltip / menu counts**: unchanged code (they read `up`/`down`), which now automatically excludes `no-settings` — the dot no longer lights orange for items with nothing to capture.

### 3. Row treatment

- State icon `○` (gray, class `is-none`), aria-tip: `no settings yet — nothing on this device or in the store`.
- Item name renders dim (muted color, normal weight).
- Checkbox disabled (like `in-sync`); section select-all skips `no-settings` rows (checkable = state not `in-sync` and not `no-settings`).
- Expanded detail: italic note only, no mini buttons (neither action can do anything).
- In the `All` view, `no-settings` rows render as normal (dim) rows — they do NOT join the `✓ N items in sync` collapse line.
- Section default-collapse rule unchanged (`up === 0 && down === 0` → collapsed): a section holding only ✓/○ has nothing actionable and starts collapsed, its head showing the ✓/○ pills.

### 4. Remote deep-diff de-noise

`diffRemote` (src/core/status.ts) no longer emits the `""` store-metadata pseudo-entry — lock-file drift is expected, not a difference worth reporting. Consequences in the panel's remote detail render unchanged code-wise but improve behavior: a remote differing ONLY in `store.lock.json` / `config-sync.json` bookkeeping now shows `✓ remote matches the local store`.

**Pull/Push reports keep their "Store metadata" section** (`ReportModal`) — those report what was actually written, and the lock file genuinely is written; that path (`importExternal`/`pushExternal`) is untouched.

## Copy strings (verbatim)

| Context | String |
|---|---|
| Filter pill | `No settings yet {n}` |
| Title/section pill | `○ {n}` |
| State icon tip | `no settings yet — nothing on this device or in the store` |
| Expand note | `no settings yet on this device or in the store — appears under “To capture” once this item has settings` |

(The expand note says "this item", not the mockup's "this plugin" — groups like `hotkeys` aren't plugins; this adjustment is intentional.)

## Testing

- Core: `statusForGroups` returns `no-settings` for file group with both sides absent; dir group with both sides empty/absent; still `not-captured` when local exists and store doesn't; still deletion-only `differs` when store exists and local doesn't. `bucketCounts` maps `no-settings` → `none`.
- `diffRemote`: a remote differing only in `store.lock.json` yields zero entries; group differences still reported.
- UI helpers: `visibleUnderFilter` for the new filter key; capture-filter excludes `no-settings`.
- Live smoke: stage a group with no file anywhere → `○` row, disabled checkbox, note text, excluded from "To capture" count and section select-all; ribbon dot stays off; write the file → flips to `—` under "To capture". Remote deep-diff against a store differing only in lock → "matches" line.

## Non-goals

- No changes to capture/apply/pull/push behavior, reports, commands, or settings.
- No redesign of the `—` glyph or other copy beyond the table above.
