# Docs Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a docs-currency rule (convention + memory) and bring the stale docs (`README.md`, `README.zh.md`, `docs/ARCHITECTURE.md`, `docs/design/DESIGN.md`) current to 1.3.0.

**Architecture:** Two parts. Part A adds the rule to `CLAUDE.md` (+ a controller-written feedback memory). Part B rewrites the four stale docs, using the code and the 1.1.0→1.3.0 GitHub release notes as the source of truth. No code, no automated tests — verification is a cross-check that every documented feature maps to a real `src/` component.

**Tech Stack:** Markdown only.

## Global Constraints

- **Source of truth:** the code in `src/` + the hand-written GitHub release notes for 1.1.0–1.3.0. Every feature named in a doc MUST map to a real component; do not invent behavior. When unsure of current UI wording, grep `src/`.
- **Bilingual sync:** `README.md` and `README.zh.md` are currently heading-for-heading identical (same line numbers). Keep them structurally 1:1 — `README.zh.md` is a faithful translation of the final `README.md`, same sections in the same order.
- **Privacy:** no real paths/usernames/secrets in artifacts — `~/…` and placeholders only (the READMEs already follow this).
- **Feature set to reflect (1.1.0→1.3.0), each verified against a component:** qualifier search + autocomplete (`src/ui/qualifierSearch.ts`); Sync Center header status bar / self chip + push-pull totals (`SyncCenterView.renderHeader`, `remoteDirectionCounts`); self "this-device" pane (Settings button + expandable "view change"); Beta/BRAT plugin tab; distinct action icons (`src/ui/actionIcons.ts`); snippet re-scope + orphan cleanup.

---

### Task 1: Prevention — CLAUDE.md rule + feedback memory

**Files:**
- Modify: `CLAUDE.md` (after line 43, the last bullet in `## Rules`)

**Interfaces:**
- Produces: a durable "Documentation currency" rule that later doc-review gates (finish/cut) reference.

- [ ] **Step 1: Add the rule to `CLAUDE.md`**

Insert a new bullet immediately after the existing DESIGN.md bullet (line 43), matching the terse imperative style of the surrounding `## Rules` bullets:

```markdown
- Documentation currency: when a change alters user-facing behavior (features, UI, commands, settings, workflows), update the affected docs in the SAME branch — `README.md` and `README.zh.md` (keep the two in sync), `docs/ARCHITECTURE.md` (code map / invariants, when structure changes), and `docs/design/DESIGN.md` (per the rule above). Pure internal refactors that change nothing a user sees need no doc edit. Gate: docs must be current before merging to `main` and before cutting a release.
```

- [ ] **Step 2: Verify the edit**

