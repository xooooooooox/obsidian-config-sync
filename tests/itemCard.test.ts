import { describe, expect, it } from "vitest";
import {
  applyPerItemToggle,
  applySyncAll,
  buildCompanionRows,
  buildPerItemElementRows,
  buildRuleRows,
  buildSnippetMemberRows,
  withSnippetScope,
  computeBadges,
  countDeviceScoped,
  countEncrypted,
  deriveMode,
  encryptDisabledForScope,
  encryptToggleDisabled,
  ENABLED_CSS_SNIPPETS_KEY,
  ENABLED_ON_LABEL,
  hasEnablementZone,
  hasKeyRules,
  memberCountLabel,
  nextScope,
  PREVIEW_LEGEND_ENTRIES,
  DESKTOP_ONLY_ALL_NOTE,
  DESKTOP_ONLY_ENABLED_OPTIONS,
  FIELD_SCOPE_OPTIONS,
  FILE_SCOPE_OPTIONS,
  COMPANION_SCOPE_OPTIONS,
  SCOPE_ICONS,
  scopeCycleTooltip,
  sectionAllEnabled,
  settingsFileZoneKind,
  stateOnlyHint,
  SYNC_ALL_HINT,
  SYNC_ALL_LABEL,
} from "../src/ui/itemCard";
import { emptyItemConfig, ItemConfig, ItemDef, ItemSettingsFile } from "../src/core/registry";

// spec docs/superpowers/specs/2026-07-25-unified-card-design.md §4/§5/§10; task-5-brief.md;
// docs/superpowers/specs/2026-07-26-ui-feedback-round2-design.md §2 (app-slice mechanism removed).

function def(overrides: Partial<ItemDef> = {}): ItemDef {
  return { id: "app", label: "App settings", description: "d", section: "obsidian", ...overrides };
}

const APP_DEF: ItemDef = def({
  id: "app",
  label: "App settings",
  settingsFile: { defaultPath: "{configDir}/app.json" },
});
const APPEARANCE_DEF: ItemDef = def({
  id: "appearance",
  label: "Appearance",
  settingsFile: { defaultPath: "{configDir}/appearance.json" },
  presetCompanions: [{ path: "{configDir}/themes" }, { path: "{configDir}/snippets", mapKey: "enabledCssSnippets" }],
});
const HOTKEYS_DEF: ItemDef = def({ id: "hotkeys", label: "Hotkeys", settingsFile: { defaultPath: "{configDir}/hotkeys.json" } });
const CORE_STATE_ONLY_DEF: ItemDef = def({
  id: "core:zk-prefixer",
  label: "Unique note creator",
  section: "core",
  enablement: { carrier: "core-plugins.json", element: "zk-prefixer" },
  settingsFile: { defaultPath: null },
});
const CORE_WITH_FILE_DEF: ItemDef = def({
  id: "core:graph",
  label: "Graph view",
  section: "core",
  enablement: { carrier: "core-plugins.json", element: "graph" },
  settingsFile: { defaultPath: "{configDir}/graph.json" },
});
const COMMUNITY_DEF: ItemDef = def({
  id: "community:dataview",
  label: "Dataview",
  section: "community",
  enablement: { carrier: "community-plugins.json", element: "dataview" },
  settingsFile: { defaultPath: "{configDir}/plugins/dataview/data.json" },
});

function cfg(overrides: Partial<ItemConfig> = {}): ItemConfig {
  return { ...emptyItemConfig(), ...overrides };
}

