# Desktop-only: route installed-but-disabled plugins to the Desktop-only section

## Problem

On mobile, a desktop-only plugin whose files are present (synced) is **installed but
disabled** — Obsidian refuses to enable a desktop-only plugin on a phone, so its
availability is `kind: "disabled"`. `sectionForItem` (`src/ui/panelModel.ts:111`)
only routes `kind === "not-installed"` desktop-only plugins to the informational
Desktop-only section:

```ts
if (isMobile && a.desktopOnly && a.kind === "not-installed") return "desktop-only";
```

So installed-but-disabled desktop-only plugins fall through to the `disabled`
branch and land in **"Disabled on this device"**, where every row is stageable and
offers an "⏻ enable" action. Two user-visible bugs, one root cause:

1. **Select-all in "Disabled on this device" selects them** and stages a
   `⏻ enable` that Obsidian will reject on a phone (real-vault repro: 16 selected,
   each desktop-only row showing "⏻ enable").
2. **They never reach the Desktop-only section** — only a genuinely *not-installed*
   desktop-only plugin (e.g. SimpRead Sync) gets there.

This is a 1.1.2 design gap (D3 considered only the not-installed case). Ships in
1.1.2 and 1.1.3; targets 1.1.4.

## Fix

Route **every** desktop-only plugin that can't run on this phone — not-installed
*or* installed-but-disabled — to the Desktop-only section. On mobile a desktop-only
plugin is never `enabled` (Obsidian won't enable it), so the guard is simply "not
enabled":

```ts
if (isMobile && a.desktopOnly && a.kind !== "enabled") return "desktop-only";
```

The Desktop-only section is non-stageable (`stageableRow(_, "desktop-only")` is
`false`) and controls-free (`renderInfoSection`), so once these rows live there:

- select-all in "Disabled on this device" no longer reaches them (bug 1), and
- they appear under Desktop-only with the rest (bug 2).

Desktop is unaffected — the `isMobile` guard means a disabled desktop-only plugin
on desktop still shows under "Disabled on this device" as before. The `!== "enabled"`
guard leaves the (practically impossible) enabled-on-mobile case in `main` rather
than mislabeling a running plugin as "nothing to do here".

## Testing (`tests/panelModel.test.ts`)

- Rewrite the existing `it("a desktop-only plugin that IS installed is not bucketed
  to desktop-only", ...)` — it encodes the bug. It becomes: a disabled desktop-only
  plugin buckets to `desktop-only` on mobile, and stays `disabled` on desktop.
- Add: an enabled desktop-only plugin on mobile buckets to `main` (the guard).
- The existing not-installed and `stageableRow("_", "desktop-only") === false`
  cases stay green.

## Non-goals

No change to the Desktop-only section's rendering, to the pill (①), or to capture
backfill (②). One-line logic change plus test updates.
