import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, statusBarStatuses, moreFilesText, visibleUnderFilter, directionForState, effectiveDirection, matchesSearch, nosettingsLineText, defaultPolicy, isValidPolicy, policyOptions, presentedState, sectionForItem, stageableRow, stageableState, runProgressLabel, showColdStartBanner, memberDecisionsFromScopes, enablementCarrierFor, carrierIsSynced, TYPE_SECTION_TITLES, typeSectionForRow, sectionCountLabel, unifiedFooterSummary, fileEntryFor, stagedPayload, StageableRow, effectiveFate } from "../src/ui/panelModel";
import { GroupState, GroupStatus } from "../src/core/status";
import { Availability } from "../src/core/availability";
import { Fate, FateInput } from "../src/ui/fateModel";

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

describe("memberDecisionsFromScopes", () => {
  it("keeps only non-all scopes, sorted by id, structural false when no id is in structuralIds", () => {
    expect(memberDecisionsFromScopes({ b: "desktop", a: "local", c: "all", d: "mobile" }, new Set())).toEqual([
      { id: "a", scope: "local", structural: false },
      { id: "b", scope: "desktop", structural: false },
      { id: "d", scope: "mobile", structural: false },
    ]);
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

describe("stagedPayload — spec §5 unified staging (task 6)", () => {
  const enabledAvail: Availability = { kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: null, anchor: "plugin", desktopOnly: false };
  const notInstalledAvail: Availability = { kind: "not-installed", drift: null, localVersion: null, storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false };
  const behindAvail: Availability = { kind: "enabled", drift: "behind", localVersion: "1.0.0", storeVersion: "1.1.0", anchor: "plugin", desktopOnly: false };

  const fate = (glyph: Fate["glyph"], turnsOn = false, stageable = true): Fate => ({ glyph, sentence: "x", chips: [], stageable, turnsOn });

  const row = (over: Partial<StageableRow> & { id: string }): StageableRow => ({
    id: over.id,
    itemName: over.itemName ?? over.id,
    fate: over.fate ?? fate("↓"),
    selected: over.selected ?? true,
    carrier: over.carrier ?? null,
    elementId: over.elementId ?? null,
    availability: over.availability === undefined ? enabledAvail : over.availability,
    conflictChoice: over.conflictChoice ?? null,
    conflict: over.conflict ?? false,
  });

  it("unselected rows are excluded from both sides", () => {
    const { apply, capture } = stagedPayload([
      row({ id: "a", fate: fate("↓"), selected: false }),
      row({ id: "b", fate: fate("↑"), selected: false }),
    ]);
    expect(apply).toEqual([]);
    expect(capture).toEqual([]);
  });

  it("mixed selection both directions: apply rows and capture rows land on their own side; in-sync rows never stage", () => {
    const { apply, capture } = stagedPayload([
      row({ id: "a", fate: fate("↓") }),
      row({ id: "b", fate: fate("↑") }),
      row({ id: "c", fate: fate("—") }),
    ]);
    expect(apply).toEqual([{ name: "a", action: "none" }]);
    expect(capture).toEqual([{ name: "b", action: "none" }]);
  });

  it("conflict without a choice is excluded from both sides", () => {
    const { apply, capture } = stagedPayload([row({ id: "a", fate: fate("⚠"), conflict: true, conflictChoice: null })]);
    expect(apply).toEqual([]);
    expect(capture).toEqual([]);
  });

  it("conflict resolved to apply joins apply; resolved to capture joins capture", () => {
    const toApply = stagedPayload([row({ id: "a", fate: fate("⚠"), conflict: true, conflictChoice: "apply" })]);
    expect(toApply.apply).toEqual([{ name: "a", action: "none" }]);
    expect(toApply.capture).toEqual([]);

    const toCapture = stagedPayload([row({ id: "a", fate: fate("⚠"), conflict: true, conflictChoice: "capture" })]);
    expect(toCapture.capture).toEqual([{ name: "a", action: "none" }]);
    expect(toCapture.apply).toEqual([]);
  });

  it("action derivation matrix: install/install-enable, update/update-enable, enable/none", () => {
    const act = (a: Availability, turnsOn: boolean): string | undefined =>
      stagedPayload([row({ id: "x", fate: fate("↓", turnsOn), availability: a })]).apply.find((i) => i.name === "x")?.action;
    expect(act(notInstalledAvail, false)).toBe("install");
    expect(act(notInstalledAvail, true)).toBe("install-enable");
    expect(act(behindAvail, false)).toBe("update");
    expect(act(behindAvail, true)).toBe("update-enable");
    expect(act(enabledAvail, true)).toBe("enable");
    expect(act(enabledAvail, false)).toBe("none");
  });

  it("null availability (no install/update dimension, e.g. a folder or Obsidian row) falls to enable/none per turnsOn", () => {
    const act = (turnsOn: boolean): string | undefined =>
      stagedPayload([row({ id: "x", fate: fate("↓", turnsOn), availability: null })]).apply.find((i) => i.name === "x")?.action;
    expect(act(true)).toBe("enable");
    expect(act(false)).toBe("none");
  });

  it("capture rows always carry action 'none' — capture never enables anything as a side effect", () => {
    expect(stagedPayload([row({ id: "x", fate: fate("↑"), availability: notInstalledAvail })]).capture).toEqual([{ name: "x", action: "none" }]);
  });

  it("a turnsOn plugin row contributes its elementId to its carrier's stagedMembers, synthesizing the carrier's own ApplyItem", () => {
    const { apply } = stagedPayload([row({ id: "plugin-dataview", fate: fate("↓", true), carrier: "community-plugins", elementId: "dataview" })]);
    expect(apply.find((i) => i.name === "community-plugins")).toEqual({ name: "community-plugins", action: "none", stagedMembers: ["dataview"] });
  });

  it("members from both carriers are collected independently", () => {
    const { apply } = stagedPayload([
      row({ id: "plugin-a", fate: fate("↓", true), carrier: "community-plugins", elementId: "a" }),
      row({ id: "core-x", fate: fate("↓", true), carrier: "core-plugins", elementId: "x" }),
    ]);
    expect(apply.find((i) => i.name === "community-plugins")?.stagedMembers).toEqual(["a"]);
    expect(apply.find((i) => i.name === "core-plugins")?.stagedMembers).toEqual(["x"]);
  });

  it("a selected member row that does NOT turn on contributes nothing on apply, and no carrier item is synthesized", () => {
    const { apply } = stagedPayload([row({ id: "plugin-a", fate: fate("↓", false), carrier: "community-plugins", elementId: "a" })]);
    expect(apply).toEqual([{ name: "plugin-a", action: "none" }]);
    expect(apply.find((i) => i.name === "community-plugins")).toBeUndefined();
  });

  it("capture always contributes a carrier member regardless of turnsOn (always false on that side)", () => {
    const { capture } = stagedPayload([row({ id: "plugin-a", fate: fate("↑", false), carrier: "community-plugins", elementId: "a" })]);
    expect(capture.find((i) => i.name === "community-plugins")?.stagedMembers).toEqual(["a"]);
  });

  it("the carrier's own row staged with no members contributed still carries an empty stagedMembers array", () => {
    const { apply } = stagedPayload([row({ id: "core-plugins", fate: fate("↓", false) })]);
    expect(apply).toEqual([{ name: "core-plugins", action: "none", stagedMembers: [] }]);
  });

  it("the carrier's own row staged AND member rows staged merge into one item with the full member list", () => {
    const { apply } = stagedPayload([
      row({ id: "core-plugins", fate: fate("↓", false) }),
      row({ id: "core-x", fate: fate("↓", true), carrier: "core-plugins", elementId: "x" }),
    ]);
    expect(apply.filter((i) => i.name === "core-plugins")).toEqual([{ name: "core-plugins", action: "none", stagedMembers: ["x"] }]);
  });

  it("itemName (not id) is what lands in the payload", () => {
    const { apply } = stagedPayload([row({ id: "row-key", itemName: "plugin-real-name", fate: fate("↓") })]);
    expect(apply).toEqual([{ name: "plugin-real-name", action: "none" }]);
  });

  // Review fix #1 (task 6 round 2): a resolved conflict row must stage exactly what its real
  // turnsOn says — stagedPayload itself already honors whatever `fate.turnsOn` it's given for a
  // conflict row (it never re-derives it), so this pins that contract explicitly: a caller that
  // feeds a conflict row a REAL (non-frozen) turnsOn value gets the full matrix + member
  // contribution, exactly like a normal directed row would.
  it("a resolved conflict row whose real fate turns it on stages the -enable action AND contributes its elementId (the exact missing case review fix #1 calls out)", () => {
    const { apply } = stagedPayload([
      row({
        id: "plugin-x",
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: true },
        conflict: true,
        conflictChoice: "apply",
        carrier: "community-plugins",
        elementId: "x",
        availability: notInstalledAvail,
      }),
    ]);
    expect(apply.find((i) => i.name === "plugin-x")).toEqual({ name: "plugin-x", action: "install-enable" });
    expect(apply.find((i) => i.name === "community-plugins")).toEqual({ name: "community-plugins", action: "none", stagedMembers: ["x"] });
  });

  it("a resolved conflict row whose real fate does NOT turn it on stages the plain (non-enable) action and contributes nothing", () => {
    const { apply } = stagedPayload([
      row({
        id: "plugin-x",
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false },
        conflict: true,
        conflictChoice: "apply",
        carrier: "community-plugins",
        elementId: "x",
        availability: behindAvail,
      }),
    ]);
    expect(apply.find((i) => i.name === "plugin-x")).toEqual({ name: "plugin-x", action: "update" });
    expect(apply.find((i) => i.name === "community-plugins")).toBeUndefined();
  });
});

describe("effectiveFate — single per-row derivation shared by staging/footer/display (task 6 round 2 fix)", () => {
  const baseInput: FateInput = {
    direction: "apply", conflict: false, nothingYet: false, installed: true,
    hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
    memberRule: "all", deviceClass: "desktop", desktopOnly: false,
    hasSettingsPayload: true, special: null, folderFileCount: null, encrypted: false,
  };
  const plainFate: Fate = { glyph: "↓", sentence: "Applies settings", chips: [], stageable: true, turnsOn: false };
  const conflictFate: Fate = { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false };

  it("a normal (non-conflict) row with no fallback bridge passes through unchanged", () => {
    expect(effectiveFate(plainFate, baseInput, null, false)).toEqual(plainFate);
  });

  it("an unresolved conflict (no choice) passes through unchanged — still the frozen ⚠ fate", () => {
    expect(effectiveFate(conflictFate, baseInput, null, false)).toEqual(conflictFate);
  });

  it("a resolved conflict re-derives a REAL directed fate via rowFate — never the frozen turnsOn:false", () => {
    // carrierSynced + storeListOn:true + locallyOn:false → a real apply would turn it on.
    const input: FateInput = { ...baseInput, storeListOn: true, locallyOn: false };
    const f = effectiveFate(conflictFate, input, "apply", false);
    expect(f.glyph).toBe("↓");
    expect(f.turnsOn).toBe(true);
    expect(f.sentence).not.toBe("Changed on both sides");
  });

  it("a resolved conflict whose real fate would NOT turn it on stays turnsOn:false (no false promise either way)", () => {
    const input: FateInput = { ...baseInput, storeListOn: false, locallyOn: false };
    const f = effectiveFate(conflictFate, input, "apply", false);
    expect(f.turnsOn).toBe(false);
  });

  it("fallbackTurnsOn forces turnsOn:true on a normal row without touching glyph/sentence", () => {
    const f = effectiveFate(plainFate, baseInput, null, true);
    expect(f.turnsOn).toBe(true);
    expect(f.glyph).toBe(plainFate.glyph);
    expect(f.sentence).toBe(plainFate.sentence);
  });

  it("fallbackTurnsOn composes on top of a resolved conflict's re-derived fate", () => {
    const input: FateInput = { ...baseInput, storeListOn: false, locallyOn: false }; // real turnsOn would be false
    const f = effectiveFate(conflictFate, input, "apply", true);
    expect(f.turnsOn).toBe(true); // forced on despite the real derivation saying false
    expect(f.glyph).toBe("↓");
  });

  // The exact end-to-end scenario review fix #1 calls out, wired through the real pipeline
  // (effectiveFate's output feeding stagedPayload directly) rather than a hand-built turnsOn — a
  // resolved conflict on a carrier-synced plugin whose store list wants it on stages
  // install-enable/update-enable/enable per the matrix AND contributes its elementId, never the
  // silent "none" the frozen conflict fate used to produce.
  it("integration: a resolved conflict whose store list turns it on stages install-enable and contributes its elementId", () => {
    const input: FateInput = { ...baseInput, installed: false, carrierSynced: true, storeListOn: true, locallyOn: false };
    const resolved = effectiveFate(conflictFate, input, "apply", false);
    const notInstalled: Availability = { kind: "not-installed", drift: null, localVersion: null, storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false };
    const { apply } = stagedPayload([
      {
        id: "plugin-x", itemName: "plugin-x", fate: resolved, selected: true,
        carrier: "community-plugins", elementId: "x", availability: notInstalled,
        conflictChoice: "apply", conflict: true,
      },
    ]);
    expect(apply.find((i) => i.name === "plugin-x")).toEqual({ name: "plugin-x", action: "install-enable" });
    expect(apply.find((i) => i.name === "community-plugins")).toEqual({ name: "community-plugins", action: "none", stagedMembers: ["x"] });
  });
});