Run: `grep -n "Documentation currency" ~/local/coding/open/obsidian-config-sync/CLAUDE.md`
Expected: one match on the new line, inside the `## Rules` section.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add documentation-currency rule to CLAUDE.md"
```

**Controller note (not a subagent step):** alongside this task, the controller writes a `feedback`-type memory `docs-currency-before-merge` (rule + why: docs have drifted repeatedly through 1.1.0–1.3.0 + how to apply: check before merge/push/cut), linking `[[ui-changes-need-mockup]]` and `[[config-sync-cut-release-notes]]`. The memory is outside the repo; it is not part of the git commits.

---

### Task 2: README.md → 1.3.0

**Files:**
- Modify: `README.md` (Features L12–22, How-it-works L35–76, Settings-guide L77–84, Walkthroughs L122+, Sensitive-settings L152–165)

**Interfaces:**
- Consumes: the feature set from Global Constraints.
- Produces: the canonical English README that Task 3 translates.

- [ ] **Step 1: Features section (L12–22) — add the 1.1.0–1.3.0 headline features**

Add bullets (matching the existing terse bullet style) covering: the unified Sync Center header status bar (self "this-device" chip + all-action totals incl. per-remote push/pull); qualifier search in both search boxes; the self pane for Config Sync's own state; the Beta plugin tab; distinct per-action icons. Fix the existing L18 bullet's "live `↑`/`↓` change-count badges" framing to reflect that each action (Capture/Apply/Push/Pull) now has its own icon (verify names against `src/ui/actionIcons.ts` `ACTION_ICON`).

- [ ] **Step 2: How it works — Sync Center search (rewrite L73)**

Replace the L73 "Filter by name…" description. Keep the literal placeholder `Filter by name…` (confirmed unchanged in `SyncCenterView.ts`), but rewrite the behavior to add qualifier search: it accepts `key:value` qualifiers — `type:` (file/folder), `scope:` (obsidian/core/community/beta/custom), `action:` (capture/apply/ok/none), `mode:` (plain/fields/encrypted), `device:` (all/desktop/mobile) — which AND together and combine with free text, with an autocomplete dropdown suggesting keys then values. Keep the existing "hit count per scope / sections auto-expand" clause.

- [ ] **Step 3: How it works — add the header status bar + self pane**

In the How-it-works section (L35–76), add a short paragraph/bullets describing: (a) the Sync Center header status bar — the self chip (green check when in sync; otherwise status + a Settings shortcut) followed by pending-action totals including per-remote push/pull counts; (b) the self "this-device" pane — Config Sync's own sync state, a title-row **Settings** button, and an expandable "view change" revealing the device's own `data.json` delta.

- [ ] **Step 4: Settings guide — fix the tab list + search description (rewrite L80)**

Add **Beta** to the enumerated picker tabs (`Obsidian / Core plugins / Community plugins / Beta`), and rewrite "a global search box with scope filters" to note the `Search all settings…` box now also supports `scope:` (general/obsidian/core/community/advanced/remotes) and `type:` (file/folder) qualifiers with autocomplete. Add a one-line description of what the **Beta** tab does (manage/track BRAT beta plugins) — verify against `SettingTab.ts` tab list and the Beta tab code.

- [ ] **Step 5: Ribbon + mode-badge lines (L69, L162)**

L69: update the "`↑`/`↓` change counts" wording consistent with Step 1's distinct-icon framing. L162: verify the current mode-badge representation against `docs/design/DESIGN.md` §2.2 (`.config-sync-mode-badge`) and `src/ui/` before rewriting `🔒`/`▤` — replace with whatever the badges actually render now.

- [ ] **Step 6: Snippet walkthrough (L122+) — add re-scope + orphan cleanup**

In the CSS-snippets walkthrough (L124–125), add that a snippet's device scope (all/desktop/mobile) is per-device and re-scopable, and that orphaned enabled-snippet names (left after renames) surface a "N enabled snippets have no file · Clean up" action. Verify against the 1.2.0 release notes + snippet code.

- [ ] **Step 7: Verify**

Run: `grep -niE "qualifier|type:folder|scope:community|Beta|status bar|this.device|autocomplete" ~/local/coding/open/obsidian-config-sync/README.md`
Expected: matches present for qualifier search, Beta tab, status bar, self pane. Then re-read the changed sections to confirm no remaining `↑`/`↓`-only "shared glyph" framing and no removed/renamed UI.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: bring README.md current to 1.3.0"
```

---

### Task 3: README.zh.md → 1.3.0 (mirror README.md)

**Files:**
- Modify: `README.zh.md`

**Interfaces:**
- Consumes: the final `README.md` from Task 2 (translate its new/changed sections).

- [ ] **Step 1: Mirror every Task 2 change in Chinese**

For each section Task 2 changed (Features L12, How-it-works L35, Settings-guide L77, Walkthroughs L122, Sensitive-settings L152), apply the equivalent Chinese edit. Keep code identifiers, qualifier keys (`type:`/`scope:`/`action:`/`mode:`/`device:`), and placeholder strings (`Filter by name…`, `Search all settings…`) in English/verbatim per the repo's bilingual convention. Preserve heading-for-heading parity with `README.md`.

- [ ] **Step 2: Verify structural parity**

