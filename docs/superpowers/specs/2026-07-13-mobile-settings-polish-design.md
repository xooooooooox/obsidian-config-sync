# Mobile Settings Polish & Capture Progress (iter22)

Approved mockups: `.superpowers/brainstorm/39264-1783912450/content/iter22-mobile-settings.html` (phone-width settings rows) and `iter22-progress.html` (footer progress states). Two additional user-reported behaviors folded in (capture blind-wait, settings jolt). Trigger: iOS screenshot showing the Themes row shattered by a false `author` detection plus clipped controls.

## Problems

1. **Phone settings rows shatter.** An item row packs name+badge+description left and three controls (device dropdown, mode segments, toggle) right; at phone width the left column collapses to one word per line and the mode segment clips to `Plain |`.
2. **`auth` detection false-positives on `author`.** `SENSITIVE_KEY_PATTERNS` matches substrings; `auth` catches `author`/`authorUrl` — present in every theme manifest, so every Themes user sees a wolf-cry badge.
3. **Capture blind-wait.** With many staged items (e.g. 57) the footer button spins with no progress; capture runs groups sequentially.
4. **Settings jolt on Fields/Encrypt.** Mode-segment and fields-editor edits call `saveGroups()` + full-tab `refresh()`; scrollTop is already restored, but the full async DOM teardown/rebuild flashes visibly (reads as a page reload, worst on mobile).

## Design

### 1. Stacked settings rows on phones (mockup)

Under `body.is-phone` (this is a width problem, phones only — tablets keep the row layout):
- The item's info block (name + badge inline, wrapping as a unit; description full-width below, including the `Detected: …` sentence) occupies the full row width.
- The controls (device dropdown, mode segments, enable toggle) move to their own row beneath, `flex-wrap`, gap-spaced, no clipping; toggle keeps right alignment via `margin-left: auto`.
- The badge renders as one non-breaking pill (`white-space: nowrap` on the pill, the *pair* name+badge may wrap as flex items).
- The fields editor rows already stack acceptably; ensure the pattern text truncates with ellipsis rather than pushing the action segment off-screen.
- CSS only (plus, if the current DOM structure makes the stack impossible — e.g. controls and info share one flex row via Obsidian's `Setting` — a minimal class hook on the row is allowed). Desktop and tablet unchanged.

### 2. Detection precision

- `auth` must not match `author*`: matching for the `auth` pattern becomes "contains `auth` NOT immediately followed by `or`" (regex `auth(?!or)` case-insensitive). `oauth`, `authToken`, `auth_key` still match; `author`, `authorUrl`, `authors` don't.
- Ruling on the other patterns (reviewed): `token` keeps substring matching — `tokenColor`-style keys are rare in config JSON and a false badge is informational only; no other pattern has a systemic collision like `author` (which appears in every theme/plugin manifest). No other changes.
- Unit tests: `author`/`authorUrl` clean; `oauth`/`authToken` still detected.

### 3. Capture/apply progress

- Core: `capture(ctx, names?, onProgress?)` and `apply(ctx, names, onProgress?)` gain an optional callback `(done: number, total: number, current: string) => void`, invoked before each group is processed. No behavior change when omitted.
- Sync Center footer buttons (per approved mockup `iter22-progress.html`): on click BOTH buttons disable; the clicked one shows an inline spinner + live label, copy verbatim: `Capturing {done}/{total}…` / `Applying {done}/{total}…` (counts tick per group), a 2px progress bar under the button tracks `done/total`, and the button's `aria-label` carries `current` (the group being processed). On completion the existing report flow takes over and the panel reload restores the footer naturally — no new modals or persistent UI.
- Also used by pull/push? No — out of scope (their per-file loops live elsewhere; the complaint is capture/apply).

### 4. Jolt-free settings edits

- Mode-segment clicks and fields-editor edits (add/remove/toggle rule, prefill) stop calling the full-tab `refresh()`. Instead they persist via `saveGroups()` and re-render **only the affected item row** in place (rebuild that row's DOM node — name/badge/desc/controls/fields editor — inside its existing container position).
- Structural actions keep the full refresh: enable/disable toggle, device-class change, type change, add/remove rule-form actions in Advanced.
- The full refresh path keeps its existing scrollTop restoration (unchanged).

## Copy strings (verbatim)

| Context | String |
|---|---|
| Capture progress button | `Capturing {done}/{total}…` |
| Apply progress button | `Applying {done}/{total}…` |

## Testing

- Unit: scanner precision cases (§2); progress callback invocation order/counts on a multi-group capture and apply (core tests with MemFS).
- Live: emulateMobile phone-width — Themes row clean (no badge) and stacked per mockup; a genuinely sensitive item shows the badge laid out per mockup; mode-segment click produces NO full-tab flash (row updates in place); staged multi-item capture shows `Capturing n/N…` ticking on the button.

## Non-goals

- No progress for pull/push; no persistent progress UI beyond the button label; no change to detection semantics beyond `auth(?!or)`; no tablet layout changes.
