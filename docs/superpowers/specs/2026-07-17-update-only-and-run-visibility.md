# Update-only staging, self-update guard, switch-apply reporting, run visibility

Device-B findings 2026-07-17 (post-0.27.0), one branch (fix/switch-status-set-compare),
release 0.27.1.

## 1. Switch lists always compare as sets (already on the branch)

`exc.length > 0` doubled as the switch-list detector in `statusForGroups`, so devices with no
exclusions fell through to byte comparison — local enable-order vs store-stable order read as
a permanent phantom "To capture" (empty diff, byte-identical no-op capture). Detection is now
`SWITCH_LIST_GROUPS.has(group.name)`; exceptions only mask, never gate.

## 2. Update-only staging + self-update guard

Third member of the action-only family (install-only 0.24.0, enable-only 0.27.0): a plugin
whose settings match the store but whose version is behind (Outdated section, state in-sync)
had no upgrade path — in-sync rows are inert and the Outdated ladder only rendered on content
differences.

- Outdated-section rows with state in-sync become stageable (apply). Detail: amber version
  line + note "no content changes — updates the plugin only" + the On-apply ladder with the
  no-op choice hidden (⤓ Update to latest only; unstage = keep). Apply runs the update action;
  the settings rewrite after it is byte-identical and harmless.
- **Self guard**: `plugin-config-sync` never offers update through its own pipeline — the
  update action disables the plugin first, which would unload the code executing the run.
  The row stays inert with the note "Config Sync updates itself through Obsidian's plugin
  updater — Settings → Community plugins." Core defends too: a state action that would
  install/update the self plugin returns a warning instead of executing.

## 3. Switch-list apply names the plugins it toggles

Applying an on/off list silently flipped plugin states (a store list lacking a just-enabled
plugin turned it off persistently — ZotLit). The apply result for a switch-list group now
carries messages naming the delta it wrote relative to the previous local list:
"turns on: a, b" / "turns off: c" (ids). No status change — informational lines in the
report/result strip details.

## 4. Run progress visibility (mockup pending 定稿)

"Applying 0/1…" is a blind wait: progress is item-granular, the current item's name hides in
an aria-label, and the slow part (network install) is inside the item.

- ProgressFn detail: `(done, total, detail)` where detail is a human phrase; install/update
  steps report "Name — downloading from the community catalog… / installing via BRAT… /
  writing settings… / enabling…". A status line near the action bar shows it live.
- The button's progress bar animates (indeterminate shimmer, palette vars) while a step runs;
  the fill still steps by done/total.
- A step exceeding ~8s appends "still working — network fetches can take a while…".

## Testing

- status: order-different, exception-free switch list → in-sync (done, on branch).
- panelModel/view: outdated+in-sync stageable; self row inert with updater note.
- core: self install/update action returns the guard warning without running; switch-apply
  result messages name turned-on/off ids (array + map shapes).
- Live dev-vault: update-only ladder on a forged outdated row; progress line during a real
  install; gates (lint 67 baseline, no hardcoded colors).
