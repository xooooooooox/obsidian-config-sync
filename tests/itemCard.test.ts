import { describe, expect, it } from "vitest";
import {
  applyPerElementToggle,
  applySyncAll,
  buildCompanionRows,
  buildPerElementRows,
  buildRuleRows,
  buildCarrierElementRows,
  buildSnippetMemberRows,
  carrierBadgeCounts,
  carrierListFor,
  computeBadges,
  countClassPinned,
  countEncrypted,
  encryptDisabledForSharing,
  encryptToggleDisabled,
  ENABLED_ON_LABEL,
  fileRuleLegalForMode,
  FILE_SHARING_MENU_UNAVAILABLE_TEXT,
  hasEnablementZone,
  hasKeyRules,
  memberCountLabel,
  nextSharing,
  PREVIEW_LEGEND_ENTRIES,
  DESKTOP_ONLY_ALL_NOTE,
  FIELD_SHARING_OPTIONS,
  FILE_SHARING_OPTIONS,
  COMPANION_DEVICE_OPTIONS,
  sharingIcon,
  sharingLabel,
  sharingCycleTooltip,
  sectionAllEnabled,
  settingsFileZoneKind,
  stateOnlyHint,
  SYNC_ALL_HINT,
  SYNC_ALL_LABEL,
} from "../src/ui/itemCard";
import { defaultSettingsFile, deriveMode, emptyItem, Item, ItemDef, ItemSettingsFile, pruneSettingsFile } from "../src/core/registry";
import { perElementKeyFor } from "../src/core/switchList";
import { itemsIn } from "./items";
import { EVERYWHERE, perClass, Sharing, THIS_DEVICE } from "../src/core/types";

// spec docs/superpowers/specs/2026-07-25-unified-card-design.md §4/§5/§10; task-5-brief.md;
// docs/superpowers/specs/2026-07-26-ui-feedback-round2-design.md §2 (app-slice mechanism removed).

function def(overrides: Partial<ItemDef> = {}): ItemDef {
  return { id: "app", groupName: "app", label: "App settings", description: "d", section: "obsidian", ...overrides };
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
  id: "zk-prefixer",
  groupName: "zk-prefixer",
  label: "Unique note creator",
  section: "core",
  enablement: { list: "core-plugins", element: "zk-prefixer" },
  settingsFile: { defaultPath: null },
});
const CORE_WITH_FILE_DEF: ItemDef = def({
  id: "graph",
  groupName: "graph",
  label: "Graph view",
  section: "core",
  enablement: { list: "core-plugins", element: "graph" },
  settingsFile: { defaultPath: "{configDir}/graph.json" },
});
const COMMUNITY_DEF: ItemDef = def({
  id: "dataview",
  groupName: "plugin-dataview",
  label: "Dataview",
  section: "community",
  enablement: { list: "community-plugins", element: "dataview" },
  settingsFile: { defaultPath: "{configDir}/plugins/dataview/data.json" },
});

function cfg(overrides: Partial<Item> = {}): Item {
  return { ...emptyItem(), ...overrides };
}

// computeBadges' enablement badge reads the TWO LAYERS (spec 2026-08-12 §5), not the item's own
// runsOn: the fleet rule from the carrier plus this device's own exception. `null` = the def has no
// enablement projection at all. An exception outranks the rule, exactly as a run does.
const RULE = (r: Sharing, exception: "on" | "off" | null = null): { rule: Sharing; exception: "on" | "off" | null } => ({ rule: r, exception });
const FOLLOWS_ALL = RULE(EVERYWHERE);

