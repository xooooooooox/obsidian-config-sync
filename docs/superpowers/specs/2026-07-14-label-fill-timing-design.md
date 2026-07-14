# Unified Label Fill Timing (0.22.x)

Converge the display-name `label` fill into a single mechanism so labels are populated as early
as possible (on the next status refresh) instead of only when the user happens to run Capture.

## Problem

`config-sync.json` groups carry an optional `label` (the item's display name, e.g. `BRAT`,
`App settings`) so names read correctly on devices where the plugin isn't installed. Today it
is written in two disconnected places:

1. **On enable** (settings panel) — when a group is created via `groupForItem(name, path, type,
   desc, item.label)`, the catalog item's label is stored immediately. Cheap and correct
   because the label is already in hand.
2. **On capture** (`main.ts` captureItems host, ~lines 246-257) — after `capture()`, reads all
   groups and backfills a label for any group lacking one whose resolved display name differs
   from the raw/`plugin-`-stripped name.

The two-stage split is a compromise, not a necessity: a label's only authoritative source is
runtime (`getInstalledPluginName` / `getCorePluginName` off Obsidian's plugin registry), and
the pure core layer (`capture`, `writeGroups`) has no runtime access — so the fill can only
happen where a runtime handle exists. The original code put a copy at each such spot.

Consequence (verified in the dev vault): a group added before 0.21.0, or added on a device that
hasn't run Capture since, keeps `label` empty until the next Capture. Diagnosed as timing, not a
data-loss bug — a Capture populates every label correctly.

## Design — single backfill on status refresh

Keep the enable-time immediate write (good UX: an item shows its name the moment it's turned on).
Replace the **capture-only** backfill with a **unified backfill run from
`refreshLocalStatus`** — the method already invoked on panel open, on the periodic 5-minute
check, and on awareness (store-file) changes. This gives the earliest, seamless coverage without
the user needing to Capture.

### The backfill unit

Extract the existing capture-host backfill body into one private method on the plugin:

```ts
// Fills in any missing display-name label using runtime plugin/core names, and persists the
// manifest only if at least one label was added. Never throws into the caller.
private async backfillLabels(ctx: CoreContext): Promise<void> {
  try {
    const groups = await readGroups(ctx);
    let changed = false;
    for (const g of groups) {
      if (g.label !== undefined) continue;
      const resolved = this.displayName(g.name, g.label);
      if (resolved !== g.name && resolved !== g.name.replace(/^plugin-/, "")) {
        g.label = resolved;
        changed = true;
      }
    }
    if (changed) await writeGroups(ctx, groups);
  } catch (e) {
    console.error("Config Sync: label backfill skipped", e);
  }
}
```

This is byte-for-byte the current inline logic (main.ts ~246-257), lifted into a named method.

### Call sites

- **`refreshLocalStatus`**: after the status scan succeeds (it already builds a `CoreContext`
  via `coreContext()` and loads the manifest), call `await this.backfillLabels(ctx)` before
  `notifySyncCenter()`. If a label was written, the subsequent status/notify already reflects the
  updated manifest on the next read; no extra refresh needed. `refreshLocalStatus` must remain
  non-throwing (it already wraps its body) — `backfillLabels` is internally guarded too.
- **Remove the inline backfill from `captureItems`** (main.ts ~246-257). Capture no longer needs
  its own copy: `refreshLocalStatus` runs right after capture (`captureItems` already calls
  `await this.refreshLocalStatus()` at the end), so the label fill still happens post-capture —
  now through the single mechanism.

Net: one backfill method, called from `refreshLocalStatus`; the enable-time write stays; the
capture-time duplicate is deleted. Labels populate on the next refresh after any change
(panel open, periodic tick, awareness event, or post-capture), not only on Capture.

### Write-frequency guard

`backfillLabels` writes the manifest only when `changed === true` — i.e. only when a label was
actually added. On a steady state where every group already has a label, it does a read and no
write. `refreshLocalStatus` runs at most every 5 minutes on the periodic timer plus on
panel-open / awareness events, so the extra work is a single manifest read per refresh, and a
write only until all labels are filled (then never again). Acceptable.

## Edge cases

- A group whose resolved display name equals the raw or `plugin-`-stripped name (e.g. an
  unrecognized `plugin-foo` with no installed manifest) gets no label — unchanged behavior,
  avoids writing a useless `label: "foo"`.
- `refreshLocalStatus` failure (e.g. manifest read error): `backfillLabels` is inside its own
  try/catch and logs rather than throws, so a backfill hiccup never breaks status refresh.
- Capture path: `captureItems` still ends with `refreshLocalStatus()`, so post-capture labels
  are covered by the unified mechanism — no regression.
- No new labels are invented: the resolver chain is unchanged (OPTION_LABELS → core runtime →
  plugin runtime → stored label → raw id); backfill only persists what the resolver already
  produces at runtime.

## Testing

The backfill body is unchanged logic already exercised indirectly; its correctness lives in the
resolver (`displayLabelForGroup`, covered by catalog tests) and the manifest round-trip
(`writeGroups`/`parseGroup`, covered by manifest tests). No new unit test file — the change is a
relocation of an existing block plus one call site. Verify via the controller smoke: on a vault
whose `config-sync.json` has label-less groups, open the Sync Center (triggers
`refreshLocalStatus`) and confirm `config-sync.json` gains labels **without** running Capture.
Node suite stays at 202.

## Scope

`src/main.ts` only (extract `backfillLabels`, call from `refreshLocalStatus`, delete the inline
capture backfill). No core-layer change, no UI, no copy change. This is item 1 of the post-0.21.0
backlog; the remaining items (core-plugin dynamic enumeration, Remotes UX, checkbox
presentation, interruption robustness, and the deferred self-config-propagation model) are
separate specs.
