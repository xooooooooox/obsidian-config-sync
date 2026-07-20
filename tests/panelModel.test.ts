import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, moreFilesText, visibleUnderFilter, directionForState, effectiveDirection, matchesSearch, nosettingsLineText, defaultPolicy, footerSummary, isValidPolicy, policyOptions, presentedState, sectionForItem, stageableRow, stageableState, versionLine, runProgressLabel } from "../src/ui/panelModel";
import { GroupState } from "../src/core/status";
import { Availability } from "../src/core/availability";

describe("visibleUnderFilter", () => {
  it("all shows every state", () => {
    const states: GroupState[] = ["in-sync", "local-changed", "store-newer", "differs", "not-captured"];
    for (const s of states) expect(visibleUnderFilter(s, "all")).toBe(true);
  });

  it("capture shows local-changed and not-captured only", () => {
    expect(visibleUnderFilter("local-changed", "capture")).toBe(true);
    expect(visibleUnderFilter("not-captured", "capture")).toBe(true);
    expect(visibleUnderFilter("store-newer", "capture")).toBe(false);
    expect(visibleUnderFilter("differs", "capture")).toBe(false);
    expect(visibleUnderFilter("in-sync", "capture")).toBe(false);
  });

  it("apply shows store-newer and differs only", () => {
    expect(visibleUnderFilter("store-newer", "apply")).toBe(true);
    expect(visibleUnderFilter("differs", "apply")).toBe(true);
    expect(visibleUnderFilter("local-changed", "apply")).toBe(false);
    expect(visibleUnderFilter("in-sync", "apply")).toBe(false);
  });

  it("ok shows in-sync only", () => {
    expect(visibleUnderFilter("in-sync", "ok")).toBe(true);
    expect(visibleUnderFilter("local-changed", "ok")).toBe(false);
  });

  it("none shows no-settings only; capture and ok exclude it; all includes it", () => {
    expect(visibleUnderFilter("no-settings", "none")).toBe(true);
    expect(visibleUnderFilter("in-sync", "none")).toBe(false);
    expect(visibleUnderFilter("local-changed", "none")).toBe(false);
    expect(visibleUnderFilter("no-settings", "capture")).toBe(false);
    expect(visibleUnderFilter("no-settings", "apply")).toBe(false);
    expect(visibleUnderFilter("no-settings", "ok")).toBe(false);
    expect(visibleUnderFilter("no-settings", "all")).toBe(true);
  });

  it("locked shows only under all; capture/apply/ok/none exclude it", () => {
    expect(visibleUnderFilter("locked", "all")).toBe(true);
    expect(visibleUnderFilter("locked", "capture")).toBe(false);
    expect(visibleUnderFilter("locked", "apply")).toBe(false);
    expect(visibleUnderFilter("locked", "ok")).toBe(false);
    expect(visibleUnderFilter("locked", "none")).toBe(false);
  });
});

describe("capFileEntries", () => {
  it("orders added, updated, deleted and splits at the limit", () => {
    const changes = {
      added: ["a1", "a2"],
      updated: ["u1", "u2", "u3"],
      deleted: ["d1"],
    };
    const { shown, rest } = capFileEntries(changes, 4);
    expect(shown).toEqual([
      { kind: "add", name: "a1" },
      { kind: "add", name: "a2" },
      { kind: "upd", name: "u1" },
      { kind: "upd", name: "u2" },
    ]);
    expect(rest).toEqual([
      { kind: "upd", name: "u3" },
      { kind: "del", name: "d1" },
    ]);
  });

  it("returns empty rest when under the limit", () => {
    const { shown, rest } = capFileEntries({ added: [], updated: ["u1"], deleted: [] }, 10);
    expect(shown).toEqual([{ kind: "upd", name: "u1" }]);
    expect(rest).toEqual([]);
  });
});

describe("copy strings", () => {
  it("in-sync line pluralizes and carries the chevron", () => {
    expect(insyncLineText(1, false)).toBe("✓ 1 item in sync ▸");
    expect(insyncLineText(2, false)).toBe("✓ 2 items in sync ▸");
    expect(insyncLineText(2, true)).toBe("✓ 2 items in sync ▾");
  });

  it("more-files line", () => {
    expect(moreFilesText(5)).toBe("… 5 more files ▸");
  });
});