describe("computeBadges", () => {
  it("state-only def gets the on/off-only badge first, with tooltip", () => {
    const def: ItemDef = { id: "bases", groupName: "bases", label: "Bases", description: "", section: "core", settingsFile: { defaultPath: null } };
    const badges = computeBadges(def, { synced: true }, null, null);
    expect(badges[0]).toEqual({
      text: "on/off only",
      cls: "config-sync-card-badge-state",
      icon: "toggle-left",
      tooltip: "No settings file on this device yet — only the on/off state syncs.",
    });
  });

  it("a def with a settings file gets no on/off-only badge", () => {
    const def: ItemDef = { id: "backlinks", groupName: "backlinks", label: "Backlinks", description: "", section: "core", settingsFile: { defaultPath: "{configDir}/backlink.json" } };
    expect(computeBadges(def, { synced: true }, null, null).some((b) => b.text === "on/off only")).toBe(false);
  });

  it("no badges for a plain off/default card", () => {
    expect(computeBadges(APP_DEF, cfg(), null, null)).toEqual([]);
  });

  it("an All-devices rule with no exception never shows an on: badge, even with enablement", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg({ synced: true }), FOLLOWS_ALL, null)).toEqual([]);
    expect(computeBadges(COMMUNITY_DEF, cfg({ synced: true }), null, null)).toEqual([]);
  });

  // "Each device decides" is a FLEET arrangement, not this device's own state — there is nothing
  // true to say about this machine until it actually takes an exception.
  it("an Each-device-decides rule with no exception shows no badge either", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg({ synced: true }), RULE(THIS_DEVICE), null)).toEqual([]);
  });

  it("desktop-only def prepends the innate grey chip ahead of every config badge (round-8 spec §2)", () => {
    const dOnly: ItemDef = { ...COMMUNITY_DEF, desktopOnly: true };
    expect(computeBadges(dOnly, cfg(), FOLLOWS_ALL, null)).toEqual([{ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" }]);
    expect(computeBadges(dOnly, cfg(), RULE(perClass("desktop")), null)).toEqual([
      { text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" },
      { text: "on: desktop", cls: "config-sync-card-badge-desktop", icon: "monitor" },
    ]);
  });

  it("a class rule shows the matching on: badge — only when the def has an enablement", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg(), RULE(perClass("desktop")), null)).toEqual([{ text: "on: desktop", cls: "config-sync-card-badge-desktop", icon: "monitor" }]);
    expect(computeBadges(COMMUNITY_DEF, cfg(), RULE(perClass("mobile")), null)).toEqual([{ text: "on: mobile", cls: "config-sync-card-badge-mobile", icon: "smartphone" }]);
    // no-enablement card (app): the same input produces NO badge — the projection doesn't exist
    // for this card at all.
    expect(computeBadges(APP_DEF, cfg(), RULE(perClass("desktop")), null)).toEqual([]);
  });

  it("shows 'on: this device' from THIS DEVICE's exception, and it outranks the fleet rule", () => {
    expect(computeBadges(COMMUNITY_DEF, cfg(), RULE(EVERYWHERE, "on"), null)).toEqual([{ text: "on: this device", cls: "config-sync-card-badge-local", icon: "corner-down-right" }]);
    expect(computeBadges(COMMUNITY_DEF, cfg(), RULE(EVERYWHERE, "off"), null)).toEqual([{ text: "on: this device", cls: "config-sync-card-badge-local", icon: "corner-down-right" }]);
    // precedence 1: the class rule loses to the exception, exactly as decideEnablement decides
    expect(computeBadges(COMMUNITY_DEF, cfg(), RULE(perClass("desktop"), "off"), null)).toEqual([{ text: "on: this device", cls: "config-sync-card-badge-local", icon: "corner-down-right" }]);
    expect(computeBadges(COMMUNITY_DEF, cfg(), FOLLOWS_ALL, null)).toEqual([]);
  });

  it("counts device-scoped fields, per-element entries, and the fileRule together", () => {
    const c = cfg({
      settingsFile: {
        mode: "fields",
        rules: { a: { sharing: perClass("desktop"), encrypted: false }, b: { sharing: perClass("mobile"), encrypted: false }, c: { sharing: EVERYWHERE, encrypted: false } },
        perElement: { arr: { x: perClass("desktop"), y: perClass("mobile"), z: EVERYWHERE } },
      },
    });
    expect(countClassPinned(c)).toBe(4); // a, b, arr.x, arr.y
    const withFileRule = cfg({ settingsFile: { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("desktop"), encrypted: false } } });
    expect(countClassPinned(withFileRule)).toBe(1);
  });

  it("counts encrypted fields AND a fileRule-encrypted whole file into the SAME 'N encrypted' badge (no separate lock badge string)", () => {
    const fieldsEncrypted = cfg({ settingsFile: { mode: "fields", rules: { a: { sharing: EVERYWHERE, encrypted: true }, b: { sharing: EVERYWHERE, encrypted: false } }, perElement: {} } });
    expect(countEncrypted(fieldsEncrypted)).toBe(1);
    const fileEncrypted = cfg({ settingsFile: { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: EVERYWHERE, encrypted: true } } });
    expect(countEncrypted(fileEncrypted)).toBe(1);
    expect(computeBadges(HOTKEYS_DEF, fileEncrypted, null, null)).toEqual([{ text: "1 encrypted", cls: "config-sync-card-badge-count", icon: "lock", count: 1 }]);
  });

  it("badge order is on: -> device-scoped -> encrypted, omitting zero counts", () => {
    const c = cfg({
      settingsFile: { mode: "fields", rules: { a: { sharing: perClass("mobile"), encrypted: true } }, perElement: {} },
    });
    expect(computeBadges(COMMUNITY_DEF, c, RULE(perClass("desktop")), null)).toEqual([
      { text: "on: desktop", cls: "config-sync-card-badge-desktop", icon: "monitor" },
      { text: "1 device-scoped", cls: "config-sync-card-badge-count", icon: "monitor-smartphone", count: 1 },
      { text: "1 encrypted", cls: "config-sync-card-badge-count", icon: "lock", count: 1 },
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
    const empty: ItemSettingsFile = { mode: "plain", rules: {}, perElement: {} };
    expect(deriveMode(empty)).toBe("plain");
    expect(deriveMode({ ...empty, rules: { a: { sharing: perClass("desktop"), encrypted: false } } })).toBe("fields");
    expect(deriveMode({ ...empty, perElement: { arr: { x: perClass("desktop") } } })).toBe("fields");
    expect(hasKeyRules(cfg())).toBe(false);
  });
});

