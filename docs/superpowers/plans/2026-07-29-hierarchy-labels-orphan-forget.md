# Hierarchy Labels + Orphan Snippet Forget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card-derived groups show `Parent › Name` in the Sync Center; orphaned snippet member rows get a `file deleted` pill, a Forget button, and an explanatory hint.

**Architecture:** One new pure function in `registry.ts` (parent resolution) surfaced through a new `displayParts` host method; render-layer changes in `SyncCenterView.ts` and `SettingTab.ts`; model change in `itemCard.ts` (`fileExists`); CSS in `styles.css`.

**Tech Stack:** TypeScript (Obsidian plugin), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-hierarchy-labels-orphan-forget-design.md` — copy strings and CSS verbatim-binding; mockup https://claude.ai/code/artifact/317e24c1-ec29-4ecd-9e03-574f53fa91d1 is 定稿.
- `displayName` must remain unchanged (backfillLabels persists it to the store manifest; the `Parent › Name` form must never be persisted).
- NO-COMMIT mode: leave all changes uncommitted; the controller commits at cut time. No Claude/AI attribution anywhere.
- Gates: `npm test` (all pass), `npm run lint` (0 errors, warnings ≤ baseline 67), `npm run build` clean.

---

### Task 1: Hierarchy labels

**Files:**
- Modify: `src/core/registry.ts` (near `compileCompanions`, ~line 275)
- Modify: `src/main.ts` (`displayName`, ~line 1022)
- Modify: `src/ui/SyncCenterView.ts` (host interface ~129, sort ~402, search ~1172, static rows ~1429, `renderItemRow` ~1492)
- Modify: `styles.css`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `configFor(settings, id)`, `basename`, `ItemDef`, `CompileSettings` (all already in `registry.ts`); `this.registryDefs: ItemDef[]` and `this.settings` in `main.ts`.
- Produces: `parentCardLabel(groupName, defs, settings): string | null`, `GroupDisplayParts { parent: string | null; label: string }`, host method `displayParts(group: string, storedLabel?: string): GroupDisplayParts` — Task 2 does not depend on them.

- [ ] **Step 1: registry.ts — pure parent resolution**

```ts
export interface GroupDisplayParts {
  parent: string | null;
  label: string;
}

