# Settings Panel Design System (0.21.x)

The authoritative visual contract for the Config Sync settings panel and Sync Center. Its
purpose is to end the "implement → screenshot → user finds a divergence → patch → repeat"
loop by fixing the styling philosophy once, binding every custom color to a theme variable,
and requiring a screenshot-comparison gate before any UI change reaches the user.

Approved 2026-07-14 from real renderings in the default theme and AnuPpuccin
(`design-default.png`, `design-anup.png`).

## Three binding rules

1. **Theme-native surfaces, controls, and spacing.** The plugin adds *structure* only —
   rows, sections, the expansion drawer, custom badges. It reuses Obsidian's native
   components (`Setting`, native `DropdownComponent`, `ToggleComponent`, `TextComponent`)
   and **never overrides** their background, border, radius, height, or font-size. Cards are
   native `.setting-item` surfaces painted by the theme; `.config-sync-item-wrap` is
   `display: contents` so an item is indistinguishable from a General-tab setting. Result:
   every tab looks identical, and the panel is correct in any theme automatically.

2. **Zero hardcoded color.** No hex literals and no hardcoded `rgba()` color channels anywhere
   in `styles.css`. Every color is a `var(--…)`. The only permitted literal in a color
   position is an opacity applied to a variable's `-rgb` companion, e.g.
   `rgba(var(--color-cyan-rgb), 0.15)`. A hex literal in `styles.css` is a spec violation.

3. **Semantic colors bind to Obsidian's palette variables** so a meaning stays legible while
   its shade follows the theme. The semantic roles and their variables are the table below;
   these are the *only* colored accents the plugin introduces.

## Semantic palette (the complete set)

| Role (meaning) | Variable | Where it appears |
| --- | --- | --- |
| encrypt | `--color-cyan` | Fields editor "Encrypt" selected; JSON key with an encrypt rule; policy segment; result "state note" pill |
| strip | `--color-red` | Fields editor "Strip" selected; JSON key with a strip rule |
| detected / caution | `--color-orange` | `⚠ N keys` badge; `detected` field tag; `device-specific` badge; JSON key detected-but-unruled; JSON legend "detected"; Obsidian-version amber line; hub "Not installed" section |
| customized | `--text-accent` | `⚙ customized` badge; `View data.json` link; reset link |
| neutral JSON key | `--color-blue` | An un-ruled object key in the data.json view |
| JSON number/boolean | `--color-green` | Numeric/boolean values in the data.json view |
| JSON string value | `--text-muted` | String values (de-emphasized on purpose — they may be secrets) |
| outdated (hub) | `--color-pink` | Sync Center "Outdated on this device" section |
| success transfer (hub) | `--color-cyan` | Pull/Push result strip accent |
| success local (hub) | `--color-green` | Capture/Apply/Revert result strip accent |

Surfaces, borders, and text that are not semantic use the structural variables:
`--background-primary` / `--background-secondary` (raised surfaces like the JSON code box),
`--background-modifier-border` (borders/separators), `--background-modifier-hover`
(low-tint surfaces), `--text-normal` / `--text-muted` / `--text-faint` (text hierarchy),
`--radius-s|m` and `--size-*` (radius/spacing). Never a literal.

## Custom-element binding (structure + which variables)

- **Item card** — native `.setting-item`; wrap is `display: contents`. Chevron
  (`.config-sync-row-chevron`) is a native `setIcon("chevron-right/down")` prepended into the
  row, `--text-faint`. Expansion (`.config-sync-item-exp`) is `flex-basis: 100%` inside the
  same card, separated by a `--background-modifier-border` top rule.
- **Badges** — `.config-sync-detect-badge` / `.config-sync-devbadge` (orange tint),
  `.config-sync-cust` (`--text-accent`). Order after the name: `⚠ N keys` → `⚙ customized` →
  `device-specific`.
- **Mode segment** (`.config-sync-seg-btn`) and **field-rule Strip/Encrypt**
  (`.config-sync-act-btn`) — selected state uses the semantic variable (encrypt cyan / strip
  red), unselected `--text-muted`; the container border is `--background-modifier-border`.
- **View data.json** (`.config-sync-json-*`) — code box `background: --background-secondary`,
  `border: --background-modifier-border`; keys/values colored per the palette table.
- **Advanced sub-section** — default-collapsed, native chevron header; `Location` native
  dropdown + `Path` native text field (the same LOCATION/PATH pattern as Advanced-tab custom
  rules), plus the reset link.
- **Section headings, error lines, links** — `--text-*` and `--text-accent` only.

## Migration backlog (Sync Center hub — same rules, applied next)

These shipped in 0.20.0 and still contain hardcoded color channels; they are out of the
config-panel scope but must be migrated for full compliance (tracked, not done here):
`.config-sync-strip` green `rgba(125,200,125,…)` → `--color-green`;
`.config-sync-strip.is-transfer` cyan `rgba(91,200,214,…)` → `--color-cyan`;
`.config-sync-section.is-outdated` pink `rgba(214,123,181,…)` → `--color-pink`;
`.config-sync-section.is-not-installed` amber `rgba(232,176,75,…)` → `--color-orange`;
`rgba(255,255,255,0.0x)` surface tints on `.config-sync-card` / `.config-sync-hub-row` /
`.config-sync-switcher` / `.config-sync-side-badge.is-none` / `.config-sync-pill.is-none` →
`--background-secondary` / `--background-modifier-border` / `--background-modifier-hover`.
(The `rgba(255,255,255,0.3)` on the busy spinner border is a neutral scrim, acceptable, but
prefer `--background-modifier-border`.)

## Verification protocol (the anti-drift gate)

Before any UI-affecting change is shown to the user:

1. **Screenshot in a Catppuccin-class dark theme** (AnuPpuccin, installed in the dev vault)
   AND the default theme — the two must both look correct; a color that only works in one is
   a hardcoded-color smell.
2. **Cross-tab consistency check** — the changed element's card/row must be visually
   identical to a General-tab setting and an Advanced custom-rule card in the same screenshot.
3. **Color scan** — `./scripts/check-no-hardcoded-color.sh` must pass; any hardcoded hex or
   rgb channel is a rule-2 violation and blocks the change.
4. **Compare against the 定稿 gallery** screen-by-screen for the element's structure and copy
   (per the standing "replicate, don't approximate" rule).

Only after all four pass does the change go to the user.

## Testing

No new unit tests — this is CSS/structure. Enforcement is the hex scan (a one-line grep that
can live in the smoke checklist) plus the two-theme screenshot gate above. The existing node
suite (202 tests) is unaffected.

## Scope

This spec governs `styles.css` and the DOM-structure choices in `src/ui/SettingTab.ts` and
`src/ui/SyncCenterView.ts`. It does not change behavior, copy, or the feature set of 0.21.0 —
it is the visual contract those features are rendered through. The config-panel portion is
already compliant (this iteration); the hub migration backlog above is the remaining work.