describe("computeBadges", () => {
  it("state-only def gets the on/off-only badge first, with tooltip", () => {
    const def: ItemDef = { id: "core:bases", label: "Bases", description: "", section: "core", settingsFile: { defaultPath: null } };
    const badges = computeBadges(def, { enabled: true, companions: [] }, false);
    expect(badges[0]).toEqual({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      tooltip: "No settings file on this device yet — only the on/off state syncs.",
    });
  });

  it("a def with a settings file gets no on/off-only badge", () => {
    const def: ItemDef = { id: "core:backlinks", label: "Backlinks", description: "", section: "core", settingsFile: { defaultPath: "{configDir}/backlink.json" } };
    expect(computeBadges(def, { enabled: true, companions: [] }, false).some((b) => b.text === "on/off only")).toBe(false);
  });

  it("no badges for a plain off/default card", () => {
    expect(computeBadges(APP_DEF, cfg(), false)).toEqual([]);
  });

  it("enabledOn default (\"all\"/undefined) never shows an on: badge, even with enablement", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg({ enabled: true, enabledOn: "all" }), false)).toEqual([]);
    expect(computeBadges(COMMUNITY_DEF, cfg({ enabled: true }), false)).toEqual([]);
  });

  it("desktop-only def prepends the innate grey chip ahead of every config badge (round-8 spec §2)", () => {
    const dOnly: ItemDef = { ...COMMUNITY_DEF, desktopOnly: true };
    expect(computeBadges(dOnly, cfg(), false)).toEqual([{ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" }]);
    expect(computeBadges(dOnly, cfg({ enabledOn: "desktop" }), false)).toEqual([
      { text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" },
      { text: "on: desktop", cls: "config-sync-card-badge-desktop" },
    ]);
  });

  it("enabledOn non-default shows the matching on: badge — only when the def has an enablement", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg({ enabledOn: "desktop" }), false)).toEqual([{ text: "on: desktop", cls: "config-sync-card-badge-desktop" }]);
    expect(computeBadges(COMMUNITY_DEF, cfg({ enabledOn: "mobile" }), false)).toEqual([{ text: "on: mobile", cls: "config-sync-card-badge-mobile" }]);
    // enabledOn:"local" is no longer honored — "this device" comes from the isThisDevice flag (see below)
    expect(computeBadges(COMMUNITY_DEF, cfg({ enabledOn: "local" }), false)).toEqual([]);
    // no-enablement card (app): the same enabledOn value produces NO badge — the projection
    // doesn't exist for this card at all.
    expect(computeBadges(APP_DEF, cfg({ enabledOn: "desktop" }), false)).toEqual([]);
  });

  it("shows 'on: this device' from the isThisDevice flag, not from a stored enabledOn", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg(), true)).toEqual([{ text: "on: this device", cls: "config-sync-card-badge-local" }]);
    expect(computeBadges(COMMUNITY_DEF, cfg(), false)).toEqual([]);
  });

  it("counts device-scoped fields, per-item elements, and the fileRule scope together", () => {
    const c = cfg({
      settingsFile: {
        mode: "fields",
        rules: { a: { scope: "desktop", encrypted: false }, b: { scope: "mobile", encrypted: false }, c: { scope: "all", encrypted: false } },
        perItem: { arr: { x: "desktop", y: "mobile", z: "all" } },
      },
    });
    expect(countDeviceScoped(c)).toBe(4); // a, b, arr.x, arr.y
    const withFileRule = cfg({ settingsFile: { mode: "plain", rules: {}, perItem: {}, fileRule: { scope: "desktop", encrypted: false } } });
    expect(countDeviceScoped(withFileRule)).toBe(1);
  });

  it("counts encrypted fields AND a fileRule-encrypted whole file into the SAME 'N encrypted' badge (no separate lock badge string)", () => {
    const fieldsEncrypted = cfg({ settingsFile: { mode: "fields", rules: { a: { scope: "all", encrypted: true }, b: { scope: "all", encrypted: false } }, perItem: {} } });
    expect(countEncrypted(fieldsEncrypted)).toBe(1);
    const fileEncrypted = cfg({ settingsFile: { mode: "plain", rules: {}, perItem: {}, fileRule: { scope: "all", encrypted: true } } });
    expect(countEncrypted(fileEncrypted)).toBe(1);
    expect(computeBadges(HOTKEYS_DEF, fileEncrypted, false)).toEqual([{ text: "1 encrypted", cls: "config-sync-card-badge-count" }]);
  });

  it("badge order is on: -> device-scoped -> encrypted, omitting zero counts", () => {
    const c = cfg({
      enabledOn: "desktop",
      settingsFile: { mode: "fields", rules: { a: { scope: "mobile", encrypted: true } }, perItem: {} },
    });
    expect(computeBadges(COMMUNITY_DEF, c, false)).toEqual([
      { text: "on: desktop", cls: "config-sync-card-badge-desktop" },
      { text: "1 device-scoped", cls: "config-sync-card-badge-count" },
      { text: "1 encrypted", cls: "config-sync-card-badge-count" },
    ]);
  });
});

