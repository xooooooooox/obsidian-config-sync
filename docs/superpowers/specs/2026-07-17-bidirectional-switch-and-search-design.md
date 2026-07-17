# Bidirectional switch-list summary, enable-only apply, Sync Center search UX

Real-vault findings 2026-07-17 (post-0.25.1), 定稿 mockup: switch-search-mockup.html
(bidirectional amber summary + exclude shortcut + sorted diffs / search sections + filtered
pills / enable-only rows). One branch.

Ground truth behind the findings: both stores were identical; the pain was kickstart's LOCAL
list diverging from the store in four non-excluded ids (+mx-bili-plugin, +obsidian-mind-map /
−obsidian-list-callouts, −simpread). Mirror semantics make both directions destructive, and
the UI neither warned nor offered the exclusion escape hatch.

## A. Bidirectional divergence summary (switch-list rows)

New pure helper (src/core/switchList.ts):
`switchDivergence(local, store, exceptions): { captureRemoves: string[]; applyDisables: string[] }`
— non-excluded ids the capture would remove from the shared list (store ∩ ¬local) and the
apply would turn off locally (local ∩ ¬store). Sorted, exceptions masked.

Sync Center switch-list row expansion, ONLY when both arrays are non-empty (a one-sided
difference stays as today):
- Amber summary block (left border, `--text-warning`-toned) with two lines:
  - "↑ Capture removes N from the shared list — other devices will turn them off: a, b"
  - "↓ Apply turns off N on this device — exclude them first to keep them: x, y"
- Shortcut button "⌂ Exclude this device's N extras…" under the summary: opens a confirm
  modal listing the applyDisables ids as pre-checked checkboxes; confirming adds the checked
  ids to `switchExceptions[group]` and refreshes. (The modal reuses the plain Obsidian Modal
  + checkbox rows; no new visual language.)

## B. Sorted view for switch-list diffs in the Sync Center

The inline capture/apply diff for switch-list rows renders both sides through
`switchListSortedView` (same helper as the conflict modal), meta suffixed "· sorted view".
Kills the last-element-comma and trailing-newline artifacts and ordering noise; only real
adds/removes remain.

## C. Enable-only apply (Disabled section ○ rows)

Symmetric to 0.24.0's install-only:
- `stageableRow` also returns true for ("disabled" section, "no-settings") — apply-only.
- Detail note: "no settings to apply — enables the plugin only"; the policy ladder hides
  "Keep disabled" (a complete no-op) and keeps ⏻ Enable.
- Core: `applyWithActions` treats action "enable" with no store data as action-only (no
  applyGroup error); the honest-messaging rule from 0.25.x applies — "no settings in the
  store — enabled the plugin only" is pushed only when the plugin is actually enabled
  afterwards (the enable runs in the finish closure, so the message is resolved after it).

## D. Search UX (Sync Center)

1. **Section context**: search matches always render under their owning section header
   (Outdated / Disabled / Not installed), sections force-open with "n of m" counts; only the
   main-scope matches render in the main card. No more flat, context-less rows.
2. **Filtered pills**: while searching, the filter pills count the MATCHED set — the All pill
   reads "All n / m" (m = unfiltered total), the state pills count matches only.
3. **Inert reason inline**: while searching, an inert (uncheckable) matched row shows its
   reason as an italic one-liner under the row (the stateIcon tooltip text), so a grey row is
   never unexplained.

## Testing

- switchList: `switchDivergence` cases (masking, one-sided, bidirectional, sorted output).
- panelModel: stageableRow ("disabled", "no-settings") → true; main stays false.
- core: enable-only apply — enables without files, honest message; failed enable keeps the
  warn note and drops the "enabled the plugin only" line.
- UI-level pure logic where extractable (pill counts from matched rows).
- Live dev-vault: bidirectional summary + shortcut flow (forged divergence), search with
  sections/pills, enable-only on a settings-less disabled plugin. Full gates (lint baseline
  67, no hardcoded colors — amber uses palette vars).
