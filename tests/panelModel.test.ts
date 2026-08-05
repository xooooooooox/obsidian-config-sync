import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, statusBarStatuses, moreFilesText, visibleUnderFilter, directionForState, effectiveDirection, matchesSearch, nosettingsLineText, defaultPolicy, footerSummary, isValidPolicy, policyOptions, presentedState, sectionForItem, stageableRow, stageableState, versionLine, runProgressLabel, showColdStartBanner, memberDecisionsFromScopes, memberDecisionText, switchSummaryLines, switchBothWaysCaption, ruleGroups, memberScopeWrite, memberCurrentScope, enablementCarrierFor, carrierIsSynced, memberFate, fatePillText, fateLineText, DISABLED_CARRIER_SYNCED_NOTE, isEnableAction, disabledInSyncNote, disabledNoSettingsNote, TYPE_SECTION_TITLES, typeSectionForRow, sectionCountLabel, unifiedFooterSummary, fileEntryFor } from "../src/ui/panelModel";
import { GroupState, GroupStatus } from "../src/core/status";
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

  it("never-synced rows are visible under the apply filter, default apply, stageable", () => {
    expect(visibleUnderFilter("never-synced", "apply")).toBe(true);
    expect(visibleUnderFilter("never-synced", "capture")).toBe(false);
    expect(directionForState("never-synced")).toBe("apply");
    expect(stageableState("never-synced")).toBe(true);
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
    // 3 main + 1 disabled + 2 install = 6 total selected; the 1 disabled row IS a real enable
    expect(footerSummary(3, 0, 1, 2, 1)).toBe("6 selected · 1 to enable · 2 to install");
    expect(footerSummary(4, 0, 0, 0, 0)).toBe("4 selected");
    // all staged rows in one non-main section still count in the total (the 0-selected bug)
    expect(footerSummary(0, 0, 0, 9, 0)).toBe("9 selected · 9 to install");
    expect(footerSummary(1, 2, 0, 0, 0)).toBe("3 selected · 2 to update");
    expect(footerSummary(0, 0, 0, 0, 0)).toBe("");
  });
  it("fix round 2: a staged disabled row that isn't a real enable (carrier-synced action:none, or Keep disabled) still counts toward the total but not toward 'to enable'", () => {
    // 3 main + 1 disabled (settings-only, no enable) = 4 total selected; no 'to enable' phrase
    expect(footerSummary(3, 0, 1, 0, 0)).toBe("4 selected");
    // 2 disabled rows staged, only 1 of them resolves to a real enable
    expect(footerSummary(0, 0, 2, 0, 1)).toBe("2 selected · 1 to enable");
  });
});

describe("runProgressLabel", () => {
  it("arrow-prefixes the verb with done/total", () => {
    expect(runProgressLabel("Applying", 5, 72)).toBe("↓ Applying 5/72…");
    expect(runProgressLabel("Capturing", 0, 3)).toBe("↑ Capturing 0/3…");
  });
});


describe("statusBarStatuses — the status bar counts what the Sync Center's main section counts", () => {
  const av = (over: Partial<Availability>): Availability => ({
    kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false, ...over,
  });
  const st = (group: string, state: GroupState) => ({ group, state });

  // The 2026-07-27 phone find: groups for plugins not installed on this device (or desktop-only
  // there) sat in their own Sync Center sections — excluded from the header pills — while the
  // status bar's raw bucketCounts still counted them: center "in sync", bar "↓2", forever.
  it("drops rows outside the main section", () => {
    const avail: Record<string, Availability> = {
      "plugin-a": av({}),
      "plugin-git": av({ kind: "not-installed", localVersion: null }),
      "plugin-simpread": av({ kind: "not-installed", localVersion: null, desktopOnly: true }),
    };
    const statuses = [st("plugin-a", "in-sync"), st("plugin-git", "store-newer"), st("plugin-simpread", "differs")];
    const out = statusBarStatuses(statuses, (g) => avail[g], true);
    expect(out).toEqual([{ group: "plugin-a", state: "in-sync" }]);
  });

  it("applies the version-ahead presentation to main-section rows and keeps unknown groups", () => {
    const avail: Record<string, Availability> = { "plugin-a": av({ drift: "ahead", storeVersion: "0.9.0" }) };
    const statuses = [st("plugin-a", "in-sync"), st("mystery", "store-newer")];
    const out = statusBarStatuses(statuses, (g) => avail[g], false);
    expect(out).toEqual([
      { group: "plugin-a", state: "local-changed" }, // ahead + in-sync presents as to-capture
      { group: "mystery", state: "store-newer" }, // no availability info → keep, don't hide
    ]);
  });

  it("drops outdated (drift-behind) rows like the center does", () => {
    const avail: Record<string, Availability> = { "plugin-b": av({ drift: "behind", localVersion: "0.9.0" }) };
    expect(statusBarStatuses([st("plugin-b", "store-newer")], (g) => avail[g], false)).toEqual([]);
  });
});