describe("zone presence", () => {
  it("hasEnablementZone: only core/community/beta defs (an enablement projection)", () => {
    expect(hasEnablementZone(COMMUNITY_DEF)).toBe(true);
    expect(hasEnablementZone(CORE_WITH_FILE_DEF)).toBe(true);
    expect(hasEnablementZone(APP_DEF)).toBe(false);
    expect(hasEnablementZone(HOTKEYS_DEF)).toBe(false);
  });

  it("settingsFileZoneKind: none / state-only / settings", () => {
    expect(settingsFileZoneKind(def({ settingsFile: undefined }))).toBe("none");
    expect(settingsFileZoneKind(CORE_STATE_ONLY_DEF)).toBe("state-only");
    expect(settingsFileZoneKind(CORE_WITH_FILE_DEF)).toBe("settings");
    expect(settingsFileZoneKind(APP_DEF)).toBe("settings");
  });

  it("stateOnlyHint is copy-contract exact", () => {
    expect(stateOnlyHint("Unique note creator", "zk-prefixer.json")).toBe("Settings appear here once Unique note creator writes zk-prefixer.json.");
  });
});

// effectiveMode/modeChipLabel/cardBodyPlan are gone by design (spec §3.2 — the header mode chip
// and the Plain/Fields branch it drove are both deleted) — deriveMode/hasKeyRules below replace
// their role.
describe("deriveMode / hasKeyRules (spec 2026-07-26-card-visual-refresh-design.md §3)", () => {
  it("empty rules+perItem derives plain; any rule or perItem derives fields", () => {
    const empty: ItemSettingsFile = { mode: "plain", rules: {}, perItem: {} };
    expect(deriveMode(empty)).toBe("plain");
    expect(deriveMode({ ...empty, rules: { a: { scope: "desktop", encrypted: false } } })).toBe("fields");
    expect(deriveMode({ ...empty, perItem: { arr: { x: "desktop" } } })).toBe("fields");
    expect(hasKeyRules(cfg())).toBe(false);
  });
});

describe("encryptDisabledForScope", () => {
  it("is true only for local (This device)", () => {
    expect(encryptDisabledForScope("local")).toBe(true);
    expect(encryptDisabledForScope("all")).toBe(false);
    expect(encryptDisabledForScope("desktop")).toBe(false);
    expect(encryptDisabledForScope("mobile")).toBe(false);
  });
});

