# Picker De-dup, Self-Delta Fix, Banner Layout, Where-it-runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec `docs/superpowers/specs/2026-07-28-picker-dedup-selfdelta-design.md` — settings-picker description de-dup (方案 A), self-pane delta ghost fix, cold-start banner mobile layout fix, and the in-place "where it runs" guidance — as release 2.5.0.

**Architecture:** Pure logic lands in `src/core/*` and `src/ui/panelModel.ts` (vitest-covered); `src/main.ts` and view files get thin wiring (dev-vault smoke). No store schema or settings shape changes.

**Tech Stack:** TypeScript, Obsidian plugin API, vitest, esbuild.

## Global Constraints

- **No git commits.** Leave everything uncommitted; the release cut is a separate user-gated step. No Claude/AI attribution anywhere.
- Gates: `npx vitest run` all green; `npx eslint src tests --max-warnings=64` → 0 errors, ≤64 warnings; `npm run build` green.
- All user-facing copy verbatim from this plan (product-voice rule: device/consequence language, no implementation vocabulary — no "store"/"shared list"/"scope" in UI strings).
- Icons: Lucide via `setIcon` or the existing glyph vocabulary only (DESIGN §2.3/2.4); no emoji.
- Exact strings (single source; tasks reference them by name):
  - SUBTITLE_CORE: `Each plugin syncs its settings and on/off state.`
  - SUBTITLE_COMMUNITY (community AND beta tabs): `Each plugin syncs its files, settings and on/off state.`
  - STATE_BADGE text: `on/off only`; tooltip: `No settings file on this device yet — only the enable state syncs.`
  - MEMBER_BLOCK_TITLE: `These plugins are switched on differently — decide where each belongs:`
  - WHY_STORE_ONLY: `on for your other devices, off on <here> — Apply would turn it on here too` (`<here>` = `this phone` on mobile, `this computer` on desktop)
  - WHY_LOCAL_ONLY: `on only on <here> — Capture would turn it on for your other devices`
  - MENU_DESKTOP: `Desktop only — stays off on phones`; MENU_MOBILE: `Mobile only — stays off on desktops`; recommended suffix: ` · matches where it's used today`
  - MENU_LOCAL: `⌂ This device decides for itself`
  - MENU_EVERYWHERE apply-side: `Everywhere — no rule, Apply turns it on here`; capture-side: `Everywhere — no rule, Capture turns it on for your other devices`
  - BTN_WHERE: `where it runs ▾`
  - NOTE_RUNS_ON: `<id> — runs on desktop only` / `<id> — runs on mobile only`; local keeps `<id> — this device keeps its own on/off state` (⌂ prefix added by the view)
  - MEMBER_PUBLISH_NOTE: `Your choices are saved on this device — capture Settings so your other devices pick them up.`
  - DIVERGENCE_CAPTURE_LINE: ` Capture would turn <N> off on your other devices: <ids>`
  - KEEP_MODAL_NOTE: `<listLabel>: items kept on this device manage their own on/off state — they don't follow your other devices, and aren't pushed to them.`
  - LD_COUNT_NOTE (row sublabel at SyncCenterView.ts:1493): `· <N> device-scoped`

---

### Task 1: Self-delta ghost fix (`selfListGroups`)

**Files:**
- Modify: `src/core/leftover.ts` (storeSelfCopyGroups → delegate to new export)
- Modify: `src/main.ts:469-504` (selfStatus)
- Test: `tests/leftover.test.ts`

**Interfaces:**
- Produces: `selfListGroups(defs: ItemDef[], items: Record<string, ItemConfig>, customGroups: CustomGroupConfig[]): SyncGroup[]` (exported from `src/core/leftover.ts`).

- [ ] **Step 1: Write failing tests** (append to `tests/leftover.test.ts`; reuse its existing imports style):