// C-#25: mirrors manifest.ts's parseGroup fileRule validator (type:"file" plain-mode groups
// only) — every registry item already compiles to type:"file", so mode is the only surviving
// gate the Sync Center row and setItemFileScope's guard both need to agree on.
describe("fileRuleLegalForMode (C-#25 — mirrors manifest.ts's fileRule validator)", () => {
  it("plain (or absent, which defaults to plain) is legal; fields and encrypted are not", () => {
    expect(fileRuleLegalForMode(undefined)).toBe(true);
    expect(fileRuleLegalForMode("plain")).toBe(true);
    expect(fileRuleLegalForMode("fields")).toBe(false);
    expect(fileRuleLegalForMode("encrypted")).toBe(false);
  });
});

// C-#25 copy contract: the Sync Center row shows this instead of a menu when the helper above is
// false — pinned here so a future edit to either string can't drift them apart silently.
describe("FILE_SHARING_MENU_UNAVAILABLE_TEXT", () => {
  it("matches the copy-contract-exact string", () => {
    expect(FILE_SHARING_MENU_UNAVAILABLE_TEXT).toBe("Per-key rules decide — opens Settings");
  });
});

// C-#26: prune truth table — the exact residue that hit the user on 2026-08-09 (a stray
// fileRule:{sharing: EVERYWHERE,encrypted:false} or an all-default settingsFile surviving a write-back)
// cannot recur.
describe("pruneSettingsFile (C-#26)", () => {
  it("an all-default settingsFile prunes to undefined", () => {
    expect(pruneSettingsFile(defaultSettingsFile())).toBeUndefined();
  });

  it("a fileRule of exactly {scope:'all', encrypted:false} is stripped, pruning the rest to undefined too", () => {
    const sf: ItemSettingsFile = { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: EVERYWHERE, encrypted: false } };
    expect(pruneSettingsFile(sf)).toBeUndefined();
  });

  it("encrypted:true survives even at scope 'all'", () => {
    const sf: ItemSettingsFile = { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: EVERYWHERE, encrypted: true } };
    expect(pruneSettingsFile(sf)).toEqual(sf);
  });

  it("a non-default scope (e.g. 'desktop') survives", () => {
    const sf: ItemSettingsFile = { mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("desktop"), encrypted: false } };
    expect(pruneSettingsFile(sf)).toEqual(sf);
  });

  it("rules content survives regardless of fileRule/mode", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { a: { sharing: perClass("desktop"), encrypted: false } }, perElement: {} };
    expect(pruneSettingsFile(sf)).toEqual(sf);
  });

  it("perItem content survives", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perElement: { arr: { x: perClass("desktop") } } };
    expect(pruneSettingsFile(sf)).toEqual(sf);
  });

  it("a non-plain mode survives even with otherwise-empty rules/perItem", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perElement: {} };
    expect(pruneSettingsFile(sf)).toEqual(sf);
  });

  it("round-trip: desktop -> all lands back on undefined, the same as the pre-existing default (byte-clean)", () => {
    const original = defaultSettingsFile(); // what an absent settingsFile field derives as
    const afterDesktop = pruneSettingsFile({ ...original, fileRule: { sharing: perClass("desktop"), encrypted: false } });
    expect(afterDesktop).toEqual({ mode: "plain", rules: {}, perElement: {}, fileRule: { sharing: perClass("desktop"), encrypted: false } });
    const afterAll = pruneSettingsFile({ ...(afterDesktop as ItemSettingsFile), fileRule: { sharing: EVERYWHERE, encrypted: false } });
    expect(afterAll).toBeUndefined();
  });
});