describe("buildRuleRows (spec 2026-07-26-card-visual-refresh-design.md §3 — the only rule-row model; supersedes the deleted buildFieldRows)", () => {
  it("lists ONLY configured keys, not every live-doc key", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { ruled: { scope: "desktop", encrypted: false } }, perItem: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { ruled: 1, unruled: 2 });
    expect(rows.map((r) => r.key)).toEqual(["ruled"]);
  });

  it("includes perItem-only keys and marks isArray from the live doc", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perItem: { list: { a: "desktop" } } } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { list: ["a"] });
    expect(rows).toEqual([expect.objectContaining({ key: "list", isArray: true, perItemEnabled: true })]);
  });

  it("a key not present in the live doc defaults isArray to false", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { gone: { scope: "all", encrypted: false } }, perItem: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, {});
    expect(rows).toEqual([{ key: "gone", isArray: false, rule: { scope: "all", encrypted: false }, perItemEnabled: false }]);
  });

  it("rules-key order first, then perItem-only keys, no duplicates for a key present in both", () => {
    const c = cfg({
      settingsFile: {
        mode: "fields",
        rules: { a: { scope: "desktop", encrypted: false }, b: { scope: "all", encrypted: false } },
        perItem: { b: { x: "mobile" }, c: { y: "all" } },
      },
    });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { a: 1, b: ["x"], c: ["y"] });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("returns no rows when settingsFile is absent", () => {
    expect(buildRuleRows(HOTKEYS_DEF, cfg(), { anything: 1 })).toEqual([]);
  });

  it("a ruled key with a non-string-array value gets isArray false", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { items: { scope: "all", encrypted: false } }, perItem: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { items: [{ a: 1 }] });
    expect(rows).toEqual([expect.objectContaining({ key: "items", isArray: false })]);
  });

  it("appearance pointer-row logic: enabledCssSnippets is excluded from rule rows (like buildFieldRows)", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perItem: { enabledCssSnippets: { x: "desktop" } } } });
    const rows = buildRuleRows(APPEARANCE_DEF, c, { cssTheme: "dark", enabledCssSnippets: ["a.css"] });
    expect(rows.map((r) => r.key)).toEqual([]);
    expect(rows.some((r) => r.key === ENABLED_CSS_SNIPPETS_KEY)).toBe(false);
  });
});

describe("memberCountLabel", () => {
  it("is copy-contract exact for themes vs. non-themes presets", () => {
    expect(memberCountLabel(true, 3)).toBe("· 3 themes");
    expect(memberCountLabel(false, 5)).toBe("· 5 files");
    expect(memberCountLabel(false, 0)).toBe("· 0 files");
  });
});

describe("applyPerItemToggle / encryptToggleDisabled (final-review MUST-FIX 2 — Encrypt and Per-item scopes are mutually exclusive per rule)", () => {
  it("enabling Per-item on an already-encrypted key clears encrypted in the SAME write", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { userIgnoreFilters: { scope: "all", encrypted: true } }, perItem: {} };
    const next = applyPerItemToggle(sf, "userIgnoreFilters", true);
    expect(next.rules.userIgnoreFilters).toEqual({ scope: "all", encrypted: false });
    expect(next.perItem.userIgnoreFilters).toEqual({});
  });

  it("enabling Per-item on a non-encrypted key leaves its scope untouched", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { userIgnoreFilters: { scope: "desktop", encrypted: false } }, perItem: {} };
    const next = applyPerItemToggle(sf, "userIgnoreFilters", true);
    expect(next.rules.userIgnoreFilters).toEqual({ scope: "desktop", encrypted: false });
  });

  it("enabling Per-item on a key with no rule yet seeds the inert default (not encrypted)", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perItem: {} };
    const next = applyPerItemToggle(sf, "someKey", true);
    expect(next.rules.someKey).toEqual({ scope: "all", encrypted: false });
    expect(next.perItem.someKey).toEqual({});
  });

  it("disabling Per-item removes the perItem entry, leaving the rule (incl. its encrypted flag) untouched", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { a: { scope: "all", encrypted: false } }, perItem: { a: { x: "desktop" } } };
    const next = applyPerItemToggle(sf, "a", false);
    expect(next.perItem).not.toHaveProperty("a");
    expect(next.rules.a).toEqual({ scope: "all", encrypted: false });
  });

  it("encryptToggleDisabled: disabled for local scope OR when per-item is enabled", () => {
    expect(encryptToggleDisabled("all", false)).toBe(false);
    expect(encryptToggleDisabled("local", false)).toBe(true);
    expect(encryptToggleDisabled("all", true)).toBe(true);
    expect(encryptToggleDisabled("local", true)).toBe(true);
  });
});

