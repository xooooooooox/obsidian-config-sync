# Discovered-rule origin, icon buttons, mobile adaptation, review-findings cleanup — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** four items from post-0.7.0 device testing and the first directory review: (1) discovered-origin rules stay in Discovered, (2) Reset/Add controls become icons, (3) mobile layout (Linter-style tabs, no horizontal panning), (4) automated-review findings (release notes, Node-import warnings, README disclosures).

## Background facts (from research, 2026-07)

- The directory switched to fully automated review in 2026-05. "Completed" with warnings only = approved; `config-sync` is already live in `community-plugins.json` and installable via `obsidian://show-plugin?id=config-sync`. In-app search lags up to ~24 h. No author action needed for listing — this iteration only cleans up the findings.
- The source-code scanner is `obsidianmd/eslint-plugin`'s `no-nodejs-modules` rule (warn severity). It suppresses the warning when the Node import is a dynamic `import()`/`require()` whose enclosing function's **first statement** is `if (!Platform.isDesktop) { throw/return }` — same file, exact property name `isDesktop`.
- Developer policies (Disclosures): network use and out-of-vault file access **must** be disclosed in the README with reasons. This is the only hard obligation among the findings.

## 1. Discovered rules stay in Discovered

**Data:** `SyncGroup` gains an optional field `origin?: "discovered"`. Written to `config-sync.json` when a Discovered toggle creates the rule. The manifest validator accepts (and preserves) the field; absent = user/picker rule. No migration: old files parse unchanged; rules created by the pre-0.8.0 Discovered flow simply remain custom rules.

**Rendering (Advanced tab):**