describe("encryptDisabledForSharing", () => {
  it("is true only for this-device", () => {
    expect(encryptDisabledForSharing(THIS_DEVICE)).toBe(true);
    expect(encryptDisabledForSharing(EVERYWHERE)).toBe(false);
    expect(encryptDisabledForSharing(perClass("desktop"))).toBe(false);
    expect(encryptDisabledForSharing(perClass("mobile"))).toBe(false);
  });
});

describe("buildRuleRows (spec 2026-07-26-card-visual-refresh-design.md §3 — the only rule-row model; supersedes the deleted buildFieldRows)", () => {
  it("lists ONLY configured keys, not every live-doc key", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { ruled: { sharing: perClass("desktop"), encrypted: false } }, perElement: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { ruled: 1, unruled: 2 });
    expect(rows.map((r) => r.key)).toEqual(["ruled"]);
  });

  it("includes perItem-only keys and marks isArray from the live doc", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perElement: { list: { a: perClass("desktop") } } } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { list: ["a"] });
    expect(rows).toEqual([expect.objectContaining({ key: "list", isArray: true, perElementEnabled: true })]);
  });

  it("a key not present in the live doc defaults isArray to false", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { gone: { sharing: EVERYWHERE, encrypted: false } }, perElement: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, {});
    expect(rows).toEqual([{ key: "gone", isArray: false, rule: { sharing: EVERYWHERE, encrypted: false }, perElementEnabled: false }]);
  });

  it("rules-key order first, then perItem-only keys, no duplicates for a key present in both", () => {
    const c = cfg({
      settingsFile: {
        mode: "fields",
        rules: { a: { sharing: perClass("desktop"), encrypted: false }, b: { sharing: EVERYWHERE, encrypted: false } },
        perElement: { b: { x: perClass("mobile") }, c: { y: EVERYWHERE } },
      },
    });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { a: 1, b: ["x"], c: ["y"] });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("returns no rows when settingsFile is absent", () => {
    expect(buildRuleRows(HOTKEYS_DEF, cfg(), { anything: 1 })).toEqual([]);
  });

  it("a ruled key with a non-string-array value gets isArray false", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { items: { sharing: EVERYWHERE, encrypted: false } }, perElement: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { items: [{ a: 1 }] });
    expect(rows).toEqual([expect.objectContaining({ key: "items", isArray: false })]);
  });

  // Producer versus producer (spec §9 lesson 3): the key an enablement list's rules live under is
  // `perElementKeyFor`'s answer, so the exclusion is asserted against that producer — never against
  // the literal `enabledCssSnippets`, and never against a bare `""`. A test pinned to a literal
  // passes while the producer drifts, which is the exact failure this release exists to end.
  it("appearance pointer-row logic: the snippet rules' key is excluded from rule rows (like buildFieldRows)", () => {
    const key = perElementKeyFor("enabled-css-snippets");
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perElement: { [key]: { x: perClass("desktop") } } } });
    const rows = buildRuleRows(APPEARANCE_DEF, c, { cssTheme: "dark", [key]: ["a.css"] });
    expect(rows.map((r) => r.key)).toEqual([]);
  });

  // The same exclusion, for the other two cards that keep enablement rules in perElement. A whole-
  // file list's key has no name to show, and its rules already have rows of their own in the
  // carrier's drawer (spec §6.4) — before task 12 the first rule a user set on either list put a
  // nameless row, with a ✕, into the card's Settings-file zone.
  it("a carrier card's own rule key is excluded from rule rows, and its real keys are not", () => {
    const carrier: ItemDef = def({ id: "community-plugins", groupName: "community-plugins", label: "Community plugins" });
    const key = perElementKeyFor("community-plugins");
    const c = cfg({ settingsFile: { mode: "plain", rules: {}, perElement: { [key]: { dataview: perClass("desktop") } } } });
    expect(buildRuleRows(carrier, c, { dataview: true })).toEqual([]);

    const alsoRuled = cfg({
      settingsFile: { mode: "fields", rules: { someKey: { sharing: EVERYWHERE, encrypted: false } }, perElement: { [key]: { dataview: perClass("desktop") } } },
    });
    expect(buildRuleRows(carrier, alsoRuled, {}).map((r) => r.key)).toEqual(["someKey"]);
  });

  // …and the exclusion is per CARD, not global: the snippet key on a card that does not carry that
  // list is an ordinary rule row, exactly as it was before.
  it("the same key on a card that carries no list is still an ordinary rule row", () => {
    const key = perElementKeyFor("enabled-css-snippets");
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perElement: { [key]: { x: perClass("desktop") } } } });
    expect(buildRuleRows(HOTKEYS_DEF, c, { [key]: ["a.css"] }).map((r) => r.key)).toEqual([key]);
  });
});