Run: `diff <(grep -nE '^#{1,3} ' ~/local/coding/open/obsidian-config-sync/README.md) <(grep -nE '^#{1,3} ' ~/local/coding/open/obsidian-config-sync/README.zh.md)`
Expected: same number of headings at the same line numbers (only the heading TEXT differs by language). If line numbers drift, reconcile so the two stay 1:1.

- [ ] **Step 3: Verify content coverage**

Run: `grep -niE "qualifier|type:folder|scope:community|Beta|autocomplete" ~/local/coding/open/obsidian-config-sync/README.zh.md`
Expected: the qualifier/Beta terms present (in the English tokens kept verbatim).

- [ ] **Step 4: Commit**

```bash
git add README.zh.md
git commit -m "docs: mirror README.zh.md to 1.3.0"
```

---

### Task 4: ARCHITECTURE.md + DESIGN.md → 1.3.0

**Files:**
- Modify: `docs/ARCHITECTURE.md` (Module map UI block L86–96)
- Modify: `docs/design/DESIGN.md` (Component library L106–141; audit date L155)

**Interfaces:**
- Consumes: the component list from Global Constraints.

- [ ] **Step 1: ARCHITECTURE.md — module map UI block (L86–96)**

Add entries in the **UI (`src/ui/`)** block for: `actionIcons.ts` (single source for per-action Lucide icons + color classes — Capture/Apply/Push/Pull), `qualifierSearch.ts` (pure `key:value` parser + matcher + suggestion generator, and the `QualifierAutocomplete` DOM widget shared by both search boxes). Update the `SyncCenterView.ts` entry (L87–88) to mention the header status bar / self pane, and the `SettingTab.ts` entry (L89–90) to add **Beta** to its tab enumeration. Match the existing `` - `File.ts` — description.`` format.

- [ ] **Step 2: DESIGN.md — component library (L106–141)**

Add two entries in `## 3. Component library`, matching the `- **Name** \`class/-subclass\` — description.` format: the **self pane** (self chip in the header + the pane's Settings button + expandable data.json "view change"; verify class names against `styles.css`/`SyncCenterView.ts`) and the **qualifier autocomplete** (`config-sync-qac/-qac-opt/-qac-ic/-qac-txt/-qac-desc` dropdown; verify against `styles.css`). Note the header status bar if not already covered.

- [ ] **Step 3: DESIGN.md — bump audit date (L155)**

If the 2026-07-18 audit findings are unchanged, leave the findings but note the doc was reviewed for 1.3.0; if nothing else, this task's edits close the "trails 1.3.0" gap. Do not fabricate new audit findings — only update currency.

- [ ] **Step 4: Verify**

Run: `grep -niE "actionIcons|qualifierSearch|config-sync-qac|status bar|self pane|Beta" ~/local/coding/open/obsidian-config-sync/docs/ARCHITECTURE.md ~/local/coding/open/obsidian-config-sync/docs/design/DESIGN.md`
Expected: the new module/component references present in both files.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/design/DESIGN.md
git commit -m "docs: ARCHITECTURE + DESIGN current to 1.3.0"
```

---

## Self-Review

**Spec coverage:** Part A (prevention) → Task 1 (CLAUDE.md rule + controller memory). Part B (remediation): README.md → Task 2, README.zh.md → Task 3, ARCHITECTURE.md + DESIGN.md → Task 4. AGENTS.md is deferred per the spec — not in this plan. All spec sections mapped.

**Placeholder scan:** each doc edit names a concrete feature, an exact line/section target, and a verification grep. No "add appropriate content" vagueness — the *facts* to add are enumerated; only the final prose is composed at write time (inherent to docs). Every step carries a "verify against the code/release-notes" instruction so nothing is invented.

**Consistency:** README.md (Task 2) is written before README.zh.md (Task 3) so the translation mirrors a settled English source; the structural-parity diff in Task 3 Step 2 enforces the 1:1 heading rule. The feature list in Global Constraints is the single vocabulary used across all four docs, so the same features are described consistently everywhere.