// Parent card label for a card-derived group — an enabled companion (matched exactly the way
// compileCompanions emits group names) or the enabled-css-snippets switch list (governed by the
// Appearance card). null = standalone group. The Sync Center renders these as "Parent › Name";
// the composed form is display-only and must never be persisted (backfillLabels stores
// displayName's base label).
export function parentCardLabel(groupName: string, defs: ItemDef[], settings: CompileSettings): string | null {
  if (groupName === "enabled-css-snippets") return defs.find((d) => d.id === "appearance")?.label ?? "Appearance";
  for (const def of defs) {
    const cfg = configFor(settings, def.id);
    if (!cfg.enabled) continue;
    if (cfg.companions.some((c) => c.enabled && basename(c.path) === groupName)) return def.label;
  }
  return null;
}
```

- [ ] **Step 2: main.ts — displayParts**

Directly below `displayName` (which stays byte-identical):

```ts
displayParts(group: string, storedLabel?: string): GroupDisplayParts {
  return {
    parent: parentCardLabel(group, this.registryDefs, this.settings),
    label: this.displayName(group, storedLabel),
  };
}
```

Add `parentCardLabel`, `GroupDisplayParts` to the existing `registry` import in `main.ts`.

- [ ] **Step 3: SyncCenterView.ts — host interface + fullName helper**

In `SyncCenterHost`, under `displayName`:

```ts
displayParts(group: string, storedLabel?: string): GroupDisplayParts;
```

(import `GroupDisplayParts` from `../core/registry`). Add a private helper near the sort:

```ts
// Composed display string for sorting and search — parent prefix groups companions directly
// under their host card in name order.
private fullName(name: string, storedLabel?: string): string {
  const p = this.host.displayParts(name, storedLabel);
  return p.parent === null ? p.label : `${p.parent} › ${p.label}`;
}
```

- [ ] **Step 4: SyncCenterView.ts — sort, search, rendering**

Sort (~402) becomes:

```ts
return this.fullName(a.group.name, a.group.label).localeCompare(this.fullName(b.group.name, b.group.label));
```

Search (~1172): replace `this.host.displayName(r.group.name, r.group.label)` with `this.fullName(r.group.name, r.group.label)` inside the `matchesSearch` template.

`renderItemRow` (~1492): replace

```ts
row.createSpan({ cls: "config-sync-rule-name", text: this.host.displayName(group.name, group.label) });
```

with

```ts
this.renderRuleName(row, group.name, group.label);
```

and add the shared helper:

```ts
// Two-tone group name: faint "Parent › " prefix for card-derived groups, plain label otherwise.
private renderRuleName(row: HTMLElement, name: string, storedLabel?: string): void {
  const parts = this.host.displayParts(name, storedLabel);
  const el = row.createSpan({ cls: "config-sync-rule-name" });
  if (parts.parent !== null) {
    el.createSpan({ cls: "config-sync-rule-parent", text: parts.parent });
    el.createSpan({ cls: "config-sync-rule-parentsep", text: " › " });
  }
  el.appendText(parts.label);
}
```

Desktop-only static rows (~1429): replace the `config-sync-rule-name` span creation with `this.renderRuleName(row, r.group.name, r.group.label);`.

All other `displayName` call sites (self delta ~550, report `labelFor` ~1002/~1138, ConflictModal, backfill) stay untouched.

- [ ] **Step 5: styles.css**

Next to the existing `.config-sync-rule-name` rule:

```css
.config-sync-rule-parent, .config-sync-rule-parentsep { color: var(--text-faint); }
```

- [ ] **Step 6: tests/registry.test.ts**

Follow the file's existing helpers for defs/settings construction (it already tests `compileItems`; reuse its fixture style). Cases:

```ts
describe("parentCardLabel", () => {
  // build defs via buildItemDefs or the file's existing fixture env; settings with the
  // appearance item enabled and companions [{path: "{configDir}/themes", enabled: true},
  // {path: "{configDir}/snippets", enabled: true, ...}] per the existing ItemConfig shape.
  it("resolves a preset companion to its card label", () => {
    expect(parentCardLabel("snippets", defs, settings)).toBe("Appearance");
    expect(parentCardLabel("themes", defs, settings)).toBe("Appearance");
  });
  it("resolves enabled-css-snippets to Appearance", () => {
    expect(parentCardLabel("enabled-css-snippets", defs, settings)).toBe("Appearance");
  });
  it("returns null when the card or companion is disabled", () => {
    // settings variant with appearance cfg.enabled = false → null
    // settings variant with the snippets companion enabled: false → null
  });
  it("returns null for standalone groups", () => {
    expect(parentCardLabel("app", defs, settings)).toBeNull();
    expect(parentCardLabel("community-plugins", defs, settings)).toBeNull();
  });
  it("resolves a user-added companion on an enabled card", () => {
    // e.g. an excalidraw plugin card cfg with companions [{path: "scripts-folder/scripts", enabled: true}]
    // → that def's label
  });
});
```

(Exact fixture code adapts to the file's existing patterns — the assertions above are binding.)

- [ ] **Step 7: Gates** — `npm test && npm run lint && npm run build`. Expected: all tests pass, lint 0 errors (warnings ≤ 67), build clean.

- [ ] **Step 8: Report** — no commit (NO-COMMIT mode); report status + gate output.

---

### Task 2: Orphan snippet rows

**Files:**
- Modify: `src/ui/itemCard.ts` (`SnippetMemberRow`/`buildSnippetMemberRows` ~235-245, copy constants near `SNIPPET_MEMBER_HINT` ~233)
- Modify: `src/ui/SettingTab.ts` (`renderSnippetMembers` ~1627-1671)
- Modify: `styles.css`
- Test: `tests/itemCard.test.ts`

**Interfaces:**
- Consumes: `withSnippetScope`, `withDerivedMode`, `defaultSettingsFile`, `hasKeyRules`, `memberCountLabel`, `ENABLED_CSS_SNIPPETS_KEY`, `this.host.listSnippetFiles()`, `this.itemConfig`, `this.updateItem`, `this.refreshPathRow`, `this.refreshCardBadges`, `this.refreshCardBody` — all existing.
- Produces: `SnippetMemberRow.fileExists: boolean`; `SNIPPET_ORPHAN_HINT` constant.

- [ ] **Step 1: itemCard.ts — model + copy**

```ts
export const SNIPPET_ORPHAN_HINT =
  "A deleted file stays listed while it still has a device choice. Forget clears the choice — the next capture then removes the snippet from every device.";

export interface SnippetMemberRow {
  name: string;
  scope: RuleScope;
  fileExists: boolean;
}