describe("buildPerItemElementRows", () => {
  it("defaults an unscoped element to 'all'", () => {
    expect(buildPerItemElementRows(["a", "b"], { a: "desktop" })).toEqual([
      { element: "a", scope: "desktop" },
      { element: "b", scope: "all" },
    ]);
  });
});

describe("buildSnippetMemberRows", () => {
  it("unions files on disk with names already scoped, sorted", () => {
    const rows = buildSnippetMemberRows(["b.css", "a.css"], { "c.css": "mobile" });
    expect(rows).toEqual([
      { name: "a.css", scope: "all", fileExists: true },
      { name: "b.css", scope: "all", fileExists: true },
      { name: "c.css", scope: "mobile", fileExists: false },
    ]);
  });

  it("marks scope-only names as orphans", () => {
    const rows = buildSnippetMemberRows(["a.css"], { "gone.css": "mobile" });
    expect(rows).toEqual([
      { name: "a.css", scope: "all", fileExists: true },
      { name: "gone.css", scope: "mobile", fileExists: false },
    ]);
  });
});

describe("withSnippetScope (final-review blocker: clearing the last scoped snippet must not leave an empty enabledCssSnippets map behind)", () => {
  it("setting a non-'all' scope adds the entry", () => {
    const sf: ItemSettingsFile = { mode: "plain", rules: {}, perItem: {} };
    const next = withSnippetScope(sf, "a.css", "desktop");
    expect(next.perItem[ENABLED_CSS_SNIPPETS_KEY]).toEqual({ "a.css": "desktop" });
  });

  it("clearing the only entry back to 'all' removes the ENABLED_CSS_SNIPPETS_KEY entirely, not just its contents", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perItem: { [ENABLED_CSS_SNIPPETS_KEY]: { "a.css": "desktop" } } };
    const next = withSnippetScope(sf, "a.css", "all");
    expect(next.perItem).not.toHaveProperty(ENABLED_CSS_SNIPPETS_KEY);
    expect(deriveMode(next)).toBe("plain");
  });

  it("clearing one of several entries leaves the map (and the key) in place for the rest", () => {
    const sf: ItemSettingsFile = {
      mode: "fields",
      rules: {},
      perItem: { [ENABLED_CSS_SNIPPETS_KEY]: { "a.css": "desktop", "b.css": "mobile" } },
    };
    const next = withSnippetScope(sf, "a.css", "all");
    expect(next.perItem[ENABLED_CSS_SNIPPETS_KEY]).toEqual({ "b.css": "mobile" });
  });

  it("does not mutate the input settings file or its nested maps", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perItem: { [ENABLED_CSS_SNIPPETS_KEY]: { "a.css": "desktop" } } };
    const snapshot = JSON.parse(JSON.stringify(sf)) as ItemSettingsFile;
    withSnippetScope(sf, "a.css", "all");
    withSnippetScope(sf, "b.css", "mobile");
    expect(sf).toEqual(snapshot);
  });
});

describe("buildCompanionRows", () => {
  it("synthesizes an OFF/all-devices row for a preset never toggled yet, flags user-added rows", () => {
    const c = cfg({
      companions: [
        { path: "{configDir}/themes", scope: "all", enabled: true },
        { path: "{configDir}/my-extra", scope: "desktop", enabled: false },
      ],
    });
    const rows = buildCompanionRows(APPEARANCE_DEF, c);
    expect(rows).toEqual([
      { path: "{configDir}/themes", scope: "all", enabled: true, isPreset: true },
      { path: "{configDir}/snippets", scope: "all", enabled: false, isPreset: true }, // never toggled — synthesized default
      { path: "{configDir}/my-extra", scope: "desktop", enabled: false, isPreset: false },
    ]);
  });

  it("a def with no preset companions and an empty config produces no rows — renderCompanionZone still renders the Add-folder entry unconditionally on this empty-array path (spec §5, task-3-brief.md Step 2/4)", () => {
    expect(buildCompanionRows(APP_DEF, cfg())).toEqual([]);
  });
});

