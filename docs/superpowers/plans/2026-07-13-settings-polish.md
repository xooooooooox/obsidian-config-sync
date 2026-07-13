# Settings Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display names replace group IDs on every user surface, settings search covers everything with scope filtering, Advanced becomes categorized "Synced items", and validation errors read like product copy.

**Architecture:** Core: `PluginHost` gains name lookups; `catalog.ts` gains `displayLabelForGroup`; `manifest.ts` messages rewritten. UI: `SettingsHost`/`SyncCenterHost` expose `displayName(group)`; SettingTab gets the global search index + scope pills + jump, Advanced regroup; SyncCenterView/ReportModal/warnings use the resolver.

**Tech Stack:** TypeScript, Obsidian API, vitest, obsidian-cli.

**Spec:** `docs/superpowers/specs/2026-07-13-settings-polish-design.md`. Mockups: `.superpowers/brainstorm/39264-1783912450/content/iter24-settings-polish.html` (4 screens, final revisions applied).

## Global Constraints

- Gate per task: `npm test && npm run build && npm run lint` — 0 lint errors (69-warning baseline).
- Resolver rules exactly: OPTION_LABELS reserved name → its `label`; core-settings id → core plugin display name (fallback: raw name); `plugin-` prefix → installed plugin manifest `name` (fallback: id without prefix); else raw group name.
- Error-copy rule: no prefixes; which item + what's expected + one example. Anchor rewrites verbatim:
  - `The store path for “{name}” needs to be a full path starting with / or ~/ — for example ~/Vaults/other-vault/config-sync.`
  - `“{name}” still uses the old sanitize setting — rename it to "mode": "fields" with "fields" rules (see README → Sensitive settings).`