describe("direction", () => {
  it("defaults by state and honors an explicit override", () => {
    expect(directionForState("local-changed")).toBe("capture");
    expect(directionForState("not-captured")).toBe("capture");
    expect(directionForState("store-newer")).toBe("apply");
    expect(directionForState("differs")).toBe("apply");
    expect(effectiveDirection("differs", undefined)).toBe("apply");
    expect(effectiveDirection("differs", "capture")).toBe("capture");
    expect(effectiveDirection("local-changed", "apply")).toBe("apply");
  });
  it("stageableState: inert states can never be staged or counted", () => {
    expect(stageableState("in-sync")).toBe(false);
    expect(stageableState("no-settings")).toBe(false);
    expect(stageableState("locked")).toBe(false);
    expect(stageableState("local-changed")).toBe(true);
    expect(stageableState("store-newer")).toBe(true);
    expect(stageableState("differs")).toBe(true);
    expect(stageableState("not-captured")).toBe(true);
  });
  it("stageableRow: non-main sections stage everything except locked; main unchanged", () => {
    const states = ["in-sync", "no-settings", "not-captured", "local-changed", "store-newer", "differs"] as const;
    for (const section of ["not-installed", "disabled", "outdated"] as const) {
      for (const st of states) expect(stageableRow(st, section)).toBe(true);
      expect(stageableRow("locked", section)).toBe(false);
    }
    expect(stageableRow("in-sync", "main")).toBe(false);
    expect(stageableRow("no-settings", "main")).toBe(false);
    expect(stageableRow("locked", "main")).toBe(false);
    expect(stageableRow("store-newer", "main")).toBe(true);
  });
});

describe("presentedState (version-ahead surfaces as to-capture)", () => {
  it("upgrades in-sync + ahead to local-changed", () => {
    expect(presentedState("in-sync", "ahead")).toBe("local-changed");
  });
  it("leaves in-sync alone for behind/null drift", () => {
    expect(presentedState("in-sync", "behind")).toBe("in-sync");
    expect(presentedState("in-sync", null)).toBe("in-sync");
  });
  it("passes every non-in-sync state through unchanged regardless of drift", () => {
    expect(presentedState("local-changed", "ahead")).toBe("local-changed");
    expect(presentedState("store-newer", "ahead")).toBe("store-newer");
    expect(presentedState("no-settings", "ahead")).toBe("no-settings");
    expect(presentedState("locked", "ahead")).toBe("locked");
  });
});

describe("matchesSearch", () => {
  it("is case-insensitive substring, empty/whitespace query matches all", () => {
    expect(matchesSearch("plugin-templater-obsidian", "TEMPLA")).toBe(true);
    expect(matchesSearch("hotkeys", "graph")).toBe(false);
    expect(matchesSearch("anything", "")).toBe(true);
    expect(matchesSearch("anything", "   ")).toBe(true);
  });
});

describe("nosettingsLineText", () => {
  it("pluralizes and carries the chevron", () => {
    expect(nosettingsLineText(1, false)).toBe("○ 1 item with no settings yet ▸");
    expect(nosettingsLineText(16, false)).toBe("○ 16 items with no settings yet ▸");
    expect(nosettingsLineText(2, true)).toBe("○ 2 items with no settings yet ▾");
  });
});

const avail = (over: Partial<Availability>): Availability => ({
  kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false, ...over,
});

describe("sectionForItem", () => {
  it("buckets by availability, then behind-drift for community plugins", () => {
    expect(sectionForItem(avail({ kind: "not-installed" }), false)).toBe("not-installed");
    expect(sectionForItem(avail({ kind: "disabled", drift: "behind" }), false)).toBe("disabled");
    expect(sectionForItem(avail({ drift: "behind", storeVersion: "2.0.0" }), false)).toBe("outdated");
    expect(sectionForItem(avail({ drift: "ahead" }), false)).toBe("main");
    expect(sectionForItem(avail({ anchor: "app", drift: "behind" }), false)).toBe("main");
  });
  it("buckets a not-installed desktop-only plugin into desktop-only on mobile only", () => {
    const a = avail({ kind: "not-installed", desktopOnly: true });
    expect(sectionForItem(a, true)).toBe("desktop-only");
    expect(sectionForItem(a, false)).toBe("not-installed"); // desktop: normal
  });
  it("buckets an installed-but-disabled desktop-only plugin into desktop-only on mobile only", () => {
    const a = avail({ kind: "disabled", drift: "behind", desktopOnly: true });
    expect(sectionForItem(a, true)).toBe("desktop-only"); // can't run on a phone → informational
    expect(sectionForItem(a, false)).toBe("disabled"); // desktop: normal disabled row
  });
  it("leaves an enabled desktop-only plugin in main on mobile (a running plugin isn't 'nothing to do')", () => {
    expect(sectionForItem(avail({ kind: "enabled", desktopOnly: true }), true)).toBe("main");
  });
  it("desktop-only rows are never stageable", () => {
    expect(stageableRow("store-newer", "desktop-only")).toBe(false);
  });
});

