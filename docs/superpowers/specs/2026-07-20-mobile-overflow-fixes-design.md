# Mobile overflow fixes — design

Two horizontal layouts in the Sync Center overflow at phone width. Both fixes are
scoped to `body.is-mobile`; desktop layout is untouched. Mockup 定稿 approved
(② approach A, ③ two-row).

## ② "On apply" policy segment gets clipped

**Symptom.** In an expanded item's detail, the `On apply` row shows a segmented
button group (`⤓ Install & enable | ⤓ Install`) followed by `Stop syncing`. On a
phone the group + `Stop syncing` don't fit one line. Because `.config-sync-seg`
carries `overflow: hidden` (for its rounded-corner clipping), the last button
(`⤓ Install`) is cut off instead of wrapping.

**Structure (unchanged).** `renderPolicySeg` builds
`.config-sync-segrow` (flex, `align-items:center`, `gap`) → `.config-sync-seg`
(the buttons) + `.config-sync-stopsync` (sibling, when `canStopSyncing`).

**Fix (approach A — pure CSS).** On mobile only, let the segrow wrap:

```css
body.is-mobile .config-sync-segrow { flex-wrap: wrap; }
```

The segment stays intact on line 1; `Stop syncing` drops to line 2, left-aligned.
No render change. Desktop `.config-sync-segrow` (line ~655) keeps `nowrap` default.

## ③ Result strip crams into multiple lines

**Symptom.** `.config-sync-strip-head` is a single no-wrap flex row holding six
things: check icon, title, report pills, `details ▸`, `open in history →`, `✕`.
On a phone they don't fit; the title text reflows and the row looks broken.

**Structure change (small).** `renderResultStrip` currently appends the pills,
both toggles, and close directly onto `.config-sync-strip-head`. Group only the
"meta" items (report pills + the two toggles) into a new
`.config-sync-strip-meta` container. **`close` stays last in the DOM** — that is
what keeps desktop identical. The DOM order becomes:

```
.config-sync-strip-head
  .config-sync-strip-check      (⚠)
  .config-sync-strip-title      ("Applied with 1 issue")
  .config-sync-strip-meta                        ← NEW wrapper
    (report pills)
    .config-sync-strip-toggle   (details ▸)
    .config-sync-strip-toggle   (open in history →)
  .config-sync-strip-close      (✕)            ← unchanged position (last)
```

**Desktop (identical).** `.config-sync-strip-meta` is `display: contents`, so its
children participate directly in the head flex in their natural DOM order —
check, title, pills (`margin-left:auto`), details, history, close
(`margin-left:auto`). Byte-for-byte the same layout as today; no `order`, no new
rules on desktop.

**Mobile (two rows).** The head wraps; meta becomes a real 100%-basis flex row.
Because `close` is last in the DOM, `order` pulls it back onto row 1 (before the
meta row) on mobile only:

```css
body.is-mobile .config-sync-strip-head { flex-wrap: wrap; }
body.is-mobile .config-sync-strip-close { order: 2; }   /* onto row 1, after title */
body.is-mobile .config-sync-strip-meta {
  order: 3; flex-basis: 100%;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding-left: 22px; margin-top: 6px;
}
body.is-mobile .config-sync-strip-meta .config-sync-report-pills { margin-left: 0; }
```

check/title keep their default `order: 0`. Flex places order-0 (check, title),
then order-2 (close), then order-3 (meta, 100% → its own row). Row 1:
`⚠ + title + ✕` (✕ pinned right by its existing `margin-left:auto`). Row 2:
pills + `details ▸` + `open in history →`, wrapping if still tight.

## Constraints / gates

- Only `body.is-mobile` rules added; desktop layout must render identically
  (verify `display:contents` on `.config-sync-strip-meta` leaves desktop head
  unchanged).
- No hardcoded colors (`./scripts/check-no-hardcoded-color.sh`) — reuse existing
  theme vars; no new colors introduced.
- `npm run build` clean; `npx eslint .` at 0 errors / 67 warnings baseline;
  `npm test` green (no core-logic change, but suite must stay green).
- Live-verify on `dev/vault` under mobile emulation
  (`dev:cdp Emulation.setDeviceMetricsOverride` + `body.is-mobile`): segment no
  longer clipped, `Stop syncing` on its own line; result strip renders two clean
  rows; desktop view unchanged.

## Non-goals

- No change to the segment's desktop sizing or to what actions appear.
- No change to strip content, colors, or the sticky dock behavior.
- Unrelated mobile polish (self-pane wording, adopt diff) is tracked separately.
