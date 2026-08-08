# C live-test batch 9: honest coldstart pane + persistent remote-pane folds — design

Date: 2026-08-08 · Scope: C live-test issues C-#19, C-#21 (ledger
`.superpowers/sdd/2026-08-06-c-livetest/issues.md`) · Branch: c-unified-grammar ·
Status: user-directed ("修 C-#19 以及 刷新重置")

## §1 C-#19 · coldstart pane tells the truth about the store

- `SelfSyncInfo` gains `storePresent: boolean` — computed in `selfStatus` from facts it
  already reads: the store lock exists OR the store's self-copy exists. NOT inferred
  from itemCount (a genuinely-empty adopted store is a different, storePresent=true
  case).
- Coldstart pane branches:
  - **storePresent=true** — exactly today's adopt block (copy, caution, Adopt/Not now).
  - **storePresent=false** — no "Found a configuration" claim, no Adopt, no Capture
    caution. Sub copy: `This is a new device — it has no sync list yet.` Block:
    - Header: `No store on this device yet`
    - With at least one remote configured (`host.remotes()` non-empty — desktop):
      body `Pull from {first remote name} first — that brings the store to this device;
      then adopt its configuration.` + button `Open {first remote name}` switching
      panelScope to that remote pane.
    - With none (also covers mobile, where remotes() is empty): body `The store arrives
      with your regular vault sync, or add a remote in Settings and Pull.` + no
      pane-jump button (the pane's existing Settings button covers the rest).
- No state-machine change: `selfPaneState`/"coldstart" decision logic untouched; this is
  presentation branching plus one new honest fact.

## §2 C-#21 · remote pane folds survive repaints

- New session-scoped view state (sibling of `expandedItems`/`typeSectionOpen`):
  one `Set<string>` for the remote pane's open folds, keys:
  - object-row fold: `{remoteName}::{group}`
  - on/off line: `{remoteName}::{group}::onoff`
  - per-file inline diff: `{remoteName}::{group}::{itemRel}`
- `renderRemoteDiffEntry`, `renderRemoteOnOff`, and the file-row diff toggle read the
  set at render (open state + glyph) and update it on click, replacing the closure-local
  booleans. A repaint (periodic check, notify) rebuilds the pane with the same folds
  open. Never persisted to disk; never pruned (session-scoped, tiny).
- Content is always rebuilt from the CURRENT compare result — persistence covers which
  folds are open, never stale content.

## §3 Tests

- `selfStatus.storePresent`: lock-only → true; self-copy-only → true; neither → false
  (extend the existing selfStatus test harness).
- Fold-state keys: if a pure key-builder is extracted, test it; DOM wiring stays
  manually verified per suite convention.

## §4 Gates & verification

Suite 1097 green + new tests; build clean; lint 0 errors / ≤58 warnings (ceiling, zero
new); redeploy llm AND kickstart. Manual FAIL CRITERIA: (C-#19) llm (never pulled) self
pane shows the No-store guidance with an `Open kickstart` button and NO Adopt; (C-#21)
an expanded on/off line stays open across a periodic repaint of the kickstart pane.