describe("policyOptions ladder", () => {
  it("composes options from the gap list, default first", () => {
    expect(policyOptions(avail({ kind: "not-installed" })).map((o) => o.action)).toEqual(["install-enable", "install", "none"]);
    expect(policyOptions(avail({ kind: "disabled" })).map((o) => o.action)).toEqual(["enable", "none"]);
    expect(policyOptions(avail({ kind: "disabled", drift: "behind" })).map((o) => o.action)).toEqual(["update-enable", "enable", "none"]);
    const outdated = policyOptions(avail({ drift: "behind", localVersion: "2.2.1", storeVersion: "2.4.0" }));
    expect(outdated.map((o) => o.action)).toEqual(["update", "none"]);
    expect(outdated[1]?.label).toBe("Keep 2.2.1");
    expect(policyOptions(avail({}))).toEqual([]);
    expect(defaultPolicy(avail({ kind: "not-installed" }))).toBe("install-enable");
    expect(defaultPolicy(avail({}))).toBe("none");
  });
});

describe("isValidPolicy", () => {
  it("accepts an action only when it belongs to the current ladder", () => {
    // "update-enable" is valid for disabled+behind, but a row moved to outdated-only
    // (still enabled elsewhere, plugin still behind) has a shorter ladder that lacks it.
    expect(isValidPolicy(avail({ kind: "disabled", drift: "behind" }), "update-enable")).toBe(true);
    expect(isValidPolicy(avail({ drift: "behind", storeVersion: "2.0.0" }), "update-enable")).toBe(false);
    expect(isValidPolicy(avail({ drift: "behind", storeVersion: "2.0.0" }), "update")).toBe(true);
    expect(isValidPolicy(avail({}), "none")).toBe(false); // main ladder has no options at all
  });
});

describe("versionLine", () => {
  it("writes drift metadata per anchor and direction", () => {
    expect(versionLine(avail({ drift: "ahead", localVersion: "1.5.10", storeVersion: "1.4.2" }))).toEqual({
      text: "this device 1.5.10 · store 1.4.2 — newer here; capturing will refresh the store", tone: "gray",
    });
    expect(versionLine(avail({ kind: "disabled", drift: "behind", localVersion: "1.5.3", storeVersion: "1.8.0" }))?.text).toBe(
      "this device 1.5.3 · store 1.8.0 — settings were captured on a newer version"
    );
    expect(versionLine(avail({ anchor: "app", drift: "behind", localVersion: "1.8.7", storeVersion: "1.9.2" }))).toEqual({
      text: "captured on Obsidian 1.9.2 — this device runs 1.8.7; update Obsidian if settings look off", tone: "amber",
    });
    expect(versionLine(avail({}))).toBeNull();
  });
});

describe("footerSummary", () => {
  it("leads with the total staged and lists non-main sections as a subset breakdown", () => {
    // 3 main + 1 disabled + 2 install = 6 total selected
    expect(footerSummary(3, 0, 1, 2)).toBe("6 selected · 1 to enable · 2 to install");
    expect(footerSummary(4, 0, 0, 0)).toBe("4 selected");
    // all staged rows in one non-main section still count in the total (the 0-selected bug)
    expect(footerSummary(0, 0, 0, 9)).toBe("9 selected · 9 to install");
    expect(footerSummary(1, 2, 0, 0)).toBe("3 selected · 2 to update");
    expect(footerSummary(0, 0, 0, 0)).toBe("");
  });
});

describe("runProgressLabel", () => {
  it("arrow-prefixes the verb with done/total", () => {
    expect(runProgressLabel("Applying", 5, 72)).toBe("↓ Applying 5/72…");
    expect(runProgressLabel("Capturing", 0, 3)).toBe("↑ Capturing 0/3…");
  });
});
