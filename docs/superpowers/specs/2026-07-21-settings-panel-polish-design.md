# Settings-panel polish: preset-rule row + folder-item data-file link

Three small, self-contained fixes in the item settings panel
(`src/ui/SettingTab.ts`), all element **removals/swaps** of things that are
misleading in their current form. No behavior change beyond what renders.

## 1. No remove-X on preset (locked) field rules

`renderFieldsEditor` (`:1088`) renders a remove `X` button for every field
rule, but for a **locked** preset rule (e.g. Appearance's `enabledCssSnippets`)
it renders the X **disabled** with tooltip "Preset rule — cannot be removed".
The 🔒 lock icon at the row start already conveys "can't remove", so a greyed-out
X is redundant noise.

**Decision:** for a locked rule, do not construct the X button at all. To keep
the `Strip`/`Encrypt` action buttons column-aligned with unlocked rows (which do
carry a trailing X), render an empty placeholder occupying the icon button's
width instead.

- Current (`:1088-1101`): always `new ExtraButtonComponent(fr).setIcon("x")
  .setTooltip(...).setDisabled(rule.locked === true).onClick(...)`.
- New: `if (rule.locked === true) { fr.createSpan({ cls:
  "config-sync-fieldrow-xspacer" }); } else { new ExtraButtonComponent(fr)
  .setIcon("x").setTooltip("Remove rule").onClick(() => { ... }); }` — the
  `onClick` body is unchanged except the now-unreachable `if (rule.locked ===
  true) return;` guard is dropped (the button only exists when unlocked).
- CSS (`styles.css`): `.config-sync-fieldrow-xspacer` — `flex: none`, width and
  height matching the `ExtraButtonComponent` icon button (so the action buttons
  line up across locked and unlocked rows). Theme vars / no color needed
  (invisible spacer).

## 2. Swap the preset-rule lock 🔒 emoji for a Lucide icon

Same row (`:1051`) renders the lock as the literal `🔒` emoji via
`fr.createSpan({ cls: "config-sync-flock", text: "🔒" })`. DESIGN.md §148
mandates no emoji — Lucide via `setIcon`.

**Decision:** render it with `setIcon`:

```ts
if (rule.locked === true) {
  const lock = fr.createSpan({ cls: "config-sync-flock", attr: { "aria-label": "Preset rule — cannot be removed" } });
  setIcon(lock, "lock");
  lock.setAttribute("title", "Preset rule — cannot be removed");
}
```

- `setIcon` is already imported in this file (used elsewhere for icons); confirm
  and add to the import if missing.
- CSS: `.config-sync-flock svg` sized to match the former glyph (small, inline,
  `--text-muted`); adjust the existing `.config-sync-flock` rule from a
  text-glyph size to an svg icon. Theme vars only (no hardcoded color).

## 3. Hide "View data.json" for folder-type items

`renderItemExpansion` (`:589`) always calls `renderDataFileSegment`, which draws
`Data file · View data.json ▸` (`:772`). For a **folder**-type item (`group.type
!== "file"`, e.g. CSS snippets, Type = Folder) there is no single `data.json` —
it is a directory of files — so the link is meaningless (its
`readItemFile(group)` has nothing coherent to show). Folder items also carry no
`mode`/`fields` (deleted on type change, `:896-899`), so the data-file/JSON
key-rule affordance has no purpose for them.

**Decision:** render the data-file segment only for file-type items.

- At `:589`, gate the call:
  `if (group.type === "file") this.renderDataFileSegment(exp, group, item, wrap);`
- `renderCustomLocationSegment` still renders for all types — you need it to
  change the Location/Path/Type (including switching a folder item back to
  file). Unchanged.
- If a `group.type` is stale-open in `this.jsonOpen` when it becomes a folder,
  the segment simply isn't drawn; the flag is harmless (transient UI state) and
  needs no cleanup.

## Testing

These are rendering conditionals, not new logic — verification is live.

- **Live (dev vault):**
  - **Locked rule (Appearance → Fields → `enabledCssSnippets`):** no X button
    on the row; the lock renders as a Lucide `lock` svg (not the emoji); the
    `Strip`/`Encrypt` buttons align with a manually-added (unlocked) rule's
    buttons on the row below (add a temporary manual key to compare, then
    remove it).
  - **Unlocked rule:** still shows a working X that removes the rule.
  - **Folder item (CSS snippets, Type = Folder):** the expansion shows no
    "Data file · View data.json" line; Custom location still shows and can
    switch Type back to File. After switching to File, the "View data.json"
    line reappears.
  - **File item (any Fields-mode item):** "View data.json" still shows and
    opens the JSON preview as before.
  - Desktop 390×844: rows fit without overflow.
- **Gates:** `npx tsc -noEmit -skipLibCheck` clean, `npm test` green (no new
  unit tests — pure rendering conditionals), `npx eslint .` **0 errors / 67
  warnings**, `./scripts/check-no-hardcoded-color.sh` OK, `npm run build` clean.

## Non-goals

- No change to what a preset rule *does* (still locked to Strip/Encrypt via
  `ensureSelfPresets`); only its row chrome (no X, Lucide lock) changes.
- No change to file-type items' data-file/JSON preview.
- No change to the switch-list groups' expansion (already bypasses these
  segments, `:574-579`).
- No new host-interface methods; entirely view-local to `SettingTab.ts` + CSS.