describe("memberCountLabel", () => {
  // Round-12 甲: the pill shows the bare number now — this is its aria-label/tooltip full form,
  // no leading `· ` separator.
  it("is copy-contract exact for themes vs. non-themes presets", () => {
    expect(memberCountLabel(true, 3)).toBe("3 themes");
    expect(memberCountLabel(false, 5)).toBe("5 files");
    expect(memberCountLabel(false, 0)).toBe("0 files");
  });
});

describe("applyPerElementToggle / encryptToggleDisabled (final-review MUST-FIX 2 — Encrypt and Per-item scopes are mutually exclusive per rule)", () => {
  it("enabling Per-item on an already-encrypted key clears encrypted in the SAME write", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { userIgnoreFilters: { sharing: EVERYWHERE, encrypted: true } }, perElement: {} };
    const next = applyPerElementToggle(sf, "userIgnoreFilters", true);
    expect(next.rules.userIgnoreFilters).toEqual({ sharing: EVERYWHERE, encrypted: false });
    expect(next.perElement.userIgnoreFilters).toEqual({});
  });

  it("enabling Per-item on a non-encrypted key leaves its scope untouched", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { userIgnoreFilters: { sharing: perClass("desktop"), encrypted: false } }, perElement: {} };
    const next = applyPerElementToggle(sf, "userIgnoreFilters", true);
    expect(next.rules.userIgnoreFilters).toEqual({ sharing: perClass("desktop"), encrypted: false });
  });

  it("enabling Per-item on a key with no rule yet seeds the inert default (not encrypted)", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: {}, perElement: {} };
    const next = applyPerElementToggle(sf, "someKey", true);
    expect(next.rules.someKey).toEqual({ sharing: EVERYWHERE, encrypted: false });
    expect(next.perElement.someKey).toEqual({});
  });

  it("disabling Per-item removes the perItem entry, leaving the rule (incl. its encrypted flag) untouched", () => {
    const sf: ItemSettingsFile = { mode: "fields", rules: { a: { sharing: EVERYWHERE, encrypted: false } }, perElement: { a: { x: perClass("desktop") } } };
    const next = applyPerElementToggle(sf, "a", false);
    expect(next.perElement).not.toHaveProperty("a");
    expect(next.rules.a).toEqual({ sharing: EVERYWHERE, encrypted: false });
  });

  it("encryptToggleDisabled: disabled for this-device sharing OR when per-element is enabled", () => {
    expect(encryptToggleDisabled(EVERYWHERE, false)).toBe(false);
    expect(encryptToggleDisabled(THIS_DEVICE, false)).toBe(true);
    expect(encryptToggleDisabled(EVERYWHERE, true)).toBe(true);
    expect(encryptToggleDisabled(THIS_DEVICE, true)).toBe(true);
  });
});

describe("buildPerElementRows", () => {
  it("defaults an unruled element to everywhere", () => {
    expect(buildPerElementRows(["a", "b"], { a: perClass("desktop") })).toEqual([
      { element: "a", sharing: perClass("desktop") },
      { element: "b", sharing: EVERYWHERE },
    ]);
  });
});

describe("buildSnippetMemberRows", () => {
  it("unions files on disk with names already scoped, sorted", () => {
    const rows = buildSnippetMemberRows(["b.css", "a.css"], { "c.css": perClass("mobile") });
    expect(rows).toEqual([
      { name: "a.css", fileExists: true },
      { name: "b.css", fileExists: true },
      { name: "c.css", fileExists: false },
    ]);
  });

  it("marks rule-only names as orphans", () => {
    const rows = buildSnippetMemberRows(["a.css"], { "gone.css": perClass("mobile") });
    expect(rows).toEqual([
      { name: "a.css", fileExists: true },
      { name: "gone.css", fileExists: false },
    ]);
  });
});

// `withSnippetSharing` retired here (task 12): a snippet's rule is written by `withEnablementRule`
// like every other element's, and this describe's subject — clearing the last scoped snippet must
// not leave an empty enabledCssSnippets map behind — is asserted against that writer in
// tests/enablementRules.test.ts, on the same key this one used.

