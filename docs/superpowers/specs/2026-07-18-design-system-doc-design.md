# Design system reference (docs/design/DESIGN.md)

User request 2026-07-18: persist every UI design decision — colors, type, icons,
components — as a browsable reference, so styling questions stop requiring code scans and
future work stays consistent. Findings surfaced during the audit become a dated decision
list for the user.

## Deliverable (定稿方案 a)

One canonical English document, `docs/design/DESIGN.md`:

- **Design tokens** — the semantic color map (direction, state, selection, warnings; each
  with its theme variable, rationale, and usage sites), the type scale (panel base
  `--font-ui-small`, `--font-ui-smaller` steps), spacing/radius conventions, and the
  checkbox-column geometry with its calibrated values.
- **Icon set** — state-column glyphs, mode badges (custom fields SVG / Lucide lock),
  Lucide icons used by ribbon/tabs/buttons, with semantics and 定稿 dates.
- **Component library** — every recurring component (pills, filter pills, sidebar entries,
  custom checkboxes, direction buttons, seg buttons, cards, sections, group headers,
  runline, modals): class name, code location, usage rules.
- **Conventions** — theme-variables-only, `body.is-mobile` scoping, mockup-定稿 workflow,
  probe-verified alignment.
- **Audit findings** — dated list of inconsistencies found while compiling; each awaits a
  user decision before any fix ships.

Maintenance rule: any UI 定稿/change updates DESIGN.md in the same branch — recorded in
the repo CLAUDE.md.

## Process

A subagent extracts the raw inventory (styles.css selectors with colors/sizes; all icon
usages across src/ui and main.ts, with file:line refs) to a scratch file; the curated
document is written from that inventory plus this session's 定稿 history. No behavior
changes ship with this branch — findings wait for decisions.
