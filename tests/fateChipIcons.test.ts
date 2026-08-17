import { describe, it, expect } from "vitest";
import { FATE_CHIP_ICON } from "../src/ui/fateChipIcons";
import { ACTION_ICON } from "../src/ui/actionIcons";
import { FOLD_ICON } from "../src/ui/foldIcons";
import { buildOptOutLocalMenu, buildLocalMenu, enablementRowModel, fileEnablementRowModel, ruleIcon, ruleLabel, RULE_OPTIONS } from "../src/ui/enablementRow";
import { Badge, computeBadges } from "../src/ui/itemCard";
import { Item, ItemDef, ItemSettingsFile } from "../src/core/registry";
import { EVERYWHERE, perClass } from "../src/core/types";

// Every string buildChips (fateModel.ts) can produce, plus the two chips added
// at render time, must resolve to an icon; an unknown chip string is simply absent from the map
// (text-only fallback lives in the renderer) rather than throwing.
describe("FATE_CHIP_ICON — chip→icon map completeness", () => {
  const chips = [
    "not installed here",
    "desktop only",
    "your rule",
    "off here — your rule",
    "on here — your rule",
    "stays off",
    "encrypted",
    "your choice",
  ];

  it("maps every buildChips string + the two render-time chips to an icon", () => {
    for (const chip of chips) expect(FATE_CHIP_ICON[chip]).toBeTruthy();
  });

  it("uses the exact icons named in the spec", () => {
    expect(FATE_CHIP_ICON).toEqual({
      "not installed here": "circle-dashed",
      "desktop only": "monitor",
      "your rule": "sliders-horizontal",
      "off here — your rule": "sliders-horizontal",
      "on here — your rule": "sliders-horizontal",
      // `power` means the local-exception ON state (2026-08-12-enablement-two-layers-design.md
      // §7) — a chip that says the row stays off must not share it.
      "stays off": "power-off",
      encrypted: "lock",
      "your choice": "check",
    });
  });

  it("an unknown chip string has no icon (renderer falls back to text-only)", () => {
    expect(FATE_CHIP_ICON["some future chip"]).toBeUndefined();
  });
});

