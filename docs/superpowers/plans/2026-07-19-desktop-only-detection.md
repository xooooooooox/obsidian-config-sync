# Desktop-only Plugin Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect `isDesktopOnly` at capture, record it in the lock, and on mobile bucket those plugins into an informational "Desktop-only" section (with a `desktop-only` pill on desktop) instead of offering a failing install.

**Architecture:** Three pure-core/panelModel changes TDD'd against the in-memory FileIO + fake plugin host (capture records the flag; `Availability` carries it; `sectionForItem` buckets it on mobile), then two view changes (an informational section renderer + a row pill) verified live in the dev vault. The data model changes by exactly one optional lock field; the user's `devices` setting is untouched.

**Tech Stack:** TypeScript, vitest, esbuild. Live checks via obsidian-cli against `dev/vault/`.

## Global Constraints

- **Data model change is exactly one optional lock field**: `store.lock.json` group entries gain `desktopOnly?: boolean`, recorded only when true. Nothing else changes; `data.json` and the `devices` field are untouched.
- **Two separate axes**: `isDesktopOnly` (plugin run-capability, author-declared) is never written into `devices` (user's sync-scope choice).
- **Mobile desktop-only section is informational**: no checkbox, no install/enable/apply, never counted in pills/footer/sidebar, never stageable; settings not applied.
- **Desktop pill**: independent small pill, amber outline (`--color-orange`), text `desktop-only`; not tied to the settings-tab `device-specific` badge.
- **Graceful degradation**: a store captured before this feature has no flag → those plugins stay in "Not installed" until re-captured on desktop. No migration.
- Gates each task keeps green: `npm test`, `npx eslint .` at **0 errors / 67 warnings**, `./scripts/check-no-hardcoded-color.sh`. New CSS uses theme vars + `body.is-mobile`/`is-phone` scoping.
- Never commit unless the executing user asks; no Claude/AI attribution.

---

## File Structure

- **Modify** `src/core/ConfigSyncCore.ts` — `PluginHost.isDesktopOnly(id)`; capture records `desktopOnly`.
- **Modify** `src/main.ts` — implement `isDesktopOnly`; extend the `CommunityPluginRegistry` manifest value type with `isDesktopOnly?: boolean`.
- **Modify** `src/core/types.ts` — lock group entry gains `desktopOnly?: boolean`.
- **Modify** `src/core/availability.ts` — `Availability.desktopOnly`; read it from the lock.
- **Modify** `src/ui/panelModel.ts` — `SectionKind` += `"desktop-only"`; titles/notes; `sectionForItem(a, isMobile)`; `stageableRow`.
- **Modify** `src/ui/SyncCenterView.ts` — bucket + informational section renderer; the row pill; pass `Platform.isMobile`.
- **Modify** `styles.css` — the `desktop-only` pill rule.
- **Modify** `tests/memfs.ts` — `FakePlugins.isDesktopOnly`.

---

## Task 1: Capture detects + records `desktopOnly`

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (`PluginHost`, `capture`), `src/main.ts`, `src/core/types.ts`, `tests/memfs.ts`
- Test: `tests/core.test.ts`

**Interfaces:**
- Produces: `PluginHost.isDesktopOnly(id: string): boolean`; lock group entry `{ sourcePluginVersion?; sourceAppVersion?; desktopOnly?: boolean }`.

- [ ] **Step 1: Add `isDesktopOnly` to `FakePlugins`** (`tests/memfs.ts`) so tests can flag a plugin:

```ts
// in FakePlugins:
desktopOnlyIds = new Set<string>();
isDesktopOnly(id: string): boolean { return this.desktopOnlyIds.has(id); }
```

- [ ] **Step 2: Write the failing test** (`tests/core.test.ts`, in the `describe("capture", …)` block):

```ts
it("records desktopOnly in the lock for a desktop-only plugin", async () => {
  const { io, plugins, ctx } = setup();
  plugins.installed.set("demo", "1.2.3");
  plugins.desktopOnlyIds.add("demo");
  io.seed({ ".obs/plugins/demo/data.json": "{}", ".obs/hotkeys.json": "{}", ".obs/snippets/one.css": "x", ".obsidian.vimrc": "v" });
  await seedGroups(ctx, MANIFEST);
  await capture(ctx);
  const lock = JSON.parse(await io.read("cs/store.lock.json")) as { groups: Record<string, { sourcePluginVersion?: string; desktopOnly?: boolean }> };
  expect(lock.groups["plugin-demo"]).toEqual({ sourcePluginVersion: "1.2.3", desktopOnly: true });
  expect(lock.groups["hotkeys"]?.desktopOnly).toBeUndefined(); // app-anchored: never flagged
});
```

- [ ] **Step 3: Run to verify it fails** — `npx vitest run -t "records desktopOnly"` → FAIL (`isDesktopOnly` not on `PluginHost` / flag absent).

- [ ] **Step 4: Add `isDesktopOnly` to `PluginHost`** (`ConfigSyncCore.ts`, next to `getInstalledPluginVersion`):

```ts
isDesktopOnly(id: string): boolean;
```

- [ ] **Step 5: Extend the lock type** (`types.ts`):

```ts
groups: Record<string, { sourcePluginVersion?: string; sourceAppVersion?: string; desktopOnly?: boolean }>;
```

- [ ] **Step 6: Record it in `capture`** (`ConfigSyncCore.ts:186`) — replace the lock write:

```ts
lock.groups[group.name] = ctx.plugins.isDesktopOnly(pluginId)
  ? { sourcePluginVersion: version, desktopOnly: true }
  : { sourcePluginVersion: version };
```

- [ ] **Step 7: Implement the host method** (`main.ts`, in `pluginHost()`):

```ts
isDesktopOnly: (id) => registry.manifests[id]?.isDesktopOnly === true,
```
and extend the manifest value type on `CommunityPluginRegistry`:
```ts
manifests: Record<string, { id: string; name: string; version: string; isDesktopOnly?: boolean }>;
```

- [ ] **Step 8: Run + gates** — `npx vitest run` all pass; `npx tsc -noEmit -skipLibCheck` exit 0; `npx eslint .` 0 errors / 67 warnings.

- [ ] **Step 9: Commit (only if the user asked)** — `git commit -m "core: record desktopOnly in the lock at capture"`

---

## Task 2: `Availability` carries `desktopOnly`

**Files:**
- Modify: `src/core/availability.ts`
- Test: `tests/availability.test.ts`

**Interfaces:**
- Consumes: lock group entry `desktopOnly` (Task 1).
- Produces: `Availability.desktopOnly: boolean`.

- [ ] **Step 1: Write the failing test** (`tests/availability.test.ts`):

```ts
it("carries desktopOnly from the lock (plugin groups only)", () => {
  const p = new FakePlugins();
  p.installed.set("demo", "2.2.1");
  const on = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1", desktopOnly: true } }));
  expect(on.desktopOnly).toBe(true);
  const off = availabilityForGroup(pluginGroup, p, lock({ "plugin-demo": { sourcePluginVersion: "2.2.1" } }));
  expect(off.desktopOnly).toBe(false);
  p.appVersion = "1.8.7"; p.coreEnabled.add("daily-notes");
  expect(availabilityForGroup(coreGroup, p, null).desktopOnly).toBe(false); // app-anchored
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run -t "carries desktopOnly"` → FAIL (`desktopOnly` missing).

- [ ] **Step 3: Add the field** to the `Availability` interface (`availability.ts`): `desktopOnly: boolean;`. Set it in both return paths:
  - plugin-anchored: `desktopOnly: lock?.groups[group.name]?.desktopOnly === true`
  - app-anchored: `desktopOnly: false`

- [ ] **Step 4: Fix existing `toEqual` expectations** in `tests/availability.test.ts` that assert the full object — add `desktopOnly: false` to those literals (the plugin `enabled`/`disabled`/`not-installed` and both app-anchored cases).

- [ ] **Step 5: Run + tsc** — target test + full suite pass; tsc clean.

- [ ] **Step 6: Commit (if asked)** — `git commit -m "core: availability exposes desktopOnly from the lock"`

---

## Task 3: `sectionForItem` buckets desktop-only on mobile

**Files:**
- Modify: `src/ui/panelModel.ts` (`SectionKind`, `SECTION_TITLES`, `SECTION_NOTES`, `sectionForItem`, `stageableRow`)
- Modify: `src/ui/SyncCenterView.ts:315` (caller), `tests/panelModel.test.ts` (callers + `avail` helper)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Consumes: `Availability.desktopOnly` (Task 2).
- Produces: `sectionForItem(a: Availability, isMobile: boolean): SectionKind`; `SectionKind` includes `"desktop-only"`.

- [ ] **Step 1: Write the failing tests** (`tests/panelModel.test.ts`, in the `sectionForItem` describe). The file's `avail(...)` helper builds `Availability` — first give it a `desktopOnly: false` default so it stays valid:

```ts
it("buckets a not-installed desktop-only plugin into desktop-only on mobile only", () => {
  const a = avail({ kind: "not-installed", desktopOnly: true });
  expect(sectionForItem(a, true)).toBe("desktop-only");
  expect(sectionForItem(a, false)).toBe("not-installed"); // desktop: normal
});
it("a desktop-only plugin that IS installed is not bucketed to desktop-only", () => {
  expect(sectionForItem(avail({ kind: "disabled", drift: "behind", desktopOnly: true }), true)).toBe("disabled");
});
it("desktop-only rows are never stageable", () => {
  expect(stageableRow("store-newer", "desktop-only")).toBe(false);
});
```
Also update the existing `sectionForItem(...)` calls in that describe to pass the new arg (`, false`).

- [ ] **Step 2: Run to verify it fails** — `npx vitest run panelModel` → FAIL (arity / missing `"desktop-only"`).

- [ ] **Step 3: Extend `SectionKind` + titles/notes** (`panelModel.ts`):

```ts
export type SectionKind = "main" | "outdated" | "disabled" | "not-installed" | "desktop-only";
```
Add to `SECTION_TITLES`: `"desktop-only": "Desktop-only"`.
Add to `SECTION_NOTES`: `"desktop-only": "In your config but can't run on this device — nothing to do here."`.

- [ ] **Step 4: Update `sectionForItem`** signature + logic:

```ts
export function sectionForItem(a: Availability, isMobile: boolean): SectionKind {
  if (isMobile && a.desktopOnly && a.kind === "not-installed") return "desktop-only";
  // …existing logic unchanged…
}
```

- [ ] **Step 5: `stageableRow`** — never stageable in the desktop-only section:

```ts
export function stageableRow(state: GroupState, section: SectionKind): boolean {
  if (section === "desktop-only") return false;
  // …existing…
}
```

- [ ] **Step 6: Update the view caller** (`SyncCenterView.ts:315`): `return sectionForItem(this.availOf(name), Platform.isMobile);` (import `Platform` from `obsidian` if not already imported in this file).

- [ ] **Step 7: Run + tsc** — panelModel tests pass; tsc clean (the `Record<Exclude<SectionKind,"main">, …>` in the view now requires a `"desktop-only"` key — that is Task 4; if tsc flags it here, proceed to Task 4 in the same branch, but this task's unit tests pass independently).

- [ ] **Step 8: Commit (if asked)** — `git commit -m "ui: sectionForItem buckets desktop-only plugins on mobile"`

---

## Task 4: View — informational desktop-only section

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (sections record, `renderSections`, a new `renderInfoSection`)
- Verified: live in `dev/vault/`

**Interfaces:**
- Consumes: the `"desktop-only"` `SectionKind` + `SECTION_TITLES`/`SECTION_NOTES` (Task 3).

- [ ] **Step 1: Add the bucket** — in `renderItemMode`, extend the sections record:

```ts
const sections: Record<Exclude<SectionKind, "main">, StatusRow[]> = { outdated: [], disabled: [], "not-installed": [], "desktop-only": [] };
```

- [ ] **Step 2: Render it as informational** — in `renderSections`, after the existing three:

```ts
this.renderInfoSection(sectionsHost, "desktop-only", sections["desktop-only"]);
```

- [ ] **Step 3: Implement `renderInfoSection`** — a controls-free variant of `renderSection`: the collapsible head with title + a neutral count pill (no select-all checkbox), the `SECTION_NOTES` line, and each row rendered as name + `desktop-only` pill only (no checkbox, no On-apply, no direction action). Reuse `config-sync-section`/`-section-head`/`-section-title` classes; omit the select-all `<input>` and per-row controls.

```ts
private renderInfoSection(main: HTMLElement, kind: "desktop-only", rows: StatusRow[]): void {
  if (rows.length === 0) return;
  const matches = this.searching()
    ? rows.filter((r) => matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, this.search))
    : rows;
  if (this.searching() && matches.length === 0) return;
  const open = this.searching() || this.sectionOpen.has(kind);
  const fold = main.createDiv({ cls: `config-sync-section is-${kind}${open ? " is-open" : ""}` });
  const head = fold.createDiv({ cls: "config-sync-section-head" });
  head.createSpan({ cls: "config-sync-row-chevron", text: open ? "▾" : "▸" });
  head.createSpan({ cls: "config-sync-section-title", text: SECTION_TITLES[kind] });
  head.createSpan({ cls: "config-sync-pill is-neutral", text: `${matches.length}` });
  head.addEventListener("click", () => { if (this.sectionOpen.has(kind)) this.sectionOpen.delete(kind); else this.sectionOpen.add(kind); this.render(this.renderGen); });
  if (!open) return;
  fold.createDiv({ cls: "config-sync-report-legend", text: SECTION_NOTES[kind] });
  for (const r of matches) {
    const row = fold.createDiv({ cls: "config-sync-row is-static" });
    row.createSpan({ cls: "config-sync-rule-name", text: this.host.displayName(r.group.name, r.group.label) });
    row.createSpan({ cls: "config-sync-doto-pill", text: "desktop-only" });
  }
}
```

- [ ] **Step 4: Confirm exclusion from counts/staging** — because `sectionOf` returns `"desktop-only"` (not `"main"`), these rows never enter `mainRows()`/pills/footer, and `stageableRow` is false, so they're never selectable. No further change; verify in Step 5.

- [ ] **Step 5: Live-verify** (`dev/vault/`): force a group's availability desktop-only + mobile (via obsidian-cli eval: temporarily set `Platform.isMobile`-equivalent path OR forge a status row) — the item appears under **Desktop-only** with the note, no checkbox, not counted in pills/footer; on desktop the same item is a normal not-installed row.

- [ ] **Step 6: Commit (if asked)** — `git commit -m "ui: informational Desktop-only section on mobile"`

---

## Task 5: View — `desktop-only` pill on rows

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (row name rendering), `styles.css`

- [ ] **Step 1: Add the pill on normal rows** — where a row's name is rendered (the `config-sync-rule-name` span in the main/availability row renderer), append the pill when the item is desktop-only and the row is NOT already in the desktop-only info section:

```ts
if (this.availOf(r.group.name).desktopOnly) nameHost.createSpan({ cls: "config-sync-doto-pill", text: "desktop-only" });
```
(Place it right after the name span, matching where other row badges render.)

- [ ] **Step 2: Add the CSS** (`styles.css`) — amber outline pill, theme vars only:

```css
.config-sync-doto-pill { font-size: 10.5px; line-height: 1.6; border-radius: 6px; padding: 1px 8px; margin-left: var(--size-4-2); color: var(--color-orange); border: 1px solid rgba(var(--color-orange-rgb), 0.45); white-space: nowrap; }
```

- [ ] **Step 3: Gates + live** — `./scripts/check-no-hardcoded-color.sh` OK; in the dev vault a desktop-only plugin's row shows the amber `desktop-only` pill (light + dark).

- [ ] **Step 4: Commit (if asked)** — `git commit -m "ui: desktop-only pill on plugin rows"`

---

## Task 6: Final verification

- [ ] **Step 1: Gates** — `npm test` (all pass), `npx eslint .` (0 errors / 67 warnings), `./scripts/check-no-hardcoded-color.sh` (OK), `npm run build` (tsc + esbuild clean).
- [ ] **Step 2: Live walkthrough** — deploy to `dev/vault`, reload: capture flags a desktop-only plugin into the lock; on desktop its row shows the `desktop-only` pill and installs normally; simulate mobile bucketing → informational Desktop-only section, no controls, not counted, no "enable failed".
- [ ] **Step 3: Note the bundled fix** — the working tree also carries the pull-conflict-row alignment CSS fix (`.config-sync-cm-rel`/`-cname`/`-warn`) from this session; it ships in the same 1.1.2 cut.
- [ ] **Step 4: Report** — summarize; leave uncommitted for review unless the user asked to commit.

---

## Self-Review

**1. Spec coverage:**
- D1 detect + record → Task 1. ✓
- D2 separate from `devices` → no task touches `devices` (Global Constraints). ✓
- D3 mobile informational section + hard gate → Task 3 (bucketing + non-stageable) + Task 4 (controls-free render; excluded from counts). ✓
- D4 desktop amber-outline `desktop-only` pill → Task 5. ✓
- D5 graceful degradation → falls out of Task 1 (flag recorded only when true; old locks lack it → `desktopOnly:false` → normal not-installed). ✓
- Non-goals (BRAT-direct, timing-race, mutating devices) → untouched. ✓

**2. Placeholder scan:** No TBD/TODO. The Task 4 Step 5 "simulate mobile" is a live-verification instruction with a concrete method (obsidian-cli eval / forged row), not a gap.

**3. Type consistency:** `isDesktopOnly(id): boolean` (Task 1) used in capture + main. `desktopOnly?: boolean` lock field (Task 1) read by `availabilityForGroup` (Task 2) → `Availability.desktopOnly: boolean` (Task 2) → `sectionForItem(a, isMobile)` (Task 3) → view. `SectionKind "desktop-only"` consistent across Tasks 3–4. Pill class `config-sync-doto-pill` consistent across Tasks 4–5 + CSS.