// Union of files actually present under snippets/ and any name already scoped in
// perItem.enabledCssSnippets (so a scoped-but-since-deleted file doesn't just vanish from view —
// fileExists: false marks those orphans for the pill/Forget affordance).
export function buildSnippetMemberRows(fileNames: string[], perItem: PerItemScopes): SnippetMemberRow[] {
  const files = new Set(fileNames);
  const names = new Set([...fileNames, ...Object.keys(perItem)]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, scope: perItem[name] ?? "all", fileExists: files.has(name) }));
}
```

- [ ] **Step 2: SettingTab.ts — renderSnippetMembers**

Replace the method body per spec; the full target shape:

```ts
private renderSnippetMembers(listEl: HTMLElement, def: ItemDef, rows: SnippetMemberRow[], wrap: HTMLElement, countEl: HTMLElement | null, open: boolean): void {
  countEl?.setText(memberCountLabel(false, rows.filter((r) => r.fileExists).length));
  if (!open || rows.length === 0) return;
  const wrapEl = listEl.createDiv({ cls: "config-sync-card-snippetmembers" });
  for (const row of rows) {
    const r = wrapEl.createDiv({ cls: `config-sync-grid config-sync-card-companiongrid${row.fileExists ? "" : " is-orphan"}` });
    r.createSpan({ cls: "config-sync-ldname", text: row.name });
    if (!row.fileExists) r.createSpan({ cls: "config-sync-orphanpill", text: "file deleted" });
    const scopeCell = r.createDiv();
    let curScope = row.scope;
    const buildScope = (): void => {
      /* … existing renderScopeCycle block, byte-identical … */
    };
    buildScope();
    r.createDiv(); // state column — empty for a snippet member row
    const actionCell = r.createDiv();
    if (!row.fileExists) {
      const forget = actionCell.createEl("button", { cls: "config-sync-orphan-forget", text: "Forget" });
      forget.addEventListener("click", () => {
        void (async () => {
          const hadKeyRules = hasKeyRules(this.itemConfig(def.id));
          await this.updateItem(def.id, (c) => ({
            ...c,
            settingsFile: withDerivedMode(withSnippetScope(c.settingsFile ?? defaultSettingsFile(), row.name, "all")),
          }));
          if (hasKeyRules(this.itemConfig(def.id)) !== hadKeyRules) this.refreshPathRow(wrap, def);
          // The row leaves the union — rebuild the member zone in place (fresh file list +
          // fresh perItem), then the badge/body refreshes the scope cycle already does.
          const files = await this.host.listSnippetFiles();
          const perItem = this.itemConfig(def.id).settingsFile?.perItem[ENABLED_CSS_SNIPPETS_KEY] ?? {};
          listEl.empty();
          this.renderSnippetMembers(listEl, def, buildSnippetMemberRows(files, perItem), wrap, countEl, open);
          this.refreshCardBadges(wrap, def);
          this.refreshCardBody(wrap, def);
        })();
      });
    }
  }
  if (rows.some((r) => !r.fileExists)) wrapEl.createDiv({ cls: "config-sync-ldhint config-sync-orphanhint", text: SNIPPET_ORPHAN_HINT });
  wrapEl.createDiv({ cls: "config-sync-ldhint", text: SNIPPET_MEMBER_HINT });
}
```

Preserve the existing `buildScope` closure exactly (scope changes on an orphan row are legitimate). Import `SNIPPET_ORPHAN_HINT` alongside the existing `SNIPPET_MEMBER_HINT` import.

- [ ] **Step 3: styles.css**

Next to the existing companion-grid / ldhint rules:

```css
.config-sync-card-companiongrid.is-orphan .config-sync-ldname { color: var(--text-faint); text-decoration: line-through; }
.config-sync-orphanpill { font-size: var(--font-ui-smaller); color: var(--text-error); border: 1px solid var(--background-modifier-error); border-radius: 999px; padding: 0 7px; }
.config-sync-orphan-forget { font-size: var(--font-ui-smaller); }
.config-sync-orphanhint { color: var(--text-warning); }
```

- [ ] **Step 4: tests/itemCard.test.ts**

Update existing `buildSnippetMemberRows` assertions for the new field and add:

```ts
it("marks scope-only names as orphans", () => {
  const rows = buildSnippetMemberRows(["a.css"], { "gone.css": "mobile" });
  expect(rows).toEqual([
    { name: "a.css", scope: "all", fileExists: true },
    { name: "gone.css", scope: "mobile", fileExists: false },
  ]);
});
```

- [ ] **Step 5: Gates** — `npm test && npm run lint && npm run build`. Expected: all pass / 0 errors ≤ 67 warnings / clean.

- [ ] **Step 6: Report** — no commit; report status + gate output.

---

### Verification (controller-run, after both tasks)

Live smoke in the main vault (it already exhibits the orphan): settings → Appearance card →
snippets members show the `mystyle-mobile` orphan row with pill + Forget; Sync Center rows show
`Appearance › CSS snippets` / `Appearance › Themes` / `Appearance › CSS snippets on/off` sorted
under Appearance. Forget is NOT clicked during smoke unless the user asks — it mutates their
real config.
