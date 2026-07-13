# Settings Panel Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the whole plugin's `styles.css` into design-system compliance — theme-native surfaces/controls, zero hardcoded color channels, semantic colors bound to Obsidian palette variables — and wire an anti-drift color scan into the smoke gate.

**Architecture:** Pure CSS/DOM-structure work. The config-panel portion is already done in the working tree (user-verified across the default theme and AnuPpuccin); this plan commits it, then migrates the remaining Sync Center hub hardcoded `rgba()` color channels to theme variables, and documents the two-theme + color-scan verification protocol. No behavior, copy, or feature changes.

**Tech Stack:** CSS (Obsidian theme variables), TypeScript (Obsidian `Setting`/`setIcon`), obsidian-cli screenshot verification, vitest (unchanged).

## Global Constraints

- **Zero hardcoded color** in `styles.css`: no hex literals, no hardcoded `rgba()` channels. The ONLY permitted literal in a color position is an opacity on a variable's `-rgb` companion, e.g. `rgba(var(--color-cyan-rgb), 0.15)`. A hex literal is a spec violation.
- **Theme-native** surfaces/controls/spacing: never override native component background/border/radius/height/font-size; use `--background-*`, `--text-*`, `--radius-*`, `--size-*`.
- **Semantic palette (verbatim mapping):** encrypt → `--color-cyan`; strip → `--color-red`; detected/caution → `--color-orange`; customized → `--text-accent`; neutral JSON key → `--color-blue`; JSON number/bool → `--color-green`; JSON string → `--text-muted`; outdated (hub) → `--color-pink`; transfer strip (hub) → `--color-cyan`; local strip (hub) → `--color-green`.
- Gate for every task: `npm run build && npm run lint` clean (lint baseline 0 errors / 65 warnings, do not add errors) and `npm test` green (202).
- Color-scan gate (objective test): `grep -nE "#[0-9a-fA-F]{6}|rgba\((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),\s*(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])," styles.css` must return NOTHING (no hex, no hardcoded rgb channels; only `rgba(var(--…-rgb), …)` remains).
- No Claude/AI attribution in commit messages.

---

### Task 1: Commit the config-panel design-system compliance (working tree)

**Files:**
- Modify: `src/ui/SettingTab.ts` (already-edited working tree — chevron as native `setIcon` prepended into `.setting-item`; `renderItemExpansion(parent, wrap, group, item)` inside the card; `renderDataFileSegment` pretty-printed JSON via `View data.json` link with `jsonOpen` persistence; `renderJsonPreview` real JSON with colored top-level keys; `renderAdvancedSegment` default-collapsed `advOpen` with `Location`/`Path`; badge order ⚠→⚙→device-specific; detect badge in a placeholder holder; lightweight chevron toggle; `commitGroups` filters blank-name rules; `renderGroupsError`/`commitGroups` suppress page-bottom error when a row culprit is set; `config-sync-ftag.is-detected`)
- Modify: `styles.css` (already-edited working tree — `.config-sync-item-wrap { display: contents }`; native chevron sizing; compact device dropdown; JSON box/keys/values on theme vars; `.config-sync-ftag.is-detected` → `--color-orange`; all config-panel semantic colors on `--color-*`)

**Interfaces:**
- Produces: a committed, design-system-compliant config panel. No new symbols.

- [ ] **Step 1: Verify the working tree builds, lints, and passes the color scan**

Run: `npm run build && npm run lint 2>&1 | grep problem`
Expected: build clean; `✖ 65 problems (0 errors, 65 warnings)`.

Run: `grep -cE "#[0-9a-fA-F]{6}" styles.css`
Expected: `0`.

- [ ] **Step 2: Run the full suite**

Run: `npm test 2>&1 | grep Tests`
Expected: `Tests  202 passed (202)`.