- Advanced heading verbatim: `Synced items`; desc verbatim: `Everything you turned on in the Obsidian / Core plugins / Community plugins tabs. Expand a row to fine-tune its rule; reset returns it to the default.`
- Scope pills: `All {n}` `General {n}` `Obsidian {n}` `Core {n}` `Community {n}` `Advanced {n}` `Remotes {n}` (Remotes absent on mobile); zero-count pills rendered dim+disabled.
- Display names in the interface font; row aria keeps resolved paths.
- **Vault-identity guard for any obsidian-cli use:** standalone command, require `=> vault`; on mismatch URI-reopen + recheck; NEVER chain with `&&`.
- Commits: plain conventional, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Core — resolver + name lookups + error copy

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` (PluginHost, lines 9-14), `src/core/catalog.ts`, `src/core/manifest.ts`, `tests/memfs.ts` (FakePlugins), `src/main.ts` (PluginHost impl — compile-only)
- Test: `tests/catalog.test.ts`, `tests/manifest.test.ts`

**Interfaces:**
- Produces (Tasks 2-3 rely on these exact names):

```ts
// ConfigSyncCore.ts — PluginHost additions
getInstalledPluginName(id: string): string | null;
getCorePluginName(id: string): string | null;
// catalog.ts
export function displayLabelForGroup(name: string, plugins: PluginHost): string;
```

- [ ] **Step 1: Failing tests**

`tests/catalog.test.ts` — append (FakePlugins gains name maps in this task):

```ts
describe("displayLabelForGroup", () => {
  it("resolves labels per source with fallbacks", () => {
    const plugins = new FakePlugins();
    plugins.installed.set("obsidian42-brat", "1.0.0");
    plugins.installedNames.set("obsidian42-brat", "BRAT");
    plugins.coreNames.set("daily-notes", "Daily notes");
    expect(displayLabelForGroup("appearance", plugins)).toBe("Appearance");
    expect(displayLabelForGroup("daily-notes", plugins)).toBe("Daily notes");
    expect(displayLabelForGroup("plugin-obsidian42-brat", plugins)).toBe("BRAT");
    expect(displayLabelForGroup("plugin-not-installed", plugins)).toBe("not-installed");
    expect(displayLabelForGroup("my-custom-rule", plugins)).toBe("my-custom-rule");
  });
});
```

`tests/manifest.test.ts` — update the two message assertions to the verbatim anchor rewrites (storePath; legacy sanitize), and update any other assertions matching messages this task rewrites.

- [ ] **Step 2: Verify failure** — targeted vitest run.

- [ ] **Step 3: Implement**

`ConfigSyncCore.ts` PluginHost: add the two methods. `tests/memfs.ts` FakePlugins: add `installedNames = new Map<string, string>()`, `coreNames = new Map<string, string>()`, and the two lookups returning `?? null`.

`catalog.ts`:

```ts
export function displayLabelForGroup(name: string, plugins: PluginHost): string {
  for (const file of Object.keys(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return OPTION_LABELS[file]?.label ?? name;
  }
  if (CORE_SETTINGS_IDS.includes(name)) return plugins.getCorePluginName(name) ?? name;
  if (name.startsWith("plugin-")) {
    const id = name.slice("plugin-".length);
    return plugins.getInstalledPluginName(id) ?? id;
  }
  return name;
}
```

(Adapt the OPTION_LABELS access to the file's actual index types under `noUncheckedIndexedAccess`.)

`manifest.ts`: rewrite the storePath and legacy-sanitize messages to the verbatim anchors; sweep ALL remaining `ManifestValidationError`/remote-validation messages that reach the settings UI and rewrite each per the rule (no prefixes; item + expectation + example) — enumerate them in your report with before/after. Internal-only errors (never surfaced in settings) stay.

`src/main.ts` PluginHost impl (the `plugins:` object in `coreContext()` / wherever PluginHost is built): implement `getInstalledPluginName(id)` via `this.app.plugins.manifests[id]?.name ?? null` and `getCorePluginName(id)` via the existing `internalPlugins()` registry manifests (same access path as `listCorePlugins`, line ~297-308). Compile-only here; UI usage lands in Tasks 2-3.

- [ ] **Step 4: Gate + commit**

```bash
git add src/core/ConfigSyncCore.ts src/core/catalog.ts src/core/manifest.ts src/main.ts tests/memfs.ts tests/catalog.test.ts tests/manifest.test.ts
git commit -m "feat: display-name resolver, plugin name lookups, product-language validation errors"
```

---

### Task 2: Settings UI — global search, scope pills, Synced items

**Files:**
- Modify: `src/ui/SettingTab.ts`, `src/main.ts` (SettingsHost), `styles.css`

**Interfaces:**
- Consumes: `displayLabelForGroup` (via host).
- Produces: `SettingsHost.displayName(group: string): string` (main.ts: `displayLabelForGroup(group, <its PluginHost>)`). Task 3 mirrors this on SyncCenterHost.

- [ ] **Step 1: Host + names in settings** — add `displayName` to `SettingsHost` (SettingTab.ts interface + main.ts impl). Apply it to: Advanced rule-card titles (`renderRuleCard` name span), Discovered-on rows if they show group names, and search-result titles for rule/remote hits. Picker items keep their existing catalog labels (already display names).
- [ ] **Step 2: Search index** — build a unified index at render time:

```ts
interface SearchHit {
  scope: "general" | "obsidian" | "core" | "plugins" | "advanced" | "sources";
  kind: "setting" | "item" | "rule" | "discovered" | "remote";
  name: string;      // display label
  desc: string;
  anchorId: string;  // data-search-anchor value for jump targets (settings/rules/remotes)
  item?: CatalogItem; // for kind "item": render the actionable row exactly as today
}
```

General settings are indexed from a static registry (name+desc of each Setting rendered by `renderPkmMode`/`renderDataFolder`/`renderStatusToggles`/`renderRibbonToggles`/`renderPassphrase` — extract a `GENERAL_SETTINGS: {name, desc, anchorId}[]` constant used BOTH to render (attach `data-search-anchor`) and to index, so they can't drift). Advanced rules/discovered and remotes indexed from `this.groups`/`this.sources` with display names. Items via the existing `sectionsFor` walk (current behavior).
- [ ] **Step 3: Results + scope pills** — while searching: pill row (verbatim labels from Global Constraints; counts per current query; zero-count pills `disabled` + dim; Remotes pill absent on mobile); active pill filters hits. Item hits render as today (actionable rows); non-item hits render name+desc+scope tag+`›`; click → `this.search = ""`, `switchTab(scopeTab)`, after render `querySelector('[data-search-anchor="…"]')`.scrollIntoView + add class `config-sync-search-highlight` removed after 1500ms (`window.setTimeout`).
- [ ] **Step 4: Advanced regroup** — heading/desc verbatim per Global Constraints; group `managed` cards by `categoryForGroup(g.name)` under `CATEGORY_LABELS` section heads in CATEGORY_ORDER (skip empty categories); card titles = `host.displayName(g.name)` in interface font (`config-sync-card-title` class, not monospace); metadata line unchanged. `Discovered files` / `Custom rules` untouched.
- [ ] **Step 5: CSS** — `.config-sync-search-highlight { background: rgba(var(--color-purple-rgb), 0.12); transition: background 0.4s; }`, scope-pill reuse of `.config-sync-fpill` + `.is-disabled { opacity: .4; pointer-events: none; }`, scope tag pill, card-title font rule.
- [ ] **Step 6: Gate + commit**

```bash
git add src/ui/SettingTab.ts src/main.ts styles.css
git commit -m "feat: global settings search with scopes; Advanced becomes categorized Synced items"
```

---

### Task 3: Names in Sync Center, reports, warnings

**Files:**
- Modify: `src/ui/SyncCenterView.ts`, `src/ui/ReportModal.ts`, `src/main.ts`

**Interfaces:**
- Consumes: `displayLabelForGroup` via `SyncCenterHost.displayName(group: string): string` (add to the host interface + main.ts impl, same as Task 2's).
- Produces: `ReportModal` constructor gains a required `labelFor: (group: string) => string` parameter (main.ts passes the same resolver; the `"store metadata"` pseudo-label stays hardcoded).

- [ ] **Step 1: SyncCenterView** — item rows (line ~456): `text: this.host.displayName(group.name)`; remote deep-diff entry rows (line ~737): `text: this.host.displayName(e.group)`; drop the monospace styling for `.config-sync-rule-name` in favor of the interface font (styles.css: change `font-family` on that class — it is shared; verify ReportModal rows want the same, they do per spec). Sidebar/switcher labels are category labels — unchanged.
- [ ] **Step 2: ReportModal** — constructor `(app, verb, results, subtitle?, labelFor: (g: string) => string)` — match the real current signature order and add the parameter; `renderRow` uses `labelFor(r.group)` where it previously used `r.group` (the explicit `label` argument for store metadata keeps precedence). Update all `new ReportModal(...)` call sites in main.ts to pass `(g) => displayLabelForGroup(g, <pluginHost>)` (or the shared bound resolver).
- [ ] **Step 3: Version warnings** — in main.ts's `applyItems`, the confirm lines currently read `` `${w.group}: ${w.message}` `` — change to `` `${this.displayNameFor(w.group)}: ${w.message}` `` (whatever shared private helper Task 2 introduced; reuse it, don't duplicate).
- [ ] **Step 4: Gate + commit**

```bash
git add src/ui/SyncCenterView.ts src/ui/ReportModal.ts src/main.ts styles.css
git commit -m "feat: display names across sync center, reports, and warnings"
```

---

### Task 4: Live smoke (controller) + release

1. Guard (standalone); `npm run smoke:install`; reload.
2. Settings: search `pass` → Passphrase hit under General with scope tag; scope pills count/filter; click `›` → General tab opens, Passphrase setting highlighted ~1.5s; search an item name → actionable row unchanged. Advanced: `Synced items` heading + categorized display-named cards; reset-all button intact.
3. Names: Sync Center rows show display names (dev vault: `Appearance`, `Hotkeys`, `CSS snippets`…); stage + capture one → report rows show display names; a storePath validation error in Remotes shows the new copy (enter a relative path, observe message, revert).
4. emulateMobile spot-check: search + scope pills (no Remotes pill).
5. Cleanup; `dev:errors` clean; final review (opus) → merge --no-ff → cut **0.19.0** (pre-authorized) → CI draft → notes.