```ts
import { selfListGroups } from "../src/core/leftover";
import { buildItemDefs } from "../src/core/registry";
import { syncListDelta } from "../src/core/syncListDelta";

describe("selfListGroups (delta ghost regression, spec 2026-07-28 §2)", () => {
  const defs = buildItemDefs({
    cores: [],
    plugins: [{ id: "omnisearch", name: "Omnisearch", desktopOnly: false }],
    betaIds: new Set<string>(),
  });
  const items = {
    "community:omnisearch": { enabled: true, companions: [] },
    // obsidian-git is NOT installed on this device (no def) but IS in the local items:
    "community:obsidian-git": { enabled: true, companions: [], enabledOn: "desktop" as const },
  };

  it("keeps items whose plugin has no local def", () => {
    const names = selfListGroups(defs, items, []).map((g) => g.name);
    expect(names).toContain("plugin-omnisearch");
    expect(names).toContain("plugin-obsidian-git");
  });

  it("identical items on both sides produce an empty delta", () => {
    const local = selfListGroups(defs, items, []);
    const store = selfListGroups(defs, items, []);
    expect(syncListDelta(local, store)).toEqual({ added: [], removed: [] });
  });

  it("a store-only item still reports added", () => {
    const local = selfListGroups(defs, items, []);
    const store = selfListGroups(defs, { ...items, "community:newone": { enabled: true, companions: [] } }, []);
    expect(syncListDelta(local, store).added).toContain("plugin-newone");
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/leftover.test.ts` — expect FAIL (`selfListGroups` not exported).

- [ ] **Step 3: Implement.** In `src/core/leftover.ts`, above `storeSelfCopyGroups`:

```ts
// The list-membership compile BOTH delta sides share (spec 2026-07-28 §2): items compiled WITH
// synthesized defs for ids whose plugin isn't installed here, so an item this data.json carries
// never drops out of membership just because its plugin is absent on this device.
export function selfListGroups(defs: ItemDef[], items: Record<string, ItemConfig>, customGroups: CustomGroupConfig[]): SyncGroup[] {
  return compileItems(defsForForeignItems(defs, Object.keys(items)), { items, customGroups });
}
```

and inside `storeSelfCopyGroups` replace the final compile line with `return selfListGroups(defs, items, customGroups);`.

- [ ] **Step 4:** In `src/main.ts` `selfStatus` (line ~469): add import `selfListGroups` to the existing `./core/leftover` import. Replace `const local = this.compiledGroups;` with:

```ts
        // Membership truth (delta / coldstart / itemCount) uses the same compile as the store
        // side (selfListGroups): items whose plugin isn't installed here stay members instead of
        // ghosting into delta.added forever (2026-07-28 phone find).
        let localList: SyncGroup[];
        try {
          localList = selfListGroups(this.registryDefs, this.settings.items, this.settings.customGroups);
        } catch {
          localList = this.compiledGroups; // CompileError — recompile() already surfaced the Notice
        }
```

Then: `syncListDelta(localList, storeGroups)`; coldstart check `localList.length === 0`; both `itemCount: local.length` occurrences → `localList.length`; the selfGroup lookup becomes `this.compiledGroups.find((g) => g.name === SELF_GROUP_NAME)` (engine list, unchanged semantics).

- [ ] **Step 5:** `npx vitest run` — all green. `npm run build` — green.

---

### Task 2: Picker de-dup (方案 A) + banner mobile CSS

**Files:**
- Modify: `src/core/registry.ts:132-136,188` · `src/ui/itemCard.ts` (Badge, computeBadges) · `src/ui/SettingTab.ts` (renderRegistryCards ~:606, renderBadge ~:678, search hits ~:1845) · `styles.css`
- Test: `tests/itemCard.test.ts`, `tests/registry.test.ts`

**Interfaces:**
- Consumes: `settingsFileZoneKind` predicate shape (`def.settingsFile.defaultPath === null`).
- Produces: `Badge.tooltip?: string`.

- [ ] **Step 1: Failing tests.** In `tests/itemCard.test.ts` (computeBadges describe):

```ts
  it("state-only def gets the on/off-only badge first, with tooltip", () => {
    const def: ItemDef = { id: "core:bases", label: "Bases", description: "", section: "core", settingsFile: { defaultPath: null } };
    const badges = computeBadges(def, { enabled: true, companions: [] });
    expect(badges[0]).toEqual({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      tooltip: "No settings file on this device yet — only the enable state syncs.",
    });
  });

  it("a def with a settings file gets no on/off-only badge", () => {
    const def: ItemDef = { id: "core:backlinks", label: "Backlinks", description: "", section: "core", settingsFile: { defaultPath: "{configDir}/backlink.json" } };
    expect(computeBadges(def, { enabled: true, companions: [] }).some((b) => b.text === "on/off only")).toBe(false);
  });
```

In `tests/registry.test.ts`: assert `buildItemDefs` core and community defs now have `description: ""`, and the three obsidian cards keep non-empty descriptions. **Search both test files for the old strings** (`Settings and on/off state.`, `On/off state — no saved settings`, `Plugin files, settings and on/off state.`) and update stale assertions.