describe("zone ① Enabled on (spec §4/§10, D4 — core/community/beta plugin tabs, task-6-brief.md)", () => {
  it("ENABLED_ON_LABEL is copy-contract exact", () => {
    expect(ENABLED_ON_LABEL).toBe("Enabled on");
  });

  it("the zone is present for every core def regardless of settings-file state (full core list, incl. state-only)", () => {
    expect(hasEnablementZone(CORE_STATE_ONLY_DEF)).toBe(true);
    expect(hasEnablementZone(CORE_WITH_FILE_DEF)).toBe(true);
    expect(settingsFileZoneKind(CORE_STATE_ONLY_DEF)).toBe("state-only");
    expect(settingsFileZoneKind(CORE_WITH_FILE_DEF)).toBe("settings");
  });
});

describe("Sync all (spec §4/§5/§10, D11 — one master row per Core/Community/Beta section, no kind-exclusion)", () => {
  const CORE_DEFS = [CORE_STATE_ONLY_DEF, CORE_WITH_FILE_DEF];

  it("copy is exact", () => {
    expect(SYNC_ALL_LABEL).toBe("Sync all");
    expect(SYNC_ALL_HINT).toBe("Toggle every plugin below.");
  });

  it("sectionAllEnabled is false when the section is empty, when some cards are off, true only when every card is on", () => {
    expect(sectionAllEnabled([], {})).toBe(false);
    expect(sectionAllEnabled(CORE_DEFS, {})).toBe(false); // no items entries at all → both default to off
    expect(sectionAllEnabled(CORE_DEFS, { [CORE_STATE_ONLY_DEF.id]: cfg({ enabled: true }) })).toBe(false); // one on, one missing/off
    expect(
      sectionAllEnabled(CORE_DEFS, {
        [CORE_STATE_ONLY_DEF.id]: cfg({ enabled: true }),
        [CORE_WITH_FILE_DEF.id]: cfg({ enabled: true }),
      })
    ).toBe(true);
  });

  it("applySyncAll(on) turns every def in the list on, preserving each cfg's other fields", () => {
    const items = { [CORE_WITH_FILE_DEF.id]: cfg({ enabled: false, enabledOn: "desktop" }) };
    const next = applySyncAll(CORE_DEFS, items, true);
    expect(next[CORE_STATE_ONLY_DEF.id]).toEqual(cfg({ enabled: true }));
    expect(next[CORE_WITH_FILE_DEF.id]).toEqual(cfg({ enabled: true, enabledOn: "desktop" })); // enabledOn untouched
  });

  it("applySyncAll(off) turns every def in the list off — no kind-exclusion, every def in the section participates", () => {
    const items = {
      [CORE_STATE_ONLY_DEF.id]: cfg({ enabled: true }),
      [CORE_WITH_FILE_DEF.id]: cfg({ enabled: true }),
    };
    const next = applySyncAll(CORE_DEFS, items, false);
    expect(next[CORE_STATE_ONLY_DEF.id]?.enabled).toBe(false);
    expect(next[CORE_WITH_FILE_DEF.id]?.enabled).toBe(false);
  });

  it("does not mutate the input items map", () => {
    const items = { [CORE_WITH_FILE_DEF.id]: cfg({ enabled: false }) };
    const snapshot = structuredClone(items);
    applySyncAll(CORE_DEFS, items, true);
    expect(items).toEqual(snapshot);
  });
});

