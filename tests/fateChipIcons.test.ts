import { describe, it, expect } from "vitest";
import { FATE_CHIP_ICON } from "../src/ui/fateChipIcons";
import { ACTION_ICON } from "../src/ui/actionIcons";
import { FOLD_ICON } from "../src/ui/foldIcons";
import { buildFileLocalMenu, buildLocalMenu, enablementRowModel, fileEnablementRowModel, ruleIcon, ruleLabel, RULE_OPTIONS } from "../src/ui/enablementRow";
import { EVERYWHERE } from "../src/core/types";

// C-#40 spec §4: every string buildChips (fateModel.ts) can produce, plus the two chips added
// at render time, must resolve to an icon; an unknown chip string is simply absent from the map
// (text-only fallback lives in the renderer) rather than throwing.
describe("FATE_CHIP_ICON — chip→icon map completeness (C-#40)", () => {
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
      // `power` was re-pointed at the local-exception ON state by
      // 2026-08-12-enablement-two-layers-design.md §7 — a chip that says the row stays off must
      // not share it.
      "stays off": "power-off",
      encrypted: "lock",
      "your choice": "check",
    });
  });

  it("an unknown chip string has no icon (renderer falls back to text-only)", () => {
    expect(FATE_CHIP_ICON["some future chip"]).toBeUndefined();
  });
});

// Registry-level guard (spec §9 "one glyph, one meaning" + task-13 brief): this is the third time a
// glyph collision was caught by hand — `power`/`stays off` this round, `sliders-horizontal` almost
// borrowed for the MORE row (SyncCenterView.ts renderMoreRow comment), before that another. Every
// producer below is the REAL exported table/function, not a hand-copied literal of it (spec §9
// lesson 3: "a test must be producer-vs-producer") — if a table's values change, this test reads the
// change instead of going stale next to it.
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
    const fileMenu = buildFileLocalMenu(false, { follow: noop, optOut: noop });
    const homes: GlyphHome[] = [];
    for (const item of elementMenu) if (item.icon !== null) homes.push({ glyph: item.icon, producer: "buildLocalMenu", home: `buildLocalMenu '${item.title}'` });
    for (const item of fileMenu) if (item.icon !== null) homes.push({ glyph: item.icon, producer: "buildFileLocalMenu", home: `buildFileLocalMenu '${item.title}'` });
    return homes;
  }

  // `settings-2` sits behind no exported table — SyncCenterView.ts sets it directly at each of its
  // call sites (the MORE row, the read-only carrier chip, the Config Sync self-pane tile/button), all
  // for the one meaning "opens Settings". Registered here by hand — the one entry in this test with
  // no producer function to iterate — so a FUTURE table cannot silently claim the same glyph.
  //
  // round-11 ③/④: five more hardcoded glyphs, none behind an exported table either — the FILES
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
    // Round-12 (text-triangle sweep, DESIGN.md §2.4): the two chevron families, plus the File
    // preview trigger — none behind an exported table either.
    { glyph: "chevron-right", producer: "foldChevron (external, hardcoded)", home: "renderFoldChevron — FOLD family disclosure rotate" },
    { glyph: "chevrons-up-down", producer: "SyncCenterView/SettingTab (external, hardcoded)", home: "PICKER family — two-segment rows + the switcher" },
    { glyph: "eye", producer: "SettingTab (external, hardcoded)", home: "SETTINGS FILE row — File preview trigger" },
  ];

  // The local segment's `follows` glyph (round-9 ②, DESIGN.md icon table): `corner-down-right` is
  // new — the local segment used to render no icon at all while following the default, so this is
  // the first registration of the glyph anywhere. Fed from the REAL model functions (enablementRow.ts's
  // `enablementRowModel`/`fileEnablementRowModel`), not a hand-copied string, so a future rename of
  // the glyph breaks this test instead of leaving it silently stale — the same "iterate the real
  // producer" discipline `ruleHomes`/`localMenuHomes` above already follow. Scoped to the `follows`
  // state alone: the on/off/not-synced states already resolve to `power`/`power-off`/`circle-slash`,
  // which `buildLocalMenu`/`buildFileLocalMenu` above already register from their OWN producer — a
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

  function allHomes(): GlyphHome[] {
    return [...fateChipHomes(), ...actionHomes(), ...foldHomes(), ...ruleHomes(), ...localMenuHomes(), ...localSegmentFollowHomes(), ...EXTERNAL_HOMES];
  }

  // Declared, intentional glyph reuse across producers — the ONLY escape hatch this test allows.
  // Every entry names the ONE meaning the glyph carries everywhere it appears (spec §7's own framing
  // for two of these: `monitor` = desktop everywhere it appears; `circle-slash` = "not synced on this
  // device", reused deliberately from the fold family). A glyph reused with two DIFFERENT meanings —
  // `power` briefly meaning both "this device turned it on" and "the shared list has it off" — is
  // exactly the bug class this test exists to catch.
  const ALLOWED_SHARED_MEANING: Record<string, string> = {
    monitor: "desktop-only device class",
    "power-off": "off, on this device — a resolved fate this run or a local exception, same direction",
    "circle-slash": "not synced with this item, on this device",
    check: "affirmative — settled / already matching, nothing left for this glyph to say",
    // round-9 ②: the local segment's `follows` glyph, same meaning whether it's an element-layer
    // exception (enablementRowModel) or the whole-file opt-out layer (fileEnablementRowModel) —
    // "this device has no exception of its own, it does whatever the shared answer says."
    "corner-down-right": "this device follows the default (no exception of its own)",
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
