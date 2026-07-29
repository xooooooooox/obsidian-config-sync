# Product Polish Audit — Design

Date: 2026-07-29. Scope: this repo (Config Sync). A sibling audit with the same rubric runs in ribbon-organizer (which additionally renames its display name and gains a DESIGN.md).

## Goal

Three audits over the current tree (2.7.2), producing a findings report — no code changes until the owner adjudicates:

1. **Copy audit** — every user-visible string (settings panels, Sync Center view, modals, notices, buttons, tooltips, command names, manifest description) against the product-voice rule below.
2. **Design-compliance audit** — styles and icons in `styles.css` + `src/ui/*` against `docs/design/DESIGN.md`, in both directions:
   - code that violates DESIGN (styles, icon choices, spacing, mobile patterns);
   - DESIGN entries that the 2.6–2.7 iterations left behind (audit close-out, hierarchy labels, orphan Forget, phone section heads, where-it-runs icons) — outdated or missing principles get flagged for update.
3. **Docs-currency audit** — README.md, README.zh.md, docs/ARCHITECTURE.md, docs/design/DESIGN.md, CLAUDE.md checked section-by-section against current behavior; stale claims and undocumented features get flagged. (Known standing item: README screenshots are queued separately and stay out of this audit.)

Adjudicated fix batch ships as one cut; patch vs minor decided by what the owner accepts.

## Product-voice rule (rubric for the copy audit)

- UI copy speaks the user's language, not the implementation's: no internal identifiers (`data.json`, `qualifier`, observer, CSS class names, setting keys) unless the surface is explicitly a developer tool. Established exception: surfaces whose subject IS the config file (e.g. a diff of a plugin's settings file) may name it, but prefer the product term already in use.
- Narrate by device and consequence ("applies on this phone only"), not by mechanism.
- Controls say what happens; notices confirm what happened; errors say what failed and what to do.
- Sentence case per Obsidian guidelines; brand names keep their casing.

## Process

Findings report format per item: location (`file:line`) · current text/style · principle violated · proposed fix (for copy: the exact replacement string, which is the candidate final copy). Layout-affecting proposals additionally get a mockup before implementation; pure copy, DESIGN-text, and doc corrections do not.

Owner adjudicates item-by-item or in batches; accepted items are applied in one fix batch; then the cut.

## Out of scope

README screenshots; behavior changes; the parked backlog (cold-start version-refresh, BRAT downloader, interruption robustness, history diff).