describe("nextScope / scope icon cycle (round-6 定稿: Commander-style scope control)", () => {
  it("cycles field scopes all → desktop → mobile → local → all", () => {
    expect(nextScope("all", FIELD_SCOPE_OPTIONS)).toBe("desktop");
    expect(nextScope("desktop", FIELD_SCOPE_OPTIONS)).toBe("mobile");
    expect(nextScope("mobile", FIELD_SCOPE_OPTIONS)).toBe("local");
    expect(nextScope("local", FIELD_SCOPE_OPTIONS)).toBe("all");
  });

  it("cycles file scopes without local: all → desktop → mobile → all", () => {
    expect(nextScope("all", FILE_SCOPE_OPTIONS)).toBe("desktop");
    expect(nextScope("desktop", FILE_SCOPE_OPTIONS)).toBe("mobile");
    expect(nextScope("mobile", FILE_SCOPE_OPTIONS)).toBe("all");
  });

  it("cycles companion scopes without local: all → desktop → mobile → all", () => {
    expect(nextScope("all", COMPANION_SCOPE_OPTIONS)).toBe("desktop");
    expect(nextScope("mobile", COMPANION_SCOPE_OPTIONS)).toBe("all");
  });

  it("desktop-only ENABLED ON cycle skips mobile: all → desktop → local → all", () => {
    expect(DESKTOP_ONLY_ENABLED_OPTIONS).toEqual(["all", "desktop", "local"]);
    expect(nextScope("all", DESKTOP_ONLY_ENABLED_OPTIONS)).toBe("desktop");
    expect(nextScope("desktop", DESKTOP_ONLY_ENABLED_OPTIONS)).toBe("local");
    expect(nextScope("local", DESKTOP_ONLY_ENABLED_OPTIONS)).toBe("all");
  });

  it("stale stored value missing from the options resumes at the next offered canonical stop (round-8 spec §2)", () => {
    // enabledOn:"mobile" left behind on a plugin that later became desktop-only → local, not "all"
    expect(nextScope("mobile", DESKTOP_ONLY_ENABLED_OPTIONS)).toBe("local");
    // options without local either: mobile wraps past local to all
    expect(nextScope("mobile", ["all", "desktop"])).toBe("all");
    expect(nextScope("local", FILE_SCOPE_OPTIONS)).toBe("all");
  });

  it("maps every scope to a distinct lucide icon", () => {
    expect(SCOPE_ICONS).toEqual({ all: "monitor-smartphone", desktop: "monitor", mobile: "smartphone", local: "airplay" });
    expect(new Set(Object.values(SCOPE_ICONS)).size).toBe(4);
  });

  it("tooltip names the current scope", () => {
    expect(scopeCycleTooltip("all")).toBe("Where it syncs (currently: All devices)");
    expect(scopeCycleTooltip("local")).toBe("Where it syncs (currently: This device)");
  });

  it("tooltip appends the desktop-only note to the all stop", () => {
    expect(scopeCycleTooltip("all", DESKTOP_ONLY_ALL_NOTE)).toBe("Where it syncs (currently: All devices — mobile is excluded automatically)");
  });
});

describe("PREVIEW_LEGEND_ENTRIES (round-7 spec §2, 定稿 B: color dots + neutral words, no emoji)", () => {
  it("lists the three scope dots (preview key classes), then lock, then the hint", () => {
    expect(PREVIEW_LEGEND_ENTRIES).toEqual([
      { kind: "scope", cls: "config-sync-json-desktop", text: "desktop only" },
      { kind: "scope", cls: "config-sync-json-mobile", text: "mobile only" },
      { kind: "scope", cls: "config-sync-json-strip", text: "this device" },
      { kind: "lock", cls: null, text: "encrypted" },
      { kind: "hint", cls: null, text: "click a key to add a rule" },
    ]);
  });

  it("carries a color class exactly on scope entries and no emoji anywhere", () => {
    for (const e of PREVIEW_LEGEND_ENTRIES) {
      expect(e.cls !== null).toBe(e.kind === "scope");
      expect(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(e.text)).toBe(false);
    }
  });
});