describe("showColdStartBanner", () => {
  it("cold-start banner: self pending + never-synced rows + not dismissed", () => {
    const never: GroupStatus[] = [{ group: "a", state: "never-synced" }];
    const synced: GroupStatus[] = [{ group: "a", state: "in-sync" }];
    expect(showColdStartBanner("coldstart", never, false)).toBe(true);
    expect(showColdStartBanner("adopt", never, false)).toBe(true);
    expect(showColdStartBanner("both", never, false)).toBe(true);
    expect(showColdStartBanner("insync", never, false)).toBe(false);
    expect(showColdStartBanner("capture", never, false)).toBe(false);
    expect(showColdStartBanner("coldstart", synced, false)).toBe(false);
    expect(showColdStartBanner("coldstart", never, true)).toBe(false);
  });
});

describe("memberDecisionsFromScopes / memberDecisionText", () => {
  it("keeps only non-all scopes, sorted by id, structural false when no id is in structuralIds", () => {
    expect(memberDecisionsFromScopes({ b: "desktop", a: "local", c: "all", d: "mobile" }, new Set())).toEqual([
      { id: "a", scope: "local", structural: false },
      { id: "b", scope: "desktop", structural: false },
      { id: "d", scope: "mobile", structural: false },
    ]);
  });
  it("copy", () => {
    expect(memberDecisionText({ id: "x", scope: "local", structural: true })).toBe("x — this device keeps its own on/off state");
    expect(memberDecisionText({ id: "x", scope: "desktop", structural: false })).toBe("x — runs on desktop only");
    expect(memberDecisionText({ id: "x", scope: "mobile", structural: false })).toBe("x — runs on mobile only");
  });
});

// R3-A structural derivation truth table (spec 2026-08-05-section-groups-and-member-menu-design.md
// §R3-A): structural is true only for a "local" scope with no explicit source — the pure layer
// (memberDecisionsFromScopes) derives it from the scope map plus the structuralIds the host passes
// in (registry.ts's structuralLocalElements), never from a pre-computed boolean per decision. The
// localMembers-pin and card-on-explicit-local rows of the full truth table are host wiring (the
// overlay in main.ts's memberDecisionsFor) — covered in tests/core.test.ts.
describe("memberDecisionsFromScopes — structural derivation", () => {
  it("card-off with no rule at all → structural true", () => {
    expect(memberDecisionsFromScopes({ dataview: "local" }, new Set(["dataview"]))).toEqual([
      { id: "dataview", scope: "local", structural: true },
    ]);
  });
  it("a local scope not carried in structuralIds (e.g. an explicit localMembers pin the host excludes) → structural false", () => {
    expect(memberDecisionsFromScopes({ "remotely-save": "local" }, new Set())).toEqual([
      { id: "remotely-save", scope: "local", structural: false },
    ]);
  });
  it("an enabledOn device-class rule → scope isn't local, structural false regardless of structuralIds", () => {
    expect(memberDecisionsFromScopes({ "obsidian-git": "desktop" }, new Set(["obsidian-git"]))).toEqual([
      { id: "obsidian-git", scope: "desktop", structural: false },
    ]);
  });
});

describe("memberScopeWrite", () => {
  it("maps each scope to its host write", () => {
    expect(memberScopeWrite("desktop")).toEqual({ kind: "enabledOn", scope: "desktop" });
    expect(memberScopeWrite("mobile")).toEqual({ kind: "enabledOn", scope: "mobile" });
    expect(memberScopeWrite("local")).toEqual({ kind: "local" });
    expect(memberScopeWrite("all")).toEqual({ kind: "clear" });
  });
});