// The two carrier cards (spec §6.4). `carrierListFor` is THE producer of "this card carries a
// list"; the badges, the drawer's section and its rows all ask it, so these assert the answer for
// each of the five Obsidian cards rather than for the two that say yes.
describe("carrierListFor", () => {
  it("answers each list for the card that carries it, and null for every other card", () => {
    expect(carrierListFor(def({ id: "core-plugins", groupName: "core-plugins", label: "Core plugins" }))).toBe("core-plugins");
    expect(carrierListFor(def({ id: "community-plugins", groupName: "community-plugins", label: "Community plugins" }))).toBe("community-plugins");
    expect(carrierListFor(APP_DEF)).toBeNull();
    expect(carrierListFor(APPEARANCE_DEF)).toBeNull(); // it CARRIES the snippet rules, but under a field, not as a list card
    expect(carrierListFor(HOTKEYS_DEF)).toBeNull();
  });

  it("a plugin whose id happens to match a list id is not a carrier — only the Obsidian card is", () => {
    expect(carrierListFor(def({ section: "community", id: "core-plugins", groupName: "plugin-core-plugins", label: "Impostor" }))).toBeNull();
  });
});

describe("carrierBadgeCounts", () => {
  const withRules = (rules: Record<string, Sharing>): ReturnType<typeof itemsIn> =>
    itemsIn({ obsidian: { "community-plugins": { synced: true, settingsFile: { mode: "plain", rules: {}, perElement: { "": rules } } } } });

  it("counts class rules for the fleet and this device's exceptions for the local half — never one number", () => {
    const items = withRules({ dataview: perClass("desktop"), templater: perClass("mobile"), git: THIS_DEVICE });
    expect(carrierBadgeCounts(items, "community-plugins", ["git", "omnisearch"])).toEqual({ fleet: 2, local: 2 });
  });

  it("`Each device decides` is not device-scoped — it hands the element back, it does not scope it", () => {
    expect(carrierBadgeCounts(withRules({ git: THIS_DEVICE }), "community-plugins", [])).toEqual({ fleet: 0, local: 0 });
  });

  it("a list with nothing decided counts nothing (a badge never reads '0 …')", () => {
    expect(carrierBadgeCounts(itemsIn({}), "core-plugins", [])).toEqual({ fleet: 0, local: 0 });
  });

  // Final-review IMPORTANT 3: the carrier's OWN class pins (fileRule.sharing — settable from the
  // Sync Center's Default settings sync row — and any class-pinned `rules` entry) must join the
  // element class rules in the SAME "N device-scoped" count, without double-counting: `perElement`
  // holds the element rules already counted above, so folding in `countClassPinned` whole (which also
  // walks `perElement`) would count them twice.
  it("composes the carrier's own fileRule/rules class pins with its element class rules, without double-counting", () => {
    const items = itemsIn({
      obsidian: {
        "core-plugins": {
          synced: true,
          settingsFile: {
            mode: "plain",
            rules: { "some-key": { sharing: perClass("mobile"), encrypted: false } },
            perElement: { "": { "daily-notes": perClass("desktop"), graph: THIS_DEVICE } },
            fileRule: { sharing: perClass("desktop"), encrypted: false },
          },
        },
      },
    });
    // element class rules: daily-notes only (graph is this-device, not class-scoped) = 1
    // carrier's own pins: fileRule (1) + rules["some-key"] (1) = 2
    expect(carrierBadgeCounts(items, "core-plugins", [])).toEqual({ fleet: 3, local: 0 });
  });
});

describe("buildCarrierElementRows", () => {
  const DEFS: ItemDef[] = [
    COMMUNITY_DEF, // Dataview
    def({ section: "community", id: "templater", groupName: "plugin-templater", label: "Templater", enablement: { list: "community-plugins", element: "templater" } }),
    def({ section: "community", id: "git", groupName: "plugin-git", label: "Obsidian Git", desktopOnly: true, enablement: { list: "community-plugins", element: "git" } }),
    CORE_WITH_FILE_DEF, // Graph view, a DIFFERENT list
  ];

  it("lists this list's installed elements by display label, carrying the desktop-only flag", () => {
    expect(buildCarrierElementRows(DEFS, "community-plugins", [], [])).toEqual([
      { elementId: "dataview", label: "Dataview", desktopOnly: false },
      { elementId: "git", label: "Obsidian Git", desktopOnly: true },
      { elementId: "templater", label: "Templater", desktopOnly: false },
    ]);
  });

  it("keeps an element that is no longer installed but still has a rule or an exception — under its raw id", () => {
    const rows = buildCarrierElementRows(DEFS, "community-plugins", ["zz-uninstalled"], ["aa-gone"]);
    expect(rows.map((r) => r.elementId)).toEqual(["aa-gone", "dataview", "git", "templater", "zz-uninstalled"]);
    expect(rows[0]).toEqual({ elementId: "aa-gone", label: "aa-gone", desktopOnly: false });
  });

  it("an installed element that also has a rule appears once", () => {
    expect(buildCarrierElementRows(DEFS, "community-plugins", ["dataview"], ["dataview"]).filter((r) => r.elementId === "dataview")).toHaveLength(1);
  });
});

