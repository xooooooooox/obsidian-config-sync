# Sync Center Feedback Trio Implementation Plan

> **For agentic workers:** Executed INLINE by the controller (UI-heavy; rendered two-theme verification). Steps use checkbox syntax.

**Goal:** Passphrase status badge; version-ahead items surface as To capture; clickable inline content diff on change lines.

**Architecture:** #1 style-only (SettingTab + CSS). #2 view-derived presentation in panelModel (`effectivePresentation(state, drift)`) consumed by SyncCenterView — core untouched. #3 extract the conflict modal's diff renderer into `src/ui/diffView.ts`, add `SyncCenterHost.diffPair`, wire change lines to inline panels.

## Global Constraints

- Zero hardcoded color; badge/diff reuse existing palette classes. Conflict modal behavior byte-identical after extraction.
- Core `GroupStatus.state` semantics unchanged (#2 is presentation-only).
- Gates: build, lint (0 errors ≤65 warnings), tests green (323 + new), color scan. No AI attribution.

---

### Task 1: Passphrase badge
- [ ] `renderPassphrase`: replace the desc-tail status div with a badge span before the text input: cls `config-sync-ppbadge is-set|is-unset`, text `✓ Set on this device` / `Not set`; `updatePassphraseStatus` updates text+class. CSS: green/orange rgba pill (devbadge-shaped). Gate. Commit `feat: passphrase status badge`.

### Task 2: ahead → To capture (derived presentation)
- [ ] panelModel: `export function presentedState(state: GroupState, drift: VersionDrift): GroupState` → `state === "in-sync" && drift === "ahead" ? "local-changed" : state`. Unit tests (ahead upgrades; behind/null don't; non-in-sync passthrough).
- [ ] SyncCenterView: route the row's presentation through `presentedState` everywhere the raw state feeds UI: `visibleUnderFilter`, `stateIcon`, `effDir`/`directionForState`, `stageableState` guards, bucket counts (`bucketCounts` is core… check its input — if core-computed, wrap at view level where counts derive from statuses). Expansion: when upgraded and `status.changes` empty → note "no content changes — capturing refreshes the store version only" (versionLine already renders).
- [ ] Gate + commit `feat: version-ahead items surface as to-capture`.

### Task 3: inline diff
- [ ] Extract `src/ui/diffView.ts`: `diffLines` (LCS + cap), `renderUnified/renderSplit` (parameterized headers), session view pref, from ConflictModal; modal imports it (no behavior change — modal smoke in T4).
- [ ] Host: `diffPair(name, rel)` in main.ts: resolve group; encrypted → null; fields → left=store copy raw? NO: left = store copy content, right = captureTransform(local) for capture-direction… simpler per spec: compute both sides via the capture-comparison space: right = captureTransform(group, local, passphrase).content (fields strip/encrypt; needs passphrase for encrypt rules → null if missing), left = store copy raw. Labels by effective direction (view passes direction: capture → `--- store / +++ this device (what capture would write)`; apply → swap). Switch items: right = captureSwitchList(local, store, exc) serialized. Dir groups: per-rel file contents raw.
- [ ] SyncCenterView: change lines in `renderCappedChanges` become clickable (`· diff ▾/▴`), lazily fetch `diffPair`, render inline panel (diffView unified/split + toggle) under the line; null → "no diff available" note. CSS: container border only (reuse cm classes).
- [ ] Unit tests: diffView LCS (moved), plus a diffPair-shaped core test if cheaply possible; otherwise dev-vault verification. Gate + commit `feat: inline content diff on sync center change lines`.

### Task 4: smoke (dev vault, guard) 
- [ ] #1 badge two states + two themes; #2 forge ahead lock → row in To capture with amber line → capture → store version refreshed → row back to in-sync; #3 doctor a store file → expand row → click diff → unified/split panels correct, fields item shows transform-space diff; conflict modal still renders (regression after extraction); no error frames; ledger.

## Self-Review
Spec §1→T1, §2→T2, §3→T3, testing→per-task+T4. `presentedState`/`diffPair`/diffView names consistent. Post-plan: user acceptance → merge → cut 0.23.4 with notes.
