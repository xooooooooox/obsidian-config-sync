# Settings polish + git compare hardening — design

Date: 2026-08-03
Mockup (定稿): claude.ai artifact "config-sync 2.12 mockups" — copy in this spec is final.
Baseline: 2.11.0.

## Context

Three user-reported issues, batched as one release:

1. **Remotes tab, git type**: the third form field's label ("Store folder in repo (optional)")
   wraps to two lines at typical widths, pushing its input below the URL/Branch inputs.
   The row is a 3-column grid (`.config-sync-remote-git`, `grid-template-columns: 1fr 8em 1fr`,
   `styles.css:276`) with nothing pinning inputs to a common baseline.
2. **Settings tab bar**: Obsidian 1.13 opens Settings in its own (narrower) window; the
   seven-tab bar with full labels is cramped on desktop. The icon-only collapse already
   exists but is phone-gated (`body.is-phone .config-sync-tab:not(.is-active)
   .config-sync-tab-label { display: none }`, `styles.css:346`).
3. **Sync Center, git remote compare can hang on "comparing…" forever**: the git runner
   (`src/external/gitSource.ts:11-18`, `promisify(execFile)`) sets no timeout and no
   `GIT_TERMINAL_PROMPT=0`. A `git fetch config-sync-import <branch>` that stalls (network
   hang, credential-helper GUI waiting for input) never settles; the `await` in
   `renderRemoteDetail` (`SyncCenterView.ts:2221`) never returns, so neither the diff nor
   the error branch runs and the "comparing…" text stays forever. When git does fail fast,
   the raw git stderr is dumped verbatim into the error line — unreadable.

## Scope

### 1. Align git-row inputs (CSS only)

Labels keep their text and may wrap; inputs align to a shared bottom baseline.

- `styles.css`: make each direct child of `.config-sync-remote-git` a column flex and push
  the input down:
  ```css
  .config-sync-remote-git > div { display: flex; flex-direction: column; }
  .config-sync-remote-git > div input { margin-top: auto; }
  ```
- No TS changes. Phone single-column override (`styles.css:356`) is unaffected.

### 2. Desktop tab bar collapses to icon-only

Mobile behavior becomes universal: non-active tabs show icon only; the active tab shows
icon + label; clicking a tab activates (and thereby expands) it.

- `styles.css`: drop the `body.is-phone` gate on the label-hiding rule (`:346`) so it
  applies on all platforms. Other phone-only rules (e.g. the single-column
  `.config-sync-remote-git` override at `:356`) keep their gate.
- `src/ui/SettingTab.ts` `renderTabNav` (`:483-501`): set a tooltip on every tab button —
  `setTooltip(btn, tab.label)` (from `obsidian`) — and `aria-label` = tab label, so
  icon-only tabs stay identifiable on hover and to assistive tech.
- The Remotes tab remains `desktopOnly`; no tab-list changes.

### 3. Git compare: never hang, readable errors

Two layers — process hardening (root cause) and error presentation (product voice).

**3a. Process hardening — `src/external/gitSource.ts`**

- The `git()` runner passes to `execFile`:
  - `timeout: 60_000` (kills the child with SIGTERM after 60 s),
  - `env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }` (git fails fast instead of
    prompting for credentials).
- On failure the runner still throws one `Error`, but with a structured, classifiable
  message (see 3b). Timeout detection: `execFile` sets `error.killed === true` /
  `error.signal === "SIGTERM"` on timeout — the runner appends a recognizable marker
  (`timed out after 60s`) to the message for that case.
- Applies to every git invocation in the file (remote setup, fetch, ls-tree, show,
  ls-remote); the "Test connection" path in settings inherits the same bounds.

**3b. Failure classification — new pure helper `classifyRemoteFailure` in
`src/core/remoteFailure.ts`**

A pure function mapping a failure message to `{ kind: "auth" | "timeout" | "other" }`:

- `auth`: message matches any of `could not read Username`, `Authentication failed`,
  `Permission denied`, `credential` (case-insensitive).
- `timeout`: message contains the runner's `timed out after` marker.
- `other`: everything else (including vault-remote failures — the card below is used for
  all remote types; non-git errors classify as `other`).

Unit-tested (Vitest) — this is the only new logic with branches.

**3c. Error card — `src/ui/SyncCenterView.ts` `renderRemoteDetail` catch (`:2224-2228`)**

Replace the single-line error text with a card (copy is final, from the mockup):

- Heading: `Couldn't compare with {remote.name}`
- Body by kind:
  - auth: `The Git host asked for a login, and there's no way to answer it here. Set up
    this remote's credentials on this device, then check again.`
  - timeout: `The remote didn't answer within a minute. Check the connection, then check
    again.`
  - other: `Couldn't reach this remote.` (the card serves vault remotes too, so no "Git"
    prefix here; the raw message below carries the specifics)
- Below the body, a native `<details>` expander — summary `Show Git output` for git
  remotes, `Show details` for vault remotes — containing the raw error message in
  monospace.
- Card styling per mockup: red-tinted bordered card (`.config-sync-status-error` family),
  max-width bounded so long output doesn't stretch the pane.

The "comparing…" line itself is unchanged (option A: with the 60 s bound it always
converges to a result or the card). The stale-render guards at `:2225/:2230` keep working
as-is. `refreshRemoteChecks` (`main.ts:377-380`) keeps storing `unknown` on failure —
sidebar icon behavior unchanged.

## Non-goals

- No spinner / elapsed counter / Cancel (option B — deferred until "waits full 60 s"
  is observed in practice).
- No abort of the git child on navigation away (bounded by the 60 s timeout).
- No change to the persisted `RemoteCheck` state enum, auto-check cadence, or the
  Remotes-tab field set.
- No shortening of the "Store folder in repo (optional)" label.

## Testing

- New Vitest unit tests for `classifyRemoteFailure` (auth / timeout / other cases).
- Existing suite must stay green; gates as usual (`npm run build`, `npm test`,
  `npm run lint` silent at the zero-warning baseline).
- Live verify in the dev vault: git remote with an unreachable/auth-failing URL shows the
  card (auth copy + expandable output) within 60 s; Remotes tab git row aligned; desktop
  tabs icon-only with tooltips.