describe("buildCompanionRows", () => {
  it("synthesizes an OFF/all-devices row for a preset never toggled yet, flags user-added rows", () => {
    const c = cfg({
      companions: [
        { path: "{configDir}/themes", device: "all", enabled: true },
        { path: "{configDir}/my-extra", device: "desktop", enabled: false },
      ],
    });
    const rows = buildCompanionRows(APPEARANCE_DEF, c);
    expect(rows).toEqual([
      { path: "{configDir}/themes", device: "all", enabled: true, isPreset: true },
      { path: "{configDir}/snippets", device: "all", enabled: false, isPreset: true }, // never toggled — synthesized default
      { path: "{configDir}/my-extra", device: "desktop", enabled: false, isPreset: false },
    ]);
  });

  it("a def with no preset companions and an empty config produces no rows — renderCompanionZone still renders the Add-folder entry unconditionally on this empty-array path (spec §5, task-3-brief.md Step 2/4)", () => {
    expect(buildCompanionRows(APP_DEF, cfg())).toEqual([]);
  });

  it("an absent companions key reads exactly like an empty list — presets still synthesize their rows (§5.2)", () => {
    expect(buildCompanionRows(APPEARANCE_DEF, { synced: true })).toEqual(buildCompanionRows(APPEARANCE_DEF, { synced: true, companions: [] }));
    expect(buildCompanionRows(APPEARANCE_DEF, { synced: true })).toEqual([
      { path: "{configDir}/themes", device: "all", enabled: false, isPreset: true },
      { path: "{configDir}/snippets", device: "all", enabled: false, isPreset: true },
    ]);
  });
});

describe("zone ① Enabled on (spec §4/§10, D4 — core/community/beta plugin tabs, task-6-brief.md)", () => {
  it("ENABLED_ON_LABEL is copy-contract exact (round-9 ① shortened row label)", () => {
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
    expect(sectionAllEnabled([], itemsIn({}))).toBe(false);
    expect(sectionAllEnabled(CORE_DEFS, itemsIn({}))).toBe(false); // no items entries at all → both default to off
    expect(sectionAllEnabled(CORE_DEFS, itemsIn({ core: { [CORE_STATE_ONLY_DEF.id]: cfg({ synced: true }) } }))).toBe(false); // one on, one missing/off
    expect(
      sectionAllEnabled(
        CORE_DEFS,
        itemsIn({ core: { [CORE_STATE_ONLY_DEF.id]: cfg({ synced: true }), [CORE_WITH_FILE_DEF.id]: cfg({ synced: true }) } })
      )
    ).toBe(true);
  });

  it("applySyncAll(on) turns every def in the list on, preserving each item's other fields", () => {
    const items = itemsIn({ core: { [CORE_WITH_FILE_DEF.id]: cfg({ synced: false, description: "kept" }) } });
    const next = applySyncAll(CORE_DEFS, items, true);
    expect(next.core[CORE_STATE_ONLY_DEF.id]).toEqual({ synced: true });
    expect(next.core[CORE_WITH_FILE_DEF.id]).toEqual(cfg({ synced: true, description: "kept" })); // the other field is untouched
  });

  // Every entry SURVIVES being turned off. In the enablement sections an entry's presence is this
  // device's capture mask for that element, so "off" has to be recorded rather than pruned —
  // final-review C1, and the reason withItem removes nothing.
  it("applySyncAll(off) turns every def in the list off — no kind-exclusion, every def in the section participates", () => {
    const items = itemsIn({
      core: { [CORE_STATE_ONLY_DEF.id]: cfg({ synced: true }), [CORE_WITH_FILE_DEF.id]: cfg({ synced: true, description: "kept" }) },
    });
    const next = applySyncAll(CORE_DEFS, items, false);
    expect(next.core[CORE_STATE_ONLY_DEF.id]).toEqual({ synced: false });
    expect(next.core[CORE_WITH_FILE_DEF.id]).toEqual(cfg({ synced: false, description: "kept" })); // the other field is untouched
  });

  it("does not mutate the input items map", () => {
    const items = itemsIn({ core: { [CORE_WITH_FILE_DEF.id]: cfg({ synced: false }) } });
    const snapshot = structuredClone(items);
    applySyncAll(CORE_DEFS, items, true);
    expect(items).toEqual(snapshot);
  });
});