- [ ] **Step 2:** `npx vitest run tests/itemCard.test.ts tests/registry.test.ts` — FAIL.

- [ ] **Step 3: registry.ts.** Delete `corePluginDescription`; core defs get `description: ""`. Set `const COMMUNITY_PLUGIN_DESCRIPTION = "";` (constant kept — `defsForForeignItems` stays in sync).

- [ ] **Step 4: itemCard.ts.** `Badge` gains `tooltip?: string;`. At the TOP of `computeBadges` (innate, ahead of desktop-only):

```ts
  if (def.settingsFile !== undefined && def.settingsFile.defaultPath === null) {
    badges.push({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      tooltip: "No settings file on this device yet — only the enable state syncs.",
    });
  }
```

- [ ] **Step 5: SettingTab.ts.** Add `setTooltip` to the obsidian import. In `renderBadge`, after `el.appendText(badge.text);`: `if (badge.tooltip !== undefined) setTooltip(el, badge.tooltip);`. In `renderRegistryCards`, replace the Sync-all line with:

```ts
    if (withSyncAll && defs.length > 0) {
      containerEl.createDiv({
        cls: "config-sync-section-sub",
        text: section === "core" ? "Each plugin syncs its settings and on/off state." : "Each plugin syncs its files, settings and on/off state.",
      });
      this.renderSyncAllRow(containerEl, defs);
    }
```

Search hits (~:1848): replace the desc expression with:

```ts
        const path = def.settingsFile?.defaultPath;
        const stateOnly = def.settingsFile !== undefined && def.settingsFile.defaultPath === null;
        hits.push({
          scope: tab,
          kind: "item",
          name: def.label,
          desc: [def.description, stateOnly ? "on/off only" : "", path ?? ""].filter((s) => s !== "").join(" "),
          anchorId: `item-${def.id}`,
          item: { type: "file" },
        });
```

- [ ] **Step 6: styles.css.** Near the badge rules (~:958):

```css
.config-sync-card-badge-state { color: var(--text-faint); background: transparent; border: 1px dashed var(--background-modifier-border-hover); }
.config-sync-item-wrap .setting-item-description:empty { display: none; }
.config-sync-section-sub { color: var(--text-muted); font-size: var(--font-ui-small); padding: 4px 0 2px; }
```

After the coldstart block (~:865), the §3 banner fix:

```css
body.is-mobile .config-sync-coldstart-text { flex-basis: 100%; }
body.is-mobile .config-sync-coldstart-actions { margin-left: auto; }
```

- [ ] **Step 7:** `npx vitest run` green; `npm run build` green.

---

### Task 3: Pure models for where-it-runs

**Files:**
- Modify: `src/ui/panelModel.ts`, `src/core/registry.ts`
- Test: `tests/panelModel.test.ts`, `tests/registry.test.ts`

**Interfaces:**
- Produces (panelModel): `MemberChangeRow { id: string; action: Direction; why: string; recommended: "desktop" | "mobile" | null }`, `memberChangeRows(d, device)`, `MemberDecision { id: string; scope: "local" | "desktop" | "mobile" }`, `memberDecisionsFromScopes(scopes: Record<string, RuleScope>): MemberDecision[]`, `memberDecisionText(m: MemberDecision): string`, consts `MEMBER_BLOCK_TITLE`, `MEMBER_PUBLISH_NOTE`.
- Produces (registry): `itemConfigWithEnabledOn(existing: ItemConfig | undefined, scope: "desktop" | "mobile"): ItemConfig`.

- [ ] **Step 1: Failing tests.** `tests/panelModel.test.ts`:

```ts
describe("memberChangeRows (spec 2026-07-28 §4)", () => {
  const d = { captureRemoves: ["simpread", "obsidian-git"], applyDisables: ["vim-toggle"] };

  it("mobile view: store-only rows lead, sorted, with desktop recommendation", () => {
    const rows = memberChangeRows(d, "mobile");
    expect(rows.map((r) => r.id)).toEqual(["obsidian-git", "simpread", "vim-toggle"]);
    expect(rows[0]).toEqual({
      id: "obsidian-git",
      action: "apply",
      why: "on for your other devices, off on this phone — Apply would turn it on here too",
      recommended: "desktop",
    });
    expect(rows[2]).toEqual({
      id: "vim-toggle",
      action: "capture",
      why: "on only on this phone — Capture would turn it on for your other devices",
      recommended: null,
    });
  });

  it("desktop view mirrors wording and recommendation", () => {
    const rows = memberChangeRows(d, "desktop");
    expect(rows[0]?.why).toBe("on for your other devices, off on this computer — Apply would turn it on here too");
    expect(rows[0]?.recommended).toBe("mobile");
    expect(rows[2]?.why).toBe("on only on this computer — Capture would turn it on for your other devices");
  });
});

describe("memberDecisionsFromScopes / memberDecisionText", () => {
  it("keeps only non-all scopes, sorted by id", () => {
    expect(memberDecisionsFromScopes({ b: "desktop", a: "local", c: "all", d: "mobile" })).toEqual([
      { id: "a", scope: "local" },
      { id: "b", scope: "desktop" },
      { id: "d", scope: "mobile" },
    ]);
  });
  it("copy", () => {
    expect(memberDecisionText({ id: "x", scope: "local" })).toBe("x — this device keeps its own on/off state");
    expect(memberDecisionText({ id: "x", scope: "desktop" })).toBe("x — runs on desktop only");
    expect(memberDecisionText({ id: "x", scope: "mobile" })).toBe("x — runs on mobile only");
  });
});
```

`tests/registry.test.ts`:

```ts
describe("itemConfigWithEnabledOn", () => {
  it("creates an enabled config from nothing", () => {
    expect(itemConfigWithEnabledOn(undefined, "desktop")).toEqual({ enabled: true, companions: [], enabledOn: "desktop" });
  });
  it("preserves existing fields and forces enabled", () => {
    const existing: ItemConfig = { enabled: false, companions: [{ path: "x", enabled: true, scope: "all" }], settingsFile: { mode: "plain" } };
    const out = itemConfigWithEnabledOn(existing, "mobile");
    expect(out.enabledOn).toBe("mobile");
    expect(out.enabled).toBe(true);
    expect(out.companions).toEqual(existing.companions);
    expect(out.settingsFile).toEqual(existing.settingsFile);
  });
});
```

(If `ItemCompanion` requires different fields, mirror the real shape from `src/core/registry.ts` — the point is preservation, not the sample values.)

- [ ] **Step 2:** Run both files — FAIL.

- [ ] **Step 3: panelModel.ts.** Add `RuleScope` to the `../core/types` import; append:

```ts
// ── In-place "where it runs" guidance (spec 2026-07-28 §4) ────────────────────────────────────

export const MEMBER_BLOCK_TITLE = "These plugins are switched on differently — decide where each belongs:";
export const MEMBER_PUBLISH_NOTE = "Your choices are saved on this device — capture Settings so your other devices pick them up.";

export interface MemberChangeRow {
  id: string;
  action: Direction; // apply = enabled only in the store's list, capture = enabled only here
  why: string;
  recommended: "desktop" | "mobile" | null;
}

// One row per element the pending direction would flip, in device language. Store-only
// elements lead; each set alphabetical. Recommendation only where intent is inferable:
// an element on everywhere-but-here most likely belongs to the other device class.
export function memberChangeRows(
  d: { captureRemoves: string[]; applyDisables: string[] },
  device: "desktop" | "mobile"
): MemberChangeRow[] {
  const here = device === "mobile" ? "this phone" : "this computer";
  const other: "desktop" | "mobile" = device === "mobile" ? "desktop" : "mobile";
  const storeOnly = [...d.captureRemoves].sort().map(
    (id): MemberChangeRow => ({
      id,
      action: "apply",
      why: `on for your other devices, off on ${here} — Apply would turn it on here too`,
      recommended: other,
    })
  );
  const localOnly = [...d.applyDisables].sort().map(
    (id): MemberChangeRow => ({
      id,
      action: "capture",
      why: `on only on ${here} — Capture would turn it on for your other devices`,
      recommended: null,
    })
  );
  return [...storeOnly, ...localOnly];
}

export interface MemberDecision {
  id: string;
  scope: "local" | "desktop" | "mobile";
}

// Every per-member decision worth a note row: ⌂ local exceptions plus device-class rules.
export function memberDecisionsFromScopes(scopes: Record<string, RuleScope>): MemberDecision[] {
  return Object.entries(scopes)
    .filter((e): e is [string, "local" | "desktop" | "mobile"] => e[1] !== "all")
    .map(([id, scope]) => ({ id, scope }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function memberDecisionText(m: MemberDecision): string {
  return m.scope === "local" ? `${m.id} — this device keeps its own on/off state` : `${m.id} — runs on ${m.scope} only`;
}
```