describe("ruleGroups", () => {
  it("one-sided store-ahead → a single unlabeled apply group", () => {
    expect(ruleGroups({ captureRemoves: ["b", "a"], applyDisables: [] }, "desktop"))
      .toEqual([{ dir: "apply", label: null, ids: ["b", "a"] }]);
  });
  it("one-sided device-ahead → a single unlabeled capture group", () => {
    expect(ruleGroups({ captureRemoves: [], applyDisables: ["x"] }, "mobile"))
      .toEqual([{ dir: "capture", label: null, ids: ["x"] }]);
  });
  it("both ways → two labeled groups, store side first, desktop wording with counts", () => {
    expect(ruleGroups({ captureRemoves: ["a", "b"], applyDisables: ["c"] }, "desktop")).toEqual([
      { dir: "apply", label: "Off this computer · 2", ids: ["a", "b"] },
      { dir: "capture", label: "On this computer only · 1", ids: ["c"] },
    ]);
  });
  it("both ways, mobile wording", () => {
    expect(ruleGroups({ captureRemoves: ["a"], applyDisables: ["b"] }, "mobile").map((g) => g.label))
      .toEqual(["Off this phone · 1", "On this phone only · 1"]);
  });
  it("neither → no groups", () => {
    expect(ruleGroups({ captureRemoves: [], applyDisables: [] }, "desktop")).toEqual([]);
  });
});

describe("memberCurrentScope", () => {
  const decisions = [{ id: "git", scope: "desktop" as const, structural: false }, { id: "rs", scope: "local" as const, structural: false }];
  it("reads a scoped member's scope", () => {
    expect(memberCurrentScope(decisions, "git")).toBe("desktop");
    expect(memberCurrentScope(decisions, "rs")).toBe("local");
  });
  it("defaults to all for an unscoped member", () => {
    expect(memberCurrentScope(decisions, "dataview")).toBe("all");
  });
});

describe("switchSummaryLines", () => {
  it("apply direction, plural, desktop wording", () => {
    expect(switchSummaryLines({ captureRemoves: ["a", "b"], applyDisables: [] }, "desktop", "plugin"))
      .toEqual([{ dir: "apply", text: "2 plugins are on for your other devices but off this computer — Apply turns them on." }]);
  });
  it("apply direction, singular, mobile wording", () => {
    expect(switchSummaryLines({ captureRemoves: ["a"], applyDisables: [] }, "mobile", "plugin"))
      .toEqual([{ dir: "apply", text: "1 plugin is on for your other devices but off this phone — Apply turns it on." }]);
  });
  it("capture direction, plural", () => {
    expect(switchSummaryLines({ captureRemoves: [], applyDisables: ["a", "b"] }, "desktop", "plugin"))
      .toEqual([{ dir: "capture", text: "2 plugins are on this computer but off on your other devices — Capture shares them." }]);
  });
  it("both ways → two lines, apply first", () => {
    expect(switchSummaryLines({ captureRemoves: ["a"], applyDisables: ["b"] }, "desktop", "plugin")).toEqual([
      { dir: "apply", text: "1 plugin is on for your other devices but off this computer — Apply turns it on." },
      { dir: "capture", text: "1 plugin is on this computer but off on your other devices — Capture shares it." },
    ]);
  });
  it("neither → no lines", () => {
    expect(switchSummaryLines({ captureRemoves: [], applyDisables: [] }, "desktop", "plugin")).toEqual([]);
  });
  it("snippet noun, plural apply + singular capture, both ways", () => {
    expect(switchSummaryLines({ captureRemoves: ["a", "b"], applyDisables: ["c"] }, "desktop", "snippet")).toEqual([
      { dir: "apply", text: "2 snippets are on for your other devices but off this computer — Apply turns them on." },
      { dir: "capture", text: "1 snippet is on this computer but off on your other devices — Capture shares it." },
    ]);
  });
});

describe("switchBothWaysCaption", () => {
  it("plugin variant points below, snippet variant points at the Appearance card", () => {
    expect(switchBothWaysCaption("plugin")).toBe("Bulk Apply or Capture resolves every plugin one way. Pin the ones that differ on purpose below.");
    expect(switchBothWaysCaption("snippet")).toBe("Bulk Apply or Capture resolves every snippet one way. Pin per-snippet devices on the Appearance card in Settings.");
  });
});

