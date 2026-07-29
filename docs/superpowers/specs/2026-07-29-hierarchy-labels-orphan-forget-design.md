# Sync Center Hierarchy Labels + Orphan Snippet Forget — Design

Mockup (定稿): https://claude.ai/code/artifact/317e24c1-ec29-4ecd-9e03-574f53fa91d1

## Goal

Two batched UX items:

1. **Hierarchy labels in the Sync Center.** A card-derived group — a companion folder
   (`themes/`, `snippets/`, any user-added folder) or the `enabled-css-snippets` switch list —
   shows in Sync Center lists as `Parent › Name` (e.g. `Appearance › CSS snippets`), the parent
   segment faint. Fixes the vocabulary gap where "To Capture: CSS snippets" has no findable
   counterpart in the settings panel, and — since lists sort by display name — groups companions
   directly under their host card.
2. **Orphan snippet member rows explain themselves.** When a snippet file is deleted but still
   has a per-item device choice, its member row (deliberately kept visible by
   `buildSnippetMemberRows`) gets: struck faint name, a `file deleted` pill, and a **Forget**
   button that clears the choice (= sets scope to All devices, which deletes the record and lets
   the next capture remove the entry from the store). A conditional warning hint explains the
   state. No automatic cleanup — the file's absence may be transient (mid-sync).

## Item 1: hierarchy labels

**Parent resolution (pure, `src/core/registry.ts`):**

```ts
export interface GroupDisplayParts { parent: string | null; label: string; }

// Parent card label for a card-derived group: an enabled companion (matched exactly the way
// compileCompanions emits group names — enabled cfg, enabled companion, basename(path)), or the
// enabled-css-snippets switch list (governed by the Appearance card). null = standalone group.
export function parentCardLabel(groupName: string, defs: ItemDef[], settings: CompileSettings): string | null;
```

- `enabled-css-snippets` → the `appearance` def's label.
- Companion match mirrors `compileCompanions` exactly: `cfg.enabled && companion.enabled &&
  basename(companion.path) === groupName`. First def wins (companionNameConflict already keeps
  basenames unique across items).
- Standalone cards, switch lists other than enabled-css-snippets, custom groups → null.

**Host (`src/main.ts` + `SyncCenterHost`):** new method
`displayParts(group: string, storedLabel?: string): GroupDisplayParts` returning
`{ parent: parentCardLabel(group, this.registryDefs, this.settings), label: this.displayName(group, storedLabel) }`.
`displayName` itself is UNCHANGED — `backfillLabels` persists it into the store manifest, and the
prefixed form must never be persisted (a stored `Parent › Name` label would feed back into
`displayParts` and double-prefix).

**Sync Center (`src/ui/SyncCenterView.ts`):** a private `fullName(name, label?)` helper composes
`parent › label` (plain string) for:
- the deterministic sort (line ~402),
- search matching (line ~1172, alongside the raw name),
and `displayParts` renders two-tone in:
- `renderItemRow` (~1492): name span becomes parent segment (cls `config-sync-rule-parent`) +
  `› ` separator (cls `config-sync-rule-parentsep`) + label text, all inside the existing
  `config-sync-rule-name` span,
- the desktop-only static section rows (~1429), same treatment.

Out of scope (keep base labels): self-pane delta rows, run-report `labelFor`, ConflictModal,
status-bar aria strings — report/aria surfaces read fine with the base label, and the store
manifest must stay prefix-free.

**CSS (`styles.css`):** `.config-sync-rule-parent, .config-sync-rule-parentsep { color: var(--text-faint); }`

## Item 2: orphan snippet rows

**Model (`src/ui/itemCard.ts`):**
- `SnippetMemberRow` gains `fileExists: boolean` (name present in the snippets-dir listing).
- `buildSnippetMemberRows` sets it from the fileNames set; union/order behavior unchanged.
- New copy constant (verbatim, mockup 终稿):

```ts
export const SNIPPET_ORPHAN_HINT =
  "A deleted file stays listed while it still has a device choice. Forget clears the choice — the next capture then removes the snippet from every device.";
```

**Render (`src/ui/SettingTab.ts` `renderSnippetMembers`):**
- Member count shows real files only: `memberCountLabel(false, rows.filter((r) => r.fileExists).length)`.
- Orphan row (`!row.fileExists`): row gains cls `is-orphan`; after the name span, a pill span
  cls `config-sync-orphanpill`, text `file deleted`; the action column (currently empty) renders
  a `Forget` button (cls `config-sync-orphan-forget`). The scope icon stays interactive —
  keeping the choice is a valid response to a transient absence.
- Forget click: same write path as the scope cycle with `"all"`
  (`withSnippetScope(…, row.name, "all")` under `withDerivedMode`, `hasKeyRules` path-row
  refresh), then re-list snippet files and re-render the member zone in place
  (`listEl.empty()` + fresh `buildSnippetMemberRows`), then `refreshCardBadges` +
  `refreshCardBody`. The row disappears; the resulting live≠store difference surfaces as a
  normal To Capture which removes the store entry.
- Hint: when any orphan row exists, a warning-toned hint div (cls
  `config-sync-ldhint config-sync-orphanhint`, text `SNIPPET_ORPHAN_HINT`) renders ABOVE the
  existing always-on `SNIPPET_MEMBER_HINT`.

**CSS (`styles.css`):**

```css
.config-sync-card-companiongrid.is-orphan .config-sync-ldname { color: var(--text-faint); text-decoration: line-through; }
.config-sync-orphanpill { font-size: var(--font-ui-smaller); color: var(--text-error); border: 1px solid var(--background-modifier-error); border-radius: 999px; padding: 0 7px; }
.config-sync-orphan-forget { font-size: var(--font-ui-smaller); }
.config-sync-orphanhint { color: var(--text-warning); }
```

## Testing

- `tests/registry.test.ts`: `parentCardLabel` — preset companion → "Appearance"; user-added
  companion on an enabled card → that card's label; disabled card / disabled companion → null;
  `enabled-css-snippets` → "Appearance"; standalone group ("app", a plugin group) → null.
- `tests/itemCard.test.ts`: `buildSnippetMemberRows` — `fileExists` true for listed files, false
  for scope-only names; union/order/scope behavior unchanged (update existing assertions for the
  new field).
- Gates: `npm test`, `npm run lint` (0 errors, warnings ≤ baseline 67), `npm run build`.
- Live smoke (controller): main-vault state already exhibits the orphan (`mystyle-mobile`
  scoped mobile, file deleted) — verify pill+Forget render, Forget clears the record, a
  To Capture appears for Appearance, and the Sync Center shows `Appearance › …` rows.

## Compatibility & docs

- No data-model change; store manifest labels unchanged. Minor-version semantics (2.7.0).
- README (+zh) / ARCHITECTURE / DESIGN currency per docs-currency rule before any cut:
  hierarchy-label rule and orphan-row affordance.