- [ ] **Step 4: registry.ts**, next to `emptyItemConfig`:

```ts
// The exact write the in-place "where it runs" menu performs (spec 2026-07-28 §4): keep the
// card's existing config, force the card on (a rule on a disabled card would read back as
// "local"), pin enabledOn.
export function itemConfigWithEnabledOn(existing: ItemConfig | undefined, scope: "desktop" | "mobile"): ItemConfig {
  return { ...(existing ?? emptyItemConfig()), enabled: true, enabledOn: scope };
}
```

- [ ] **Step 5:** `npx vitest run` — green.

---

### Task 4: Host surface + decision-note rows + copy alignment

**Files:**
- Modify: `src/main.ts` (memberLocalFor ~:770, host wiring :557, new setMemberEnabledOn) · `src/ui/SyncCenterView.ts` (host interface :136, :1491, :1582, divergence copy ~:1703, KeepOnDeviceModal note ~:2236) · `styles.css`

**Interfaces:**
- Consumes: Task 3's `MemberDecision`, `memberDecisionsFromScopes`, `memberDecisionText`, `itemConfigWithEnabledOn`.
- Produces (SyncCenterHost): `switchMemberDecisions(name: string): MemberDecision[]` (replaces `switchLocalDecisions`); `setMemberEnabledOn(carrier: string, elementId: string, scope: "desktop" | "mobile"): Promise<void>`.

- [ ] **Step 1: main.ts.** Replace `memberLocalFor` with:

```ts
  private memberDecisionsFor(group: string): MemberDecision[] {
    return memberDecisionsFromScopes(this.enablementScopesFor(group));
  }
```

Host wiring: `switchMemberDecisions: (name) => (SWITCH_LIST_GROUPS.has(name) ? this.memberDecisionsFor(name) : []),` and next to `addSwitchExceptions`:

```ts
      setMemberEnabledOn: async (carrier, elementId, scope) => {
        // Same field the settings card's "Enabled on" writes; masking covers not-installed
        // plugins since the 2026-07-27 enablementScopes fix.
        const itemId = `${carrier === "core-plugins" ? "core" : "community"}:${elementId}`;
        this.settings.items = { ...this.settings.items, [itemId]: itemConfigWithEnabledOn(this.settings.items[itemId], scope) };
        await this.saveSettings();
      },
```

Imports: `memberDecisionsFromScopes`, `MemberDecision` from `./ui/panelModel`; `itemConfigWithEnabledOn` added to the `./core/registry` import.

- [ ] **Step 2: SyncCenterView.ts host interface** (:136): replace `switchLocalDecisions(name: string): string[];` with the two new members (import `MemberDecision` from `./panelModel`). Row sublabel (:1491):

```ts
    const ldCount = this.host.switchMemberDecisions(group.name).length;
    if (ldCount > 0) {
      row.createSpan({ cls: "config-sync-ldnote", text: `· ${ldCount} device-scoped` });
    }
```

Detail note rows (:1582):

```ts
    const decisions = this.host.switchMemberDecisions(r.group.name);
    for (const m of decisions) {
      const line = detail.createDiv({ cls: "config-sync-lddetail" });
      if (m.scope === "local") line.setText(`⌂ ${memberDecisionText(m)}`);
      else {
        setIcon(line.createSpan({ cls: "config-sync-lddetail-ic" }), m.scope === "desktop" ? "monitor" : "smartphone");
        line.appendText(` ${memberDecisionText(m)}`);
      }
    }
```

(`excluded.length > 0` further down that method becomes `decisions.length > 0`.)

- [ ] **Step 3: copy alignment.** Divergence capture line → DIVERGENCE_CAPTURE_LINE:

```ts
      capLine.appendText(` Capture would turn ${d.captureRemoves.length} off on your other devices: ${d.captureRemoves.join(", ")}`);
```

KeepOnDeviceModal note (~:2236) → KEEP_MODAL_NOTE (template with `${this.listLabel}` prefix as today).

- [ ] **Step 4: styles.css**, next to `.config-sync-lddetail`:

```css
.config-sync-lddetail-ic { display: inline-flex; vertical-align: -2px; }
.config-sync-lddetail-ic svg { width: 12px; height: 12px; }
```