describe("enablementCarrierFor / carrierIsSynced", () => {
  it("community items (plugin-<id>) carry via community-plugins; core items via core-plugins", () => {
    expect(enablementCarrierFor("plugin-zk-prefixer")).toBe("community-plugins");
    expect(enablementCarrierFor("file-explorer")).toBe("core-plugins");
  });
  it("carrierIsSynced checks the carrier's own group name against the compiled set", () => {
    expect(carrierIsSynced("plugin-zk-prefixer", ["community-plugins", "hotkeys"])).toBe(true);
    expect(carrierIsSynced("plugin-zk-prefixer", ["core-plugins", "hotkeys"])).toBe(false);
    expect(carrierIsSynced("file-explorer", ["core-plugins"])).toBe(true);
    expect(carrierIsSynced("file-explorer", [])).toBe(false);
  });
});

describe("memberFate", () => {
  it("masked wins even if the element happens to be in applySide", () => {
    expect(memberFate("a", ["a"], true)).toBe("rule");
  });
  it("unmasked + in applySide → turns-on", () => {
    expect(memberFate("a", ["a", "b"], false)).toBe("turns-on");
  });
  it("unmasked + absent from applySide → stays-off", () => {
    expect(memberFate("a", ["b"], false)).toBe("stays-off");
    expect(memberFate("a", [], false)).toBe("stays-off");
  });
});

describe("fatePillText / fateLineText / DISABLED_CARRIER_SYNCED_NOTE", () => {
  it("pill copy is carrier-worded, verbatim (spec #5-B)", () => {
    expect(fatePillText("core-plugins")).toBe("⏻ turns on with Core plugins on/off");
    expect(fatePillText("community-plugins")).toBe("⏻ turns on with Community plugins on/off");
  });
  it("line copy per fate, verbatim (spec #5-B)", () => {
    expect(fateLineText("core-plugins", "turns-on")).toBe("enablement follows Core plugins on/off");
    expect(fateLineText("community-plugins", "turns-on")).toBe("enablement follows Community plugins on/off");
    expect(fateLineText("core-plugins", "stays-off")).toBe("stays off — off on your other devices too");
    expect(fateLineText("core-plugins", "rule")).toBe("follows its per-plugin rule");
  });
  it("section note copy verbatim", () => {
    expect(DISABLED_CARRIER_SYNCED_NOTE).toBe("Settings sync either way — whether a plugin turns on follows the on/off card.");
  });
});

describe("isEnableAction (fix round 1 #1 — footer 'N to enable' counting predicate)", () => {
  it("enable and update-enable are real enables; every other action is not", () => {
    expect(isEnableAction("enable")).toBe(true);
    expect(isEnableAction("update-enable")).toBe(true);
    expect(isEnableAction("none")).toBe(false);
    expect(isEnableAction("update")).toBe(false);
    expect(isEnableAction("install")).toBe(false);
    expect(isEnableAction("install-enable")).toBe(false);
  });
});

describe("disabledInSyncNote / disabledNoSettingsNote (fix round 1 #3 — verbatim copy)", () => {
  it("carrier-synced rows get the new copy; unsynced rows keep the old copy byte-identical", () => {
    expect(disabledInSyncNote(true)).toBe("identical to the store — nothing to apply here");
    expect(disabledInSyncNote(false)).toBe("identical to the store — applying just turns the plugin on");
    expect(disabledNoSettingsNote(true)).toBe("no settings to sync yet");
    expect(disabledNoSettingsNote(false)).toBe("no settings to apply — enables the plugin only");
  });
});

// ── Unified grammar view skeleton (task-4: type sections, pills, folds, footer) ─────────────

describe("typeSectionForRow", () => {
  it("obsidian/core/community pass straight through", () => {
    expect(typeSectionForRow("obsidian")).toBe("obsidian");
    expect(typeSectionForRow("core")).toBe("core");
    expect(typeSectionForRow("community")).toBe("community");
  });
  it("beta folds into community; custom folds into folders", () => {
    expect(typeSectionForRow("beta")).toBe("community");
    expect(typeSectionForRow("custom")).toBe("folders");
  });
});

describe("TYPE_SECTION_TITLES", () => {
  it("copy-final titles for the four fixed sections", () => {
    expect(TYPE_SECTION_TITLES).toEqual({
      obsidian: "Obsidian",
      core: "Core plugins",
      community: "Community plugins",
      folders: "Your folders",
    });
  });
});