describe("nextSharing / sharing icon cycle (round-6 定稿: Commander-style sharing control)", () => {
  const DESKTOP = perClass("desktop");
  const MOBILE = perClass("mobile");

  it("cycles field sharing everywhere → desktop → mobile → this-device → everywhere", () => {
    expect(nextSharing(EVERYWHERE, FIELD_SHARING_OPTIONS)).toEqual(DESKTOP);
    expect(nextSharing(DESKTOP, FIELD_SHARING_OPTIONS)).toEqual(MOBILE);
    expect(nextSharing(MOBILE, FIELD_SHARING_OPTIONS)).toEqual(THIS_DEVICE);
    expect(nextSharing(THIS_DEVICE, FIELD_SHARING_OPTIONS)).toEqual(EVERYWHERE);
  });

  it("cycles file sharing without this-device: everywhere → desktop → mobile → everywhere", () => {
    expect(nextSharing(EVERYWHERE, FILE_SHARING_OPTIONS)).toEqual(DESKTOP);
    expect(nextSharing(DESKTOP, FILE_SHARING_OPTIONS)).toEqual(MOBILE);
    expect(nextSharing(MOBILE, FILE_SHARING_OPTIONS)).toEqual(EVERYWHERE);
  });

  it("companion device options are the three classes, this-device excluded", () => {
    expect(COMPANION_DEVICE_OPTIONS).toEqual(["all", "desktop", "mobile"]);
  });

  // DESKTOP_ONLY_ENABLED_OPTIONS retired with the two-layer cutover: the desktop-only filter is
  // now applied inline to RULE_OPTIONS by the row that needs it (SettingTab's
  // renderDefaultEnabledOnRow), so there is no second list to keep in step.

  it("stale stored value missing from the options resumes at the next offered canonical stop (round-8 spec §2)", () => {
    // a mobile rule left behind on a plugin that later became desktop-only → this-device, not everywhere
    expect(nextSharing(MOBILE, [EVERYWHERE, DESKTOP, THIS_DEVICE])).toEqual(THIS_DEVICE);
    // options without this-device either: mobile wraps past it to everywhere
    expect(nextSharing(MOBILE, [EVERYWHERE, DESKTOP])).toEqual(EVERYWHERE);
    expect(nextSharing(THIS_DEVICE, FILE_SHARING_OPTIONS)).toEqual(EVERYWHERE);
  });

  it("maps every sharing to a distinct lucide icon", () => {
    const icons = [EVERYWHERE, DESKTOP, MOBILE, THIS_DEVICE].map(sharingIcon);
    expect(icons).toEqual(["monitor-smartphone", "monitor", "smartphone", "airplay"]);
    expect(new Set(icons).size).toBe(4);
  });

  // RUNS_ON_OPTIONS / runsOnIcon / runsOnLabel / runsOnIsDefault retired with the two-layer cutover:
  // the row they served is two segments now, and its vocabulary lives in enablementRow.ts
  // (tests/enablementRow.test.ts).

  it("sharing labels are copy-contract exact", () => {
    expect([EVERYWHERE, DESKTOP, MOBILE, THIS_DEVICE].map(sharingLabel)).toEqual(["All devices", "Desktop only", "Mobile only", "This device"]);
  });

  it("tooltip names the current sharing", () => {
    expect(sharingCycleTooltip(EVERYWHERE)).toBe("Where it syncs (currently: All devices)");
    expect(sharingCycleTooltip(THIS_DEVICE)).toBe("Where it syncs (currently: This device)");
  });

  it("tooltip appends the desktop-only note to the everywhere stop", () => {
    expect(sharingCycleTooltip(EVERYWHERE, DESKTOP_ONLY_ALL_NOTE)).toBe("Where it syncs (currently: All devices — mobile is excluded automatically)");
  });
});

describe("PREVIEW_LEGEND_ENTRIES (round-7 spec §2, 定稿 B: color dots + neutral words, no emoji)", () => {
  it("lists the three sharing dots (preview key classes), then lock — no trailing hint (定稿轮 19 ②: the action sentence moved to the preview's top line)", () => {
    expect(PREVIEW_LEGEND_ENTRIES).toEqual([
      { kind: "sharing", cls: "config-sync-json-desktop", text: "desktop only" },
      { kind: "sharing", cls: "config-sync-json-mobile", text: "mobile only" },
      { kind: "sharing", cls: "config-sync-json-strip", text: "this device" },
      { kind: "lock", cls: null, text: "encrypted" },
    ]);
  });

  it("carries a color class exactly on sharing entries and no emoji anywhere", () => {
    for (const e of PREVIEW_LEGEND_ENTRIES) {
      expect(e.cls !== null).toBe(e.kind === "sharing");
      expect(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u.test(e.text)).toBe(false);
    }
  });
});