- [ ] **Step 5:** `npx vitest run` green (no view tests exist; this catches type breaks via `npm run build`). `npm run build` green. `npx eslint src tests --max-warnings=64` — 0 errors.

---

### Task 5: Member block UI + where-it-runs menu

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (renderSwitchDivergence ~:1694 + two new methods; `Menu` added to the obsidian import; panelModel imports) · `styles.css`

**Interfaces:**
- Consumes: Task 3 models, Task 4 host methods, existing `renderActionIcon`/`ACTION_COLOR_CLASS`, `switchDivergenceFor`, `this.selfInfo`.

- [ ] **Step 1:** Add near the top of the class: `const MEMBER_GUIDE_GROUPS = new Set(["community-plugins", "core-plugins"]);` (module scope; enabled-css-snippets has its own per-snippet scope + pin mechanism).

- [ ] **Step 2:** Restructure `renderSwitchDivergence`: the both-ways early-return `if (d.captureRemoves.length === 0 || d.applyDisables.length === 0) return;` becomes a positive guard around the existing warning box + Keep button (all of it otherwise unchanged apart from Task 4's capture line), followed by:

```ts
      if (MEMBER_GUIDE_GROUPS.has(r.group.name)) this.renderMemberBlock(holder, r, d);
```

- [ ] **Step 3: the block + menu:**

```ts
  private renderMemberBlock(holder: HTMLElement, r: StatusRow, d: { captureRemoves: string[]; applyDisables: string[] }): void {
    const rows = memberChangeRows(d, Platform.isMobile ? "mobile" : "desktop");
    if (rows.length === 0) return;
    const block = holder.createDiv({ cls: "config-sync-memberblock" });
    block.createDiv({ cls: "config-sync-memberblock-t", text: MEMBER_BLOCK_TITLE });
    for (const m of rows) {
      const row = block.createDiv({ cls: "config-sync-memberrow" });
      renderActionIcon(row.createSpan({ cls: "config-sync-memberrow-ic" }), m.action).addClass(ACTION_COLOR_CLASS[m.action]);
      const mid = row.createDiv({ cls: "config-sync-memberrow-mid" });
      mid.createDiv({ cls: "config-sync-memberrow-n", text: m.id });
      mid.createDiv({ cls: "config-sync-memberrow-why", text: m.why });
      const btn = row.createEl("button", { cls: "config-sync-memberrow-btn", text: "where it runs ▾" });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openWhereItRunsMenu(e, r.group.name, m);
      });
    }
  }

  private openWhereItRunsMenu(evt: MouseEvent, carrier: string, m: MemberChangeRow): void {
    const menu = new Menu();
    menu.setUseNativeMenu(false); // DOM menu — renders our Lucide icons on macOS too
    const consequence = m.action === "apply" ? "no rule, Apply turns it on here" : "no rule, Capture turns it on for your other devices";
    const rec = " · matches where it's used today";
    const entries: { title: string; icon?: string; write: (() => Promise<void>) | null }[] = [
      {
        title: `Desktop only — stays off on phones${m.recommended === "desktop" ? rec : ""}`,
        icon: "monitor",
        write: () => this.host.setMemberEnabledOn(carrier, m.id, "desktop"),
      },
      {
        title: `Mobile only — stays off on desktops${m.recommended === "mobile" ? rec : ""}`,
        icon: "smartphone",
        write: () => this.host.setMemberEnabledOn(carrier, m.id, "mobile"),
      },
      { title: "⌂ This device decides for itself", write: () => this.host.addSwitchExceptions(carrier, [m.id]) },
      { title: `Everywhere — ${consequence}`, icon: "globe", write: null },
    ];
    if (m.recommended === "mobile") entries.unshift(entries.splice(1, 1)[0]!); // recommended leads
    for (const it of entries) {
      menu.addItem((i) => {
        i.setTitle(it.title);
        if (it.icon !== undefined) i.setIcon(it.icon);
        i.onClick(async () => {
          if (it.write === null) return;
          await it.write();
          await this.reload();
        });
      });
    }
    menu.showAtMouseEvent(evt);
  }
```

(Adjust `addSwitchExceptions`'s existing callsite pattern if it already reloads — it does via the KeepOnDeviceModal flow calling `this.reload()`; here the menu owns the reload.)

- [ ] **Step 4: publish reminder.** In `renderItemDetail`, immediately after the Task 4 decisions loop:

```ts
    if (decisions.length > 0 && this.selfInfo !== null && (this.selfInfo.state === "capture" || this.selfInfo.state === "both")) {
      detail.createDiv({ cls: "config-sync-lddetail", text: MEMBER_PUBLISH_NOTE });
    }
```

- [ ] **Step 5: styles.css:**

```css
.config-sync-memberblock { border: 1px solid var(--background-modifier-border); border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
.config-sync-memberblock-t { color: var(--text-muted); font-size: var(--font-ui-smaller); margin-bottom: 2px; }
.config-sync-memberrow { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.config-sync-memberrow + .config-sync-memberrow { border-top: 1px solid var(--background-modifier-border); }
.config-sync-memberrow-ic svg { width: 14px; height: 14px; display: block; }
.config-sync-memberrow-mid { flex: 1; min-width: 0; }
.config-sync-memberrow-n { font-weight: 600; font-size: var(--font-ui-small); }
.config-sync-memberrow-why { color: var(--text-muted); font-size: var(--font-ui-smaller); }
.config-sync-memberrow-btn { font-size: var(--font-ui-smaller); color: var(--text-muted); background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 2px 8px; box-shadow: none; height: auto; white-space: nowrap; }
.config-sync-memberrow-btn:hover { color: var(--text-normal); }
body.is-mobile .config-sync-memberrow { flex-wrap: wrap; }
```

- [ ] **Step 6:** `npx vitest run` green; `npm run build` green; `npx eslint src tests --max-warnings=64` 0 errors.

---

### Task 6: Docs currency + product-voice convention

**Files:**
- Modify: `README.md`, `README.zh.md` (keep 1:1 line parity), `docs/design/DESIGN.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: README feature bullets** (Sync Center section; zh mirrors line-for-line):
  - `- **Decide where a plugin belongs, right in the diff** — when a plugin is switched on on one side only, its row explains the consequence and a "where it runs" menu sets Desktop only / Mobile only / per-device on the spot.`
  - Update any README sentence still describing per-row picker descriptions if one exists (search "on/off state" in both READMEs).
- [ ] **Step 2: DESIGN.md**:
  - §2.3 icon list: add `monitor` / `smartphone` (where-it-runs menu + decision notes), `globe` (Everywhere).
  - §3 component library: entry for `config-sync-memberblock/-memberrow/-memberrow-btn` — per-member switch-list interpretation + where-it-runs menu; and `config-sync-section-sub` + `config-sync-card-badge-state` for the picker.
  - (The "Copy principles" section is deliberately NOT written here — the product-voice convention lands with the next iteration's full copy/DESIGN/docs audit, per 2026-07-28 user decision.)
- [ ] **Step 3: ARCHITECTURE.md**: in the self-pane/leftover module notes, one line: delta/coldstart/itemCount membership comes from `selfListGroups` (foreign-def compile, symmetric with the store side); and `panelModel` gains the member-guidance models.
- [ ] **Step 4:** Verify README/zh line counts still match (`wc -l README.md README.zh.md`).

---

### Task 7: Gates + dev-vault smoke

- [ ] `npx vitest run` — all green.
- [ ] `npx eslint src tests --max-warnings=64` — 0 errors, ≤64 warnings.
- [ ] `npm run build` — green; copy `main.js styles.css manifest.json` into `dev/vault/.obsidian/plugins/config-sync/`.
- [ ] Smoke (from `dev/vault`; obsidian-cli routes by CWD; `command` needs `id=`; eval has no top-level await — use `.then()`; wait ~10s after reload):
  1. `obsidian-cli command id=app:reload`, wait, then eval version check (`app.plugins.plugins["config-sync"].manifest.version`).
  2. Settings picker: open Core plugins tab — subtitle renders once (`document.querySelector(".config-sync-section-sub")`), rows single-line, a state-only core row shows the dashed `on/off only` badge (hover tooltip on desktop).
  3. Seed a one-sided switch divergence (toggle one plugin in the store copy of `community-plugins.json`), refresh Sync Center: member block renders with the row copy; choose `Desktop only` — row disappears, `runs on desktop only` note appears, publish reminder shows while ⚙ Settings is pending capture.
  4. Self pane: with a not-installed item present in local items, the adopt card no longer lists it (delta ghost gone).
- [ ] Report results; STOP — no commit (cut is a separate user-gated step).