// Registry-level guard ("one glyph, one meaning"): glyph collisions are easy to introduce by
// hand — e.g. `power` vs `stays off`, or `sliders-horizontal` nearly borrowed for the MORE row
// (SyncCenterView.ts renderMoreRow comment). Every producer below is the REAL exported
// table/function, not a hand-copied literal of it (producer-vs-producer) — if a table's values
// change, this test reads the change instead of going stale next to it.
describe("glyph registry — one glyph, one meaning (icon-collision guard)", () => {
  interface GlyphHome {
    glyph: string;
    producer: string;
    home: string;
  }

  function fateChipHomes(): GlyphHome[] {
    return Object.entries(FATE_CHIP_ICON).map(([key, glyph]) => ({
      glyph,
      producer: "FATE_CHIP_ICON",
      home: `FATE_CHIP_ICON['${key}']`,
    }));
  }

  function actionHomes(): GlyphHome[] {
    return Object.entries(ACTION_ICON).map(([key, glyph]) => ({ glyph, producer: "ACTION_ICON", home: `ACTION_ICON['${key}']` }));
  }

  function foldHomes(): GlyphHome[] {
    return Object.entries(FOLD_ICON).map(([key, glyph]) => ({ glyph, producer: "FOLD_ICON", home: `FOLD_ICON['${key}']` }));
  }

  function ruleHomes(): GlyphHome[] {
    return RULE_OPTIONS.map((rule) => ({ glyph: ruleIcon(rule), producer: "ruleIcon(RULE_OPTIONS)", home: `ruleIcon(${ruleLabel(rule)})` }));
  }

  // The two local-exception glyphs (`power`/`power-off`, enablementRow.ts §6.1's local segment) and
  // the whole-file opt-out's `circle-slash` (§6.2 DEFAULT SETTINGS SYNC) come straight out of the row
  // module's own menu builders — the same functions the row renders through, not a second hand-typed
  // pair of strings sitting next to the real ones.
  function localMenuHomes(): GlyphHome[] {
    const noop = (): void => {};
    const elementMenu = buildLocalMenu(EVERYWHERE, null, { follow: noop, setState: noop });
    const fileMenu = buildOptOutLocalMenu(false, { follow: noop, optOut: noop });
    const homes: GlyphHome[] = [];
    for (const item of elementMenu) if (item.icon !== null) homes.push({ glyph: item.icon, producer: "buildLocalMenu", home: `buildLocalMenu '${item.title}'` });
    for (const item of fileMenu) if (item.icon !== null) homes.push({ glyph: item.icon, producer: "buildOptOutLocalMenu", home: `buildOptOutLocalMenu '${item.title}'` });
    return homes;
  }

  // `settings-2` sits behind no exported table — SyncCenterView.ts sets it directly at each of its
  // call sites (the MORE row, the read-only carrier chip, the Config Sync self-pane tile/button), all
  // for the one meaning "opens Settings". Registered here by hand — the one entry in this test with
  // no producer function to iterate — so a FUTURE table cannot silently claim the same glyph.
  //
  // Five more hardcoded glyphs, none behind an exported table either — the FILES
  // row's per-entry diff/view affordance (SyncCenterView.ts) and the diff panel's segmented
  // toggles (diffView.ts). Each carries exactly one meaning; registering them here (rather than
  // leaving them invisible to this guard) means a future reuse of any of the five for something
  // else fails loudly instead of silently colliding.
  const EXTERNAL_HOMES: GlyphHome[] = [
    { glyph: "settings-2", producer: "SyncCenterView (external, hardcoded)", home: "SyncCenterView 'opens Settings' sites" },
    { glyph: "file-diff", producer: "SyncCenterView (external, hardcoded)", home: "renderUnifiedFiles — view this entry's changes/content" },
    { glyph: "rows-2", producer: "diffView (external, hardcoded)", home: "renderDiffPanel — unified diff" },
    { glyph: "columns-2", producer: "diffView (external, hardcoded)", home: "renderDiffPanel — split diff" },
    { glyph: "fold-vertical", producer: "diffView (external, hardcoded)", home: "renderDiffPanel — collapse unchanged lines" },
    { glyph: "unfold-vertical", producer: "diffView (external, hardcoded)", home: "renderDiffPanel — show all lines" },
    // Text-triangle sweep (DESIGN.md §2.4): the two chevron families, plus the File
    // preview trigger — none behind an exported table either.
    { glyph: "chevron-right", producer: "foldChevron (external, hardcoded)", home: "renderFoldChevron — FOLD family disclosure rotate" },
    { glyph: "chevrons-up-down", producer: "SyncCenterView/SettingTab (external, hardcoded)", home: "PICKER family — two-segment rows + the switcher" },
    { glyph: "eye", producer: "SettingTab (external, hardcoded)", home: "SETTINGS SYNC row — File preview trigger" },
    // DESIGN.md §2.3: the per-item icon toggle, the menu-borne destructive verb, and
    // the File preview's top action line — hardcoded in SettingTab.ts, registered here so a
    // future reuse for a different meaning fails loudly.
    { glyph: "list-checks", producer: "SettingTab (external, hardcoded)", home: "rule row — Per-item device rules icon toggle" },
    { glyph: "trash", producer: "SettingTab/SyncCenterView (external, hardcoded)", home: "the destructive verb — scope menus' Remove rule / Remove folder, and the Leftover section's per-row + Delete-all deletes" },
    { glyph: "plus", producer: "SettingTab (external, hardcoded)", home: "File preview hint line — click a key to add a rule" },
    // DESIGN.md §2.3: the encrypt toggle's rest state — closed `lock` stays the
    // encrypted state everywhere (mode badge / json keys / legend + the toggle's on-state).
    { glyph: "lock-open", producer: "SettingTab (external, hardcoded)", home: "renderLockToggle — unencrypted-but-available rest state" },
  ];

  // The local segment's `follows` glyph (DESIGN.md icon table): `corner-down-right` is
  // registered nowhere else. Fed from the REAL model functions (enablementRow.ts's
  // `enablementRowModel`/`fileEnablementRowModel`), not a hand-copied string, so a future rename of
  // the glyph breaks this test instead of leaving it silently stale — the same "iterate the real
  // producer" discipline `ruleHomes`/`localMenuHomes` above already follow. Scoped to the `follows`
  // state alone: the on/off/not-synced states already resolve to `power`/`power-off`/`circle-slash`,
  // which `buildLocalMenu`/`buildOptOutLocalMenu` above already register from their OWN producer — a
  // second registration of the same glyphs under a different producer name here would read as an
  // undeclared collision, not the intentional one-meaning reuse it actually is.
  function localSegmentFollowHomes(): GlyphHome[] {
    const homes: GlyphHome[] = [];
    const elementFollow = enablementRowModel({ rule: EVERYWHERE, exception: null }).local.icon;
    if (elementFollow !== null) homes.push({ glyph: elementFollow, producer: "enablementRowModel", home: "enablementRowModel(local, follows)" });
    const fileFollow = fileEnablementRowModel({ sharing: EVERYWHERE, optedOut: false }).local.icon;
    if (fileFollow !== null) homes.push({ glyph: fileFollow, producer: "fileEnablementRowModel", home: "fileEnablementRowModel(local, follows)" });
    return homes;
  }

  // The CARD BADGES, driven through the real `computeBadges`. They were the guard's blind spot, and
  // it cost three separate bugs in one pass: `N left to me` wearing the glyph that meant "no
  // exception", `on: this device` shown for an OFF exception, and `N device-scoped` wearing
  // `monitor-smartphone` — the `All devices` glyph — to count keys that are pointedly not on all
  // devices. None of the three could fail a test that never looked at badges. Every shape that
  // produces a badge is exercised here so a future badge glyph is checked against every other
  // meaning in the product.
  function badgeHomes(): GlyphHome[] {
    const def = (over: Partial<ItemDef> = {}): ItemDef => ({ id: "x", groupName: "x", label: "X", description: "d", section: "obsidian", ...over });
    const plugin = def({ section: "community", enablement: { list: "community-plugins", element: "x" } });
    const item = (sf: Partial<ItemSettingsFile>): Item => ({ synced: true, settingsFile: { mode: "fields", rules: {}, perElement: {}, ...sf } });
    const shapes: Array<{ label: string; badges: Badge[] }> = [
      { label: "enablement rule, class-scoped", badges: computeBadges(plugin, item({}), { rule: perClass("desktop"), exception: null }, null) },
      { label: "enablement exception, on", badges: computeBadges(plugin, item({}), { rule: EVERYWHERE, exception: "on" }, null) },
      { label: "enablement exception, off", badges: computeBadges(plugin, item({}), { rule: EVERYWHERE, exception: "off" }, null) },
      { label: "device-scoped, all one class", badges: computeBadges(def(), item({ rules: { a: { sharing: perClass("mobile"), encrypted: false } } }), null, null) },
      {
        label: "device-scoped, mixed classes",
        badges: computeBadges(def(), item({ rules: { a: { sharing: perClass("mobile"), encrypted: false }, b: { sharing: perClass("desktop"), encrypted: false } } }), null, null),
      },
      { label: "encrypted", badges: computeBadges(def(), item({ rules: { a: { sharing: EVERYWHERE, encrypted: true } } }), null, null) },
      { label: "carrier counts, all one exception state", badges: computeBadges(def(), item({}), null, { fleet: ["desktop"], local: ["on", "on"] }) },
      { label: "carrier counts, mixed exception states", badges: computeBadges(def(), item({}), null, { fleet: [], local: ["on", "off"] }) },
      { label: "desktop-only plugin", badges: computeBadges(def({ section: "community", desktopOnly: true }), item({}), null, null) },
    ];
    return shapes.flatMap((s) =>
      s.badges.flatMap((b) => (b.icon === undefined ? [] : [{ glyph: b.icon, producer: "computeBadges", home: `card badge — ${b.text}` }]))
    );
  }

  function allHomes(): GlyphHome[] {
    return [...fateChipHomes(), ...actionHomes(), ...foldHomes(), ...ruleHomes(), ...localMenuHomes(), ...localSegmentFollowHomes(), ...badgeHomes(), ...EXTERNAL_HOMES];
  }

  // Declared, intentional glyph reuse across producers — the ONLY escape hatch this test allows.
  // Every entry names the ONE meaning the glyph carries everywhere it appears (`monitor` = desktop
  // everywhere it appears; `circle-minus` = "not synced on this device", reused deliberately from
  // the fold family). A glyph reused with two DIFFERENT meanings — e.g. `power` meaning both "this
  // device turned it on" and "the shared list has it off" — is
  // exactly the bug class this test exists to catch.
  const ALLOWED_SHARED_MEANING: Record<string, string> = {
    monitor: "desktop-only device class",
    "power-off": "off, on this device — a resolved fate this run or a local exception, same direction",
    "circle-minus": "not synced with this item, on this device",
    check: "affirmative — settled / already matching, nothing left for this glyph to say",
    // The local segment's `follows` glyph, same meaning whether it's an element-layer
    // exception (enablementRowModel) or the whole-file opt-out layer (fileEnablementRowModel) —
    // "this device matches the shared answer, it has no answer of its own."
    // It was `corner-down-right` until 2026-08-17, when that glyph turned out to be carrying two
    // OPPOSITE meanings across the product: here it said "nothing device-specific", while the card
    // and carrier badges use it for `on: this device` and `N left to me`. Those two agree with each
    // other, so they kept it and this one moved — which is this guard's whole purpose, one glyph
    // one meaning, applied to a collision the guard itself could not see (the badges are not one of
    // the registries it walks).
    equal: "this device matches the shared answer (no answer of its own)",
    // The three the badges brought in when they joined this guard. All same-meaning by
    // construction: a badge summarising rules now speaks the SAME vocabulary those rules do, which
    // is exactly why it collides here and exactly why the collision is legitimate. The glyph it
    // used to wear, `monitor-smartphone`, collided with nothing — because it meant `All devices`,
    // something the badge never counted.
    lock: "encrypted",
    smartphone: "mobile-only device class",
    power: "on, on this device — a local exception, wherever it is summarised",
  };

  it("every producer contributes at least one glyph (an empty producer would pass vacuously)", () => {
    expect(fateChipHomes().length).toBeGreaterThan(0);
    expect(actionHomes().length).toBeGreaterThan(0);
    expect(foldHomes().length).toBeGreaterThan(0);
    expect(ruleHomes().length).toBeGreaterThan(0);
    expect(localMenuHomes().length).toBeGreaterThan(0);
    expect(localSegmentFollowHomes().length).toBeGreaterThan(0);
  });

  it("never lets a glyph carry two undeclared meanings across the fate-chip, action, fold, rule and local-exception registries", () => {
    const byGlyph = new Map<string, GlyphHome[]>();
    for (const h of allHomes()) {
      const list = byGlyph.get(h.glyph) ?? [];
      list.push(h);
      byGlyph.set(h.glyph, list);
    }

    const undeclared: string[] = [];
    for (const [glyph, homes] of byGlyph) {
      const producers = new Set(homes.map((h) => h.producer));
      // Repeated within a single producer (e.g. `sliders-horizontal` across FATE_CHIP_ICON's three
      // "your rule" chips) is that producer's own business, not a cross-registry collision.
      if (producers.size <= 1) continue;
      if (glyph in ALLOWED_SHARED_MEANING) continue;
      undeclared.push(`"${glyph}" is undeclared and used by more than one producer: ${homes.map((h) => h.home).join(", ")}`);
    }

    expect(undeclared).toEqual([]);
  });

  it("has no dead allowlist entry — every declared glyph is still actually shared by more than one producer", () => {
    const producersByGlyph = new Map<string, Set<string>>();
    for (const h of allHomes()) {
      const producers = producersByGlyph.get(h.glyph) ?? new Set<string>();
      producers.add(h.producer);
      producersByGlyph.set(h.glyph, producers);
    }
    for (const glyph of Object.keys(ALLOWED_SHARED_MEANING)) {
      expect(producersByGlyph.get(glyph)?.size ?? 0).toBeGreaterThan(1);
    }
  });
});
