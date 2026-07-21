# Self pane: concrete change detail + config-entry rework

Two changes to the Config Sync self pane (`SyncCenterView.renderConfigSyncMode`,
`:512`). Both are view-local (no host-interface additions).

## Problem

1. **"Local changes" shows only item names, not the change.** When Config
   Sync's own change is a **sync-list membership** delta (a group is in this
   device's `data.json` but not the store's — e.g. `+ Enabled CSS snippets`),
   the pane renders just the `+`/`−` names (`renderSelfDelta`, `:489`). The pane
   already knows how to show the actual `data.json` diff — but only takes that
   path for *content* changes (`renderSelfContentDetail`, `:599`), never for a
   membership change. So the user sees "+ Enabled CSS snippets" with no way to
   see what Capture will publish.

   (Clarification captured in the spec, not a code change: a "Config Sync
   change" is always its own `data.json` — the `groups[]` list, field rules,
   settings — plus version drift; the passphrase is never synced and
   `store.lock.json` only records timestamps.)

2. **"This device's configuration" is a heavy block wrapping one link.**
   `renderSelfConfigSummary` (`:501`) draws a full labeled block whose only
   content is "Open Config Sync settings →". Chrome out of proportion to a
   navigation link.

## Decision (定稿, mockups `mockup-self-pane.html` + `mockup-self-config-rethink.html`)

- **Issue 1:** keep the `+`/`−` name list, add a one-line clarifier that these
  are sync-list membership changes, and add a collapsible **`▸ view change
  (data.json)`** toggle that reuses the existing diff panel to show exactly what
  Capture/Adopt would write. Collapsed by default.
- **Issue 2:** delete the dedicated block. Put a small labeled **`⚙ Settings`
  button in the pane title row** (top-right). Clicking opens the Config Sync
  settings tab — same action as the old link. No item count on it.

## Architecture

### Shared: extract the settings-open action (`SyncCenterView`)

Extract the inline handler in `renderSelfConfigSummary` (`:505-509`) to a
private method:

```ts
private openConfigSyncSettings(): void {
  const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
  setting?.open();
  setting?.openTabById("config-sync");
}
```

### Issue 2: title-row Settings button

In `renderConfigSyncMode`, the title row is built at `:517-521`
(`config-sync-self-title` → state icon + "Config Sync" + optional state pill).
After the pill, append a spacer and the button:

```ts
title.createSpan({ cls: "config-sync-self-title-sp" }); // flex:1 spacer
const cfgBtn = title.createEl("button", { cls: "config-sync-self-settings-btn", attr: { "aria-label": "Open Config Sync settings" } });
setIcon(cfgBtn, "settings-2");
cfgBtn.createSpan({ text: "Settings" });
cfgBtn.addEventListener("click", () => this.openConfigSyncSettings());
```

- The title row renders before the `coldstart` early return (`:538`), so the
  button appears in **all** self states (coldstart / adopt / capture / both /
  insync) — config access is always relevant and harmless.
- **Delete** `renderSelfConfigSummary` (`:501-510`) and both its call sites
  (`:558` in the insync branch, `:594` at the end of the changed-state branch).
- `setIcon` is already imported in this file.

### Issue 1: membership-change clarifier + collapsible diff

**State:** add a transient expansion set to the view (beside the other UI-state
fields, e.g. near `selfInfo`):

```ts
private selfDiffOpen = new Set<Direction>(); // which self data.json diffs are expanded
```

**Factor the diff body out of `renderSelfContentDetail`.** The diff rendering
currently inlined at `:619-628` becomes a shared method so both the content-diff
path and the new membership path use it (DRY):

```ts
private renderSelfDataJsonDiff(holder: HTMLElement, dir: Direction): void {
  void this.host.diffPair(SELF_GROUP_NAME, "", dir).then((pair) => {
    if (pair === null) { holder.createDiv({ cls: "config-sync-expand-note", text: "no diff available" }); return; }
    const leftLabel = dir === "capture" ? "store" : "this device";
    const rightLabel = dir === "capture" ? "this device (what capture would write)" : "store (what apply would write)";
    renderDiffPanel(holder, pair.base, pair.produced, leftLabel, rightLabel, "data.json");
  });
}
```