- Discovered section shows two kinds of rows, same summary-row language:
  - **Enabled**: one row per group with `origin: "discovered"` — chevron, mono filename (`splitLocation(path).rel`), toggle ON. Expandable; the panel renders **only the line-2 fields**: `Devices` / `Sanitize` / `Description`. No Name, Location, or Path fields — those are fixed by the file itself.
  - **Not synced**: scan results from `listDiscovered` (unchanged exclusion logic — files covered by any group don't appear), toggle OFF, not expandable (as today).
- Toggle ON (on a not-synced row) creates `{ name: d.name, path: d.path, type: "file", devices: "all", origin: "discovered" }` — same rollback-on-save-failure as today. The row stays in Discovered, now enabled.
- Toggle OFF (on an enabled row) deletes the group; the file reappears as a not-synced scan row. No confirm (consistent with custom-rule delete).
- The Discovered section renders whenever scan results OR discovered-origin groups exist (today: scan results only).
- Custom rules section filters to groups without `origin` — it is purely hand-written rules again.
- Edge: a discovered-origin group whose file no longer exists on this device still renders as an enabled row (the rule is synced config; the store may carry content from another device).
- Copy: Discovered description becomes "Config files we found but couldn't classify. Turn one on to start syncing it." (the "rename it under Custom rules" clause is dropped — the name is fixed to the suggested slug).

**Out of scope:** renaming discovered-origin rules (the slug is the store folder name; fixed by design).

## 2. Icon buttons

- Managed heading "Reset all" and per-row "Reset" text buttons → `ExtraButtonComponent` with lucide `rotate-ccw` icon; tooltips "Reset all to picker defaults" / "Restore to the picker default". Same quiet visual language as the existing trash icon.
- "Add rule" (Advanced) and "Add remote" (Remotes) text buttons → `ExtraButtonComponent` with `plus` icon; tooltips "Add rule" / "Add remote". Same click handlers.
- The row-click expansion guard (`closest("button, .clickable-icon, input, select")`) already covers ExtraButtons (`.clickable-icon`).

## 3. Mobile adaptation (Linter-style tabs)

**Problem (from device screenshots):** `.config-sync-tabs` is a no-wrap flex row; on phones the 6 tabs overflow and pan the entire settings panel horizontally, clipping all content. The expanded-form grids (fixed em columns) and Remotes rows (4+ inline inputs) also overflow.

**Tab bar** (pattern from the Linter plugin, adapted):

- Each tab renders a lucide icon + label: General=`settings`, Obsidian=`gem`, Core plugins=`blocks`, Community plugins=`puzzle`, Advanced=`wrench`, Remotes=`git-branch`. Icons via Obsidian's `setIcon()`.
- On phones (`body.is-phone` selector — no hardcoded pixel breakpoints), non-active tabs collapse to icon-only (label visually hidden); the active tab shows icon + label. Desktop shows icon + label for all tabs.
- `.config-sync-tabs` gets `overflow-x: auto` as a fallback so the tab bar scrolls within itself and never pans the page.

**Content fixes (all `.is-phone`-scoped CSS, no TS changes):**

- `.config-sync-form-line1` / `-line1.has-name` / `-line2`: single-column stack (`grid-template-columns: 1fr`).
- Remotes rows: allow the Setting control group to wrap (`flex-wrap: wrap` on `.setting-item-control` within the sources list — scoped by a class on the sources container, not globally).
- `.config-sync-row-path`: `overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0` so long paths truncate instead of widening the row.
- Acceptance: no horizontal page scroll on a phone-width viewport in any tab.

## 4. Review-findings cleanup

**4.1 Release notes:** `release.yml`'s `gh release create` gains `--generate-notes`. GitHub autogenerates the body from commits since the previous tag; the draft can still be edited before publishing. Clears the "release has no description" recommendation.

**4.2 Node-import warnings:** refactor `src/external/gitSource.ts` and `src/external/localPath.ts` to the scanner-sanctioned pattern:

- Remove all top-level Node builtin imports (`child_process`, `util`, `fs/promises`, `os`, `path`, `fs`).
- Each exported factory (`createGitReader`, `createGitWriter`, `createLocalPathReader`, `createLocalPathWriter`) starts with `if (!Platform.isDesktop) { throw new Error("Config Sync: <feature> is desktop-only"); }` as its **first statement**, then dynamically imports the Node modules it needs; inner helpers receive the modules via closure/parameters.
- `Platform` is statically imported from `obsidian` in these files (allowed: the mobile red line binds `src/core/*` only; `src/external/*` is desktop-only by contract and `obsidian` is always resolvable).
- `createLocalPathReader`/`createLocalPathWriter` become `async` (dynamic import forces it); call sites in `main.ts` add `await`.
- Behavior is unchanged; existing `tests/external.test.ts` must pass as-is apart from awaiting the now-async local-path factories. Note: the tests run in Node without Obsidian — the test setup's `obsidian` mock must expose `Platform.isDesktop = true` (extend the existing mock if needed).
- The two Behavior warnings (Direct Filesystem Access, Shell Execution) are capability descriptions and remain — they are the listing's honest safety indicators, not defects.

**4.3 README disclosures (hard policy requirement):** add a "Security & privacy" section to README.md stating:

- Network use: only when you configure a **git remote**; the plugin runs `git` against the URL you provide (pull/push of the store). No telemetry, no other endpoints.
- Out-of-vault file access: only when you configure a **local-path remote**; the plugin reads/writes the absolute path you provide (another vault's store folder). Git remotes additionally use a temporary clone directory.
- Both features are optional, disabled by default, desktop-only, and never run without an explicit Pull/Push command.

## Error handling

Unchanged paths throughout. New failure surfaces: the desktop guards in `src/external/*` throw a clear error if ever reached off-desktop (defense in depth; `transportAvailable()` already hides the commands on mobile). Discovered toggle-off is a plain group delete via `saveGroups` (existing banner on failure).

## Testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit: `origin` field round-trips through the manifest validator; external tests pass with async local-path factories.
- Smoke (obsidian-cli, dev vault): Discovered toggle on → row stays in Discovered enabled, expandable with only Devices/Sanitize/Description; toggle off → returns to not-synced; Custom rules shows only hand-written rules; icon buttons work (reset all/reset/add rule/add remote); tab icons render, active tab highlighted; zero console errors.
- Mobile CSS verified by viewport-width inspection (dev vault window narrowed / `body.is-phone` forced): no horizontal page overflow.
- Post-release check: next version's automated review should show the 6 source-code warnings and the release-notes recommendation gone.

## Non-goals

- Eliminating the Behavior warnings (impossible while the features exist; they are disclosures, not defects).
- Renaming discovered-origin rules; migrating rules created by the old Discovered flow.
- isomorphic-git / mobile transport (deferred backlog).
- Any `src/core` behavior change beyond the `origin` field and Discovered listing.