describe("sectionCountLabel", () => {
  it("unfiltered form: just the total", () => {
    expect(sectionCountLabel(31, 31, false)).toBe("· 31");
  });
  it("filtered form: visible of total", () => {
    expect(sectionCountLabel(31, 6, true)).toBe("· 6 of 31");
  });
});

describe("unifiedFooterSummary", () => {
  it("0 selected", () => {
    expect(unifiedFooterSummary({ applyN: 0, installs: 0, turnsOn: 0, settings: 0, captureN: 0 })).toBe("Nothing selected");
  });
  it("apply only", () => {
    expect(unifiedFooterSummary({ applyN: 5, installs: 2, turnsOn: 3, settings: 4, captureN: 0 })).toBe(
      "5 selected — installs 2 · turns on 3 · settings 4"
    );
  });
  it("mixed apply + capture", () => {
    expect(unifiedFooterSummary({ applyN: 5, installs: 2, turnsOn: 3, settings: 4, captureN: 2 })).toBe(
      "7 selected — installs 2 · turns on 3 · settings 4 · captures 2"
    );
  });
  it("capture only", () => {
    expect(unifiedFooterSummary({ applyN: 0, installs: 0, turnsOn: 0, settings: 0, captureN: 2 })).toBe("2 selected — captures 2");
  });
  it("selected but nothing to categorize falls back to the bare total", () => {
    expect(unifiedFooterSummary({ applyN: 1, installs: 0, turnsOn: 0, settings: 0, captureN: 0 })).toBe("1 selected");
  });
});

describe("fileEntryFor — spec §4 direction-aware file entries (ledger #8)", () => {
  it("apply, raw 'deleted' (store-only): a brand-new file lands locally — + / view, nothing to diff against", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "data.json" }, "apply", false);
    expect(e).toEqual({ glyph: "+", label: "data.json", affordance: "view", note: null });
  });
  it("apply, raw 'added' (local-only): apply removes it to match the store — del, no affordance", () => {
    const e = fileEntryFor({ kind: "added", rel: "stale.json" }, "apply", false);
    expect(e).toEqual({ glyph: "del", label: "stale.json", affordance: "none", note: null });
  });
  it("apply, raw 'updated' (both sides exist): both-sides — neutral glyph, diff", () => {
    const e = fileEntryFor({ kind: "updated", rel: "data.json" }, "apply", false);
    expect(e).toEqual({ glyph: "·", label: "data.json", affordance: "diff", note: null });
  });
  it("capture, raw 'added' (local-only, capture would add it to the store): capture-side — ↑ / diff", () => {
    const e = fileEntryFor({ kind: "added", rel: "data.json" }, "capture", false);
    expect(e).toEqual({ glyph: "↑", label: "data.json", affordance: "diff", note: null });
  });
  it("capture, raw 'updated': capture-side — ↑ / diff", () => {
    const e = fileEntryFor({ kind: "updated", rel: "data.json" }, "capture", false);
    expect(e).toEqual({ glyph: "↑", label: "data.json", affordance: "diff", note: null });
  });
  it("capture, raw 'deleted' (store-only, capture would remove it from the store): a real deletion — del, no affordance", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "gone.json" }, "capture", false);
    expect(e).toEqual({ glyph: "del", label: "gone.json", affordance: "none", note: null });
  });
  it("encrypted apply-added: still + glyph, but no preview", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "secret.json" }, "apply", true);
    expect(e).toEqual({ glyph: "+", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview" });
  });
  it("encrypted apply-updated: neutral glyph, no preview", () => {
    const e = fileEntryFor({ kind: "updated", rel: "secret.json" }, "apply", true);
    expect(e).toEqual({ glyph: "·", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview" });
  });
  it("encrypted capture-side: ↑ glyph, no preview", () => {
    const e = fileEntryFor({ kind: "updated", rel: "secret.json" }, "capture", true);
    expect(e).toEqual({ glyph: "↑", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview" });
  });
  it("encrypted deletion (either direction): del strikethrough is unaffected by encryption — nothing to preview either way", () => {
    expect(fileEntryFor({ kind: "added", rel: "secret.json" }, "apply", true)).toEqual({ glyph: "del", label: "secret.json", affordance: "none", note: null });
    expect(fileEntryFor({ kind: "deleted", rel: "secret.json" }, "capture", true)).toEqual({ glyph: "del", label: "secret.json", affordance: "none", note: null });
  });
});