`renderSelfContentDetail` (`:618-628`) is rewritten to call it:
`block.createDiv({ cls: "config-sync-self-block-s", text: "Config Sync's own
settings changed:" }); this.renderSelfDataJsonDiff(block.createDiv({ cls:
"config-sync-inline-diff" }), dir);` — behavior unchanged (always-open diff).

**New collapsible toggle** for the membership case:

```ts
private renderSelfViewChange(block: HTMLElement, dir: Direction): void {
  const open = this.selfDiffOpen.has(dir);
  const link = block.createDiv({ cls: "config-sync-self-viewchange", text: open ? "▾ hide change (data.json)" : "▸ view change (data.json)" });
  link.addEventListener("click", () => {
    if (open) this.selfDiffOpen.delete(dir); else this.selfDiffOpen.add(dir);
    this.render(this.renderGen);
  });
  if (open) this.renderSelfDataJsonDiff(block.createDiv({ cls: "config-sync-inline-diff" }), dir);
}
```

**Wire into the two membership branches:**

- **Adopt block** (`:567-576`): after the existing
  `renderSelfDelta(info.delta.added, info.delta.removed)` (`:571`), call
  `this.renderSelfViewChange(block, "apply")`. The existing clarifier line
  (`:570`, "Adopting adds these to this device's sync list…") stays.
- **Capture block** (`:578-592`): after
  `renderSelfDelta(info.delta.removed, [])` (`:582`), add a clarifier then the
  toggle:
  ```ts
  block.createDiv({ cls: "config-sync-self-block-s", text: "These are in this device's sync list but not the store's — Capture publishes their definitions." });
  this.renderSelfViewChange(block, "capture");
  ```
  (Place the clarifier before or after the delta list per the mockup — mockup
  shows it directly under the item list.)

The `else` branches (`:572`, `:583`) calling `renderSelfContentDetail` for the
no-delta content-change case are unchanged.

### CSS (`styles.css`)

- `.config-sync-self-title-sp` — `flex: 1` spacer pushing the button right.
- `.config-sync-self-settings-btn` — small ghost button (icon + label): muted
  text, subtle bordered background, `svg` sized inline, hover → accent border/
  text. Theme vars only (`var(--text-muted)` / `rgba(var(--interactive-accent-rgb), α)`);
  no hardcoded color.
- `.config-sync-self-viewchange` — small accent-colored clickable link (matches
  the existing inline-expand affordances).
- Remove `.config-sync-self-link` if it is now unused (grep first — it was the
  old "Open Config Sync settings →" style).

## Testing

Rendering changes reusing tested machinery (`diffPair`, `renderDiffPanel`,
`renderSelfDelta`) — verification is live; no new pure logic to unit-test.

- **Live (dev vault — the real verification):**
  - **Capture membership case** (the reported scenario — this device tracks
    `enabled-css-snippets`, store doesn't): the block shows `+ Enabled CSS
    snippets`, the clarifier line, and `▸ view change (data.json)`; expanding
    shows a `data.json` diff whose added `groups[]` entry is the snippet group;
    collapsing hides it. Capture still works.
  - **Adopt case** (force a store-side list addition): `▸ view change` appears
    under the adopted items and expands to the apply-direction diff.
  - **`⚙ Settings` button:** present in the title row in every state
    (insync / capture / adopt / both / coldstart); clicking opens the Config
    Sync settings tab. The old bottom "This device's configuration" block is
    gone.
  - **insync state:** title-row button present; no stray empty block below.
  - Desktop 390×844 and mobile: title row (icon + name + pill + Settings
    button) fits without overflow; on narrow width the button stays on the row
    or wraps cleanly.
- **Gates:** `npx tsc -noEmit -skipLibCheck` clean, `npm test` green,
  `npx eslint .` **0 errors / 67 warnings**,
  `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- **No inline config readout / tracked-items list** in the pane — "This device's
  configuration" stays a jump to the settings panel, not an in-pane data dump
  (定稿: navigation, not summary).
- **No change to the diff content or `diffPair`** — the membership case reuses
  the exact same `data.json` diff the content case already shows.
- **No change to `selfBadge` / `selfStatePill`** or the coldstart adopt flow.
- No new host-interface methods; entirely view-local.