- [ ] **Step 3: Commit the working-tree changes**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "fix: config panel fidelity — theme-native styling, native chevron, real data.json view, collapsible Advanced, error dedup"
```

---

### Task 2: Migrate Sync Center hub semantic colors to theme variables

**Files:**
- Modify: `styles.css` (the `.config-sync-strip`, `.config-sync-strip.is-transfer`, `.config-sync-section.is-outdated`, `.config-sync-section.is-not-installed` rules)

**Interfaces:**
- Consumes: nothing.
- Produces: hub semantic accents that follow the theme palette.

- [ ] **Step 1: Confirm the current hardcoded channels are present (pre-change check)**

Run: `grep -nE "rgba\((125|91|214|232)," styles.css`
Expected: four lines — `.config-sync-strip` (125,200,125), `.is-transfer` (91,200,214), `.is-outdated` (214,123,181), `.is-not-installed` (232,176,75).

- [ ] **Step 2: Replace each hardcoded channel with its `-rgb` variable, keeping the opacities**

In `styles.css`, change these four rules to:

```css
.config-sync-strip { border: 1px solid rgba(var(--color-green-rgb), 0.35); background: rgba(var(--color-green-rgb), 0.07); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
.config-sync-strip.is-transfer { border-color: rgba(var(--color-cyan-rgb), 0.4); background: rgba(var(--color-cyan-rgb), 0.07); }
```

and for the section borders:

```css
.config-sync-section.is-outdated { border-color: rgba(var(--color-pink-rgb), 0.45); }
.config-sync-section.is-not-installed { border-color: rgba(var(--color-orange-rgb), 0.45); }
```

(Leave every other property on those rules unchanged.)

- [ ] **Step 3: Verify the semantic channels are gone**

Run: `grep -nE "rgba\((125|91|214|232)," styles.css`
Expected: no output.

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint 2>&1 | grep problem`
Expected: build clean; `0 errors, 65 warnings`.

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "style: bind Sync Center semantic accents to theme palette variables"
```

---

### Task 3: Migrate Sync Center hub surface tints to theme surface variables

**Files:**
- Modify: `styles.css` (the `rgba(255, 255, 255, …)` surface/border/scrim tints)

**Interfaces:**
- Consumes: nothing.
- Produces: hub raised surfaces and separators that follow the theme instead of a white overlay (which is near-invisible/wrong in light themes).

- [ ] **Step 1: Enumerate the white-overlay tints (pre-change check)**

Run: `grep -nE "rgba\(255, 255, 255" styles.css`
Expected: the rules on `.config-sync-pill.is-none`, `.config-sync-card`, `.config-sync-report-row`, `.config-sync-hub-row`, `button.is-busy::before`, `.config-sync-side-badge.is-none`, `.config-sync-switcher`.

- [ ] **Step 2: Replace each with the matching theme surface variable**

Apply these substitutions in `styles.css` (change only the listed color values):

```css
.config-sync-pill.is-none { background: var(--background-modifier-hover); color: var(--text-muted); }
.config-sync-card { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: var(--radius-m); padding: 0 var(--size-4-3); }
.config-sync-report-row { /* … keep other props … */ border-bottom: 1px solid var(--background-modifier-border); /* … */ }
.config-sync-hub-row { /* … keep other props … */ border-bottom: 1px solid var(--background-modifier-border); /* … */ }
button.is-busy::before { /* … keep other props … */ border: 2px solid var(--background-modifier-border); border-top-color: currentColor; /* … */ }
.config-sync-side-badge.is-none { background: var(--background-modifier-hover); color: var(--text-muted); }
.config-sync-switcher { /* … keep other props … */ background: var(--background-secondary); border: 1px solid var(--background-modifier-border); /* … */ }
```

For `.config-sync-report-row`, `.config-sync-hub-row`, `button.is-busy::before`, and
`.config-sync-switcher`, edit ONLY the color values shown; preserve every other declaration on
the rule (display, gap, padding, border-radius, animation, etc.) exactly as it was.

- [ ] **Step 3: Verify no white overlays remain and the full color scan is clean**

Run: `grep -nE "rgba\(255, 255, 255" styles.css`
Expected: no output.

Run: `grep -nE "#[0-9a-fA-F]{6}|rgba\((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),\s*(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])," styles.css`
Expected: no output (zero hardcoded color channels in the whole file).

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint 2>&1 | grep problem`
Expected: build clean; `0 errors, 65 warnings`.

- [ ] **Step 5: Commit**

```bash
git add styles.css
git commit -m "style: bind Sync Center surface tints to theme surface variables"
```

---

### Task 4: Wire the anti-drift color scan into the smoke checklist

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-settings-panel-design-system.md` (append a copy-paste scan command to the verification section)
- Create: `scripts/check-no-hardcoded-color.sh`

**Interfaces:**
- Produces: a one-command color scan the smoke step (and any future contributor) runs to catch a rule-2 violation before it ships.

- [ ] **Step 1: Create the scan script**

Create `scripts/check-no-hardcoded-color.sh`:

```bash
#!/usr/bin/env bash
# Fails if styles.css contains a hardcoded color (hex or hardcoded rgb channels).
# The only allowed color literal is an opacity on a variable's -rgb companion,
# e.g. rgba(var(--color-cyan-rgb), 0.15).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
hits="$(grep -nE '#[0-9a-fA-F]{6}|rgba\((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),\s*(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),' "$root/styles.css" || true)"
if [ -n "$hits" ]; then
  echo "Hardcoded color in styles.css (design-system rule 2 violation):"
  echo "$hits"
  exit 1
fi
echo "styles.css: no hardcoded color — OK"
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x scripts/check-no-hardcoded-color.sh && ./scripts/check-no-hardcoded-color.sh`
Expected: `styles.css: no hardcoded color — OK`.

- [ ] **Step 3: Reference it from the spec's verification protocol**

In `docs/superpowers/specs/2026-07-14-settings-panel-design-system.md`, under "Verification
protocol", change bullet 3 to name the script:

> 3. **Color scan** — `./scripts/check-no-hardcoded-color.sh` must pass; any hardcoded hex or
>    rgb channel is a rule-2 violation and blocks the change.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-no-hardcoded-color.sh docs/superpowers/specs/2026-07-14-settings-panel-design-system.md
git commit -m "chore: color-scan script enforcing the no-hardcoded-color design rule"
```

---

### Task 5: Two-theme visual verification (controller-run, no code)

**Files:** none (verification only).

This task has no code — it is the human-in-the-loop visual gate the spec mandates. The
controller (not a subagent, which cannot see rendered output) performs it against the live dev
vault, which already has AnuPpuccin installed.

- [ ] **Step 1: Deploy and reload** — `npm run smoke:install`, then reload the plugin in the dev vault (`config-sync` disable/enable) after the mandatory vault-name guard (`app.vault.getName()` must print `vault`).
- [ ] **Step 2: Screenshot the config panel and Sync Center in the DEFAULT theme** — Community-plugins tab with a row expanded (Fields + View data.json + Advanced), and the hub with a result strip / sections if reachable.
- [ ] **Step 3: Switch to AnuPpuccin (`app.customCss.setTheme('AnuPpuccin')`), reload, screenshot the same views.**
- [ ] **Step 4: Confirm** — in both themes: item cards are visually identical to General-tab settings and Advanced custom-rule cards (cross-tab consistency); semantic accents (encrypt/strip/detected, hub strips/sections) read correctly and follow each theme's palette; no element is legible in one theme but broken in the other.
- [ ] **Step 5: Restore the default theme** in the dev vault (`app.customCss.setTheme('')`) and record the verification result in the SDD ledger.

---

## Self-Review Notes

- Spec coverage: Rule 1 (theme-native) → Task 1 (config panel) + Task 3 (hub surfaces). Rule 2 (zero hardcoded color) → Tasks 1–3 + the scan in Task 4. Rule 3 + palette table → Tasks 1–2. Binding table → Task 1 (config panel already compliant). Migration backlog → Tasks 2–3. Verification protocol → Tasks 4–5.
- No behavior/feature/copy changes anywhere — every task is color/structure only; the node suite stays at 202 and is not modified.
- The reactive style/UX fixes already in the working tree (committed by Task 1) were made directly during the fidelity loop and never went through a per-task review — the final whole-branch review must cover them.
- Post-plan flow (per the user's explicit instruction): after all tasks + the final whole-branch review + full smoke, **hand the branch to the user for pre-merge acceptance; merge + cut 0.21.0 only after the user verifies**. Do not auto-merge.
