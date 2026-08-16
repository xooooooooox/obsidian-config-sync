import { describe, expect, it } from "vitest";
import { perElementKeyFor, SWITCH_LISTS } from "../src/core/switchList";
import { enablementRuleFor, enablementRules, ruledElementIds, ruleHomeFor, withEnablementRule } from "../src/core/enablementRules";
import { deriveMode, emptyItemMap, itemAt } from "../src/core/registry";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";
import { itemsIn } from "./items";

describe("perElementKeyFor", () => {
  // Producer-vs-producer (spec §9 lesson 3): the reserved key is whatever the ONE producer says
  // it is, asserted against SWITCH_LISTS itself — never against a hand-written "" literal.
  it("answers the field name for a field list and the reserved key for a whole-file list", () => {
    for (const [list, spec] of Object.entries(SWITCH_LISTS)) {
      expect(perElementKeyFor(list)).toBe(spec.field ?? "");
    }
  });

  it("throws on a list SWITCH_LISTS does not declare", () => {
    expect(() => perElementKeyFor("not-a-list")).toThrow(/no spec/);
  });
});

describe("ruleHomeFor", () => {
  it("routes the two plugin lists to their own item and snippets to appearance, always via perElementKeyFor", () => {
    expect(ruleHomeFor("core-plugins")).toEqual({ section: "obsidian", id: "core-plugins", key: perElementKeyFor("core-plugins") });
    expect(ruleHomeFor("community-plugins")).toEqual({ section: "obsidian", id: "community-plugins", key: perElementKeyFor("community-plugins") });
    expect(ruleHomeFor("enabled-css-snippets")).toEqual({ section: "obsidian", id: "appearance", key: perElementKeyFor("enabled-css-snippets") });
  });
});

describe("enablementRules", () => {
  it("reads an element's rule out of the carrying item, defaulting to everywhere", () => {
    const items = withEnablementRule(emptyItemMap(), "community-plugins", "obsidian-git", perClass("desktop"));
    expect(enablementRuleFor(items, "community-plugins", "obsidian-git")).toEqual(perClass("desktop"));
    expect(enablementRuleFor(items, "community-plugins", "dataview")).toEqual(EVERYWHERE);
    expect(ruledElementIds(items, "community-plugins")).toEqual(["obsidian-git"]);
  });

  it("writes under the reserved key for a whole-file list and under the field name for snippets", () => {
    const plugins = withEnablementRule(emptyItemMap(), "core-plugins", "daily-notes", THIS_DEVICE);
    expect(itemAt(plugins, "obsidian", "core-plugins")?.settingsFile?.perElement).toEqual({
      [perElementKeyFor("core-plugins")]: { "daily-notes": THIS_DEVICE },
    });
    const snippets = withEnablementRule(emptyItemMap(), "enabled-css-snippets", "mobile.css", perClass("mobile"));
    expect(itemAt(snippets, "obsidian", "appearance")?.settingsFile?.perElement).toEqual({
      [perElementKeyFor("enabled-css-snippets")]: { "mobile.css": perClass("mobile") },
    });
  });

  it("an everywhere write clears the entry, and clearing the last one leaves data.json as it was found", () => {
    const before = emptyItemMap();
    const with1 = withEnablementRule(before, "core-plugins", "daily-notes", THIS_DEVICE);
    const back = withEnablementRule(with1, "core-plugins", "daily-notes", EVERYWHERE);
    expect(back).toEqual(before);
  });

  it("ignores a rule value this build cannot read, leaving it on disk (invariant II.2)", () => {
    const items = itemsIn({
      obsidian: {
        "core-plugins": {
          synced: true,
          settingsFile: { mode: "plain", rules: {}, perElement: { "": { "daily-notes": { kind: "from-the-future" } as never } } },
        },
      },
    });
    expect(enablementRuleFor(items, "core-plugins", "daily-notes")).toEqual(EVERYWHERE);
    expect(enablementRules(items, "core-plugins")).toEqual({});
  });

  it("the reserved key never makes a file fields-mode", () => {
    const items = withEnablementRule(emptyItemMap(), "core-plugins", "daily-notes", THIS_DEVICE);
    const sf = itemAt(items, "obsidian", "core-plugins")?.settingsFile;
    expect(sf).toBeDefined();
    expect(deriveMode(sf!)).toBe("plain");
  });

  it("a snippets rule still makes appearance fields-mode, exactly as before", () => {
    const items = withEnablementRule(emptyItemMap(), "enabled-css-snippets", "mobile.css", perClass("mobile"));
    expect(deriveMode(itemAt(items, "obsidian", "appearance")!.settingsFile!)).toBe("fields");
  });
});
