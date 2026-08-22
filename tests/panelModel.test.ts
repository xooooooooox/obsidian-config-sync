import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, excludedLineText, statusBarStatuses, moreFilesText, filesChangeLabel, visibleUnderFilter, leftoverPresentation, fateBucket, fateBucketCounts, nonePresented, partitionSection, legacyLockedFamilyBucket, RowBucket, directionForState, effectiveDirection, matchesSearch, nosettingsLineText, defaultPolicy, isValidPolicy, policyOptions, presentedState, sectionForItem, stageableRow, stageableState, runProgressLabel, showColdStartBanner, enablementCarrierFor, carrierIsSynced, TYPE_SECTION_TITLES, typeSectionForRow, sectionCountLabel, widestCountDigits, unifiedFooterSummary, fileEntryFor, stagedPayload, StageableRow, effectiveFate, onOffFlips, onOffNarrationLines, familyRollup, FamilyMember, mergeFamilyChanges, foldCompanionEntries, groupExcludedHere, CAPTURE_ADDED_TOOLTIP, CAPTURE_UPDATED_TOOLTIP, CAPTURE_DELETED_TOOLTIP, APPLY_ADDED_TOOLTIP, APPLY_UPDATED_TOOLTIP, APPLY_DELETED_TOOLTIP, keysRowModel, withheldKeysClause, uncomparableClause } from "../src/ui/panelModel";
import { GroupState, GroupStatus, RemoteDiffEntry, RemoteDiffFile } from "../src/core/status";
import { FileChanges, SyncGroup, EVERYWHERE, perClass } from "../src/core/types";
import { Availability } from "../src/core/availability";
import { Fate, FateInput, rowFate } from "../src/ui/fateModel";


describe("visibleUnderFilter", () => {
  it("all shows every bucket", () => {
    const buckets: RowBucket[] = ["conflict", "apply", "capture", "ok", "none", "locked"];
    for (const b of buckets) expect(visibleUnderFilter(b, "all")).toBe(true);
  });

  it("capture shows the capture bucket only", () => {
    expect(visibleUnderFilter("capture", "capture")).toBe(true);
    expect(visibleUnderFilter("apply", "capture")).toBe(false);
    expect(visibleUnderFilter("conflict", "capture")).toBe(false);
    expect(visibleUnderFilter("ok", "capture")).toBe(false);
  });

  it("apply shows the apply bucket AND conflict (today's placement, preserved)", () => {
    expect(visibleUnderFilter("apply", "apply")).toBe(true);
    expect(visibleUnderFilter("conflict", "apply")).toBe(true);
    expect(visibleUnderFilter("capture", "apply")).toBe(false);
    expect(visibleUnderFilter("ok", "apply")).toBe(false);
  });

  it("ok shows the ok bucket only", () => {
    expect(visibleUnderFilter("ok", "ok")).toBe(true);
    expect(visibleUnderFilter("capture", "ok")).toBe(false);
  });

  it("none shows the none bucket only; capture and ok exclude it; all includes it", () => {
    expect(visibleUnderFilter("none", "none")).toBe(true);
    expect(visibleUnderFilter("ok", "none")).toBe(false);
    expect(visibleUnderFilter("capture", "none")).toBe(false);
    expect(visibleUnderFilter("none", "capture")).toBe(false);
    expect(visibleUnderFilter("none", "apply")).toBe(false);
    expect(visibleUnderFilter("none", "ok")).toBe(false);
    expect(visibleUnderFilter("none", "all")).toBe(true);
  });

  it("leftover hides every bucket — store orphans are a section, never rows", () => {
    const buckets: RowBucket[] = ["conflict", "apply", "capture", "ok", "none", "locked", "excluded"];
    for (const b of buckets) expect(visibleUnderFilter(b, "leftover")).toBe(false);
  });

  it("locked shows only under all; capture/apply/ok/none exclude it", () => {
    expect(visibleUnderFilter("locked", "all")).toBe(true);
    expect(visibleUnderFilter("locked", "capture")).toBe(false);
    expect(visibleUnderFilter("locked", "apply")).toBe(false);
    expect(visibleUnderFilter("locked", "ok")).toBe(false);
    expect(visibleUnderFilter("locked", "none")).toBe(false);
  });

  it("never-synced rows: raw-state defaults still resolve apply/stageable (unrelated to bucket)", () => {
    expect(directionForState("never-synced")).toBe("apply");
    expect(stageableState("never-synced")).toBe(true);
  });
});

// The Leftover surface's adoption gate (DESIGN.md Leftover): while the plugin's own
// configuration is pending adoption, "leftover" is not a judgment this device can make — the
// section and its pill give way to a hint. Capture-pending does NOT gate (stopping a sync here
// legitimately produces leftovers before the next capture), and an unknown self state reads as
// "section" (unknown is not pending adoption).
describe("leftoverPresentation", () => {
  it("no orphans render nothing, whatever the self state", () => {
    expect(leftoverPresentation("insync", 0)).toBe("none");
    expect(leftoverPresentation("coldstart", 0)).toBe("none");
  });

  it("pending adoption (coldstart/adopt/both) renders the hint instead of the section", () => {
    expect(leftoverPresentation("coldstart", 3)).toBe("hint");
    expect(leftoverPresentation("adopt", 3)).toBe("hint");
    expect(leftoverPresentation("both", 3)).toBe("hint");
  });

  it("insync, capture-pending, and unknown self states render the section", () => {
    expect(leftoverPresentation("insync", 3)).toBe("section");
    expect(leftoverPresentation("capture", 3)).toBe("section");
    expect(leftoverPresentation(null, 3)).toBe("section");
  });
});

// The group-level `devices` axis alone misses the case where a group's own `devices` stays "all"
// while its Plain-mode `fileRule.sharing` carries the real exclusion (e.g. a Settings-sync menu
// write on Hotkeys). groupExcludedHere reads BOTH axes independently.
describe("groupExcludedHere — devices AND fileRule.sharing, independently", () => {
  const group = (overrides: Partial<SyncGroup>): SyncGroup => ({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", ...overrides });

  it("devices mismatch alone (no fileRule) → true — the devices axis alone suffices", () => {
    expect(groupExcludedHere(group({ devices: "mobile" }), "desktop")).toBe(true);
  });

  it("devices: all + fileRule.sharing: mobile on desktop → true — the sharing axis alone suffices", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { sharing: perClass("mobile"), encrypted: false } }), "desktop")).toBe(true);
  });

  it("fileRule.sharing: desktop on desktop → false — this device's own class, not excluded", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { sharing: perClass("desktop"), encrypted: false } }), "desktop")).toBe(false);
  });

  it("fileRule.sharing: all → false", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { sharing: EVERYWHERE, encrypted: false } }), "desktop")).toBe(false);
  });

  it("fileRule absent, devices: all → false — no exclusion on either axis", () => {
    expect(groupExcludedHere(group({ devices: "all" }), "desktop")).toBe(false);
  });

  it("symmetric on a mobile device: fileRule.sharing desktop excludes; mobile does not", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { sharing: perClass("desktop"), encrypted: false } }), "mobile")).toBe(true);
    expect(groupExcludedHere(group({ devices: "all", fileRule: { sharing: perClass("mobile"), encrypted: false } }), "mobile")).toBe(false);
  });
});

// A minimal Fate fixture — only glyph/stageable/nothingYet/excluded drive fateBucket, everything
// else is filler. `nothingYet`/`excluded` default false (a plain directional/conflict/in-sync
// fixture is neither).
function fate(glyph: Fate["glyph"], stageable: boolean, nothingYet = false, excluded = false): Fate {
  return { glyph, sentence: "", chips: [], stageable, turnsOn: false, nothingYet, excluded };
}

describe("fateBucket — glyph/stageable/nothingYet/excluded truth table", () => {
  it("⚠ conflict, regardless of nothingYet", () => {
    expect(fateBucket(fate("⚠", false, false))).toBe("conflict");
    expect(fateBucket(fate("⚠", false, true))).toBe("conflict");
  });

  it("stageable ↓ → apply, even when the row sits on a no-settings/in-sync state (nothingYet true)", () => {
    expect(fateBucket(fate("↓", true, true))).toBe("apply");
    expect(fateBucket(fate("↓", true, false))).toBe("apply");
  });

  it("stageable ↑ → capture", () => {
    expect(fateBucket(fate("↑", true, false))).toBe("capture");
    expect(fateBucket(fate("↑", true, true))).toBe("capture");
  });

  // excluded wins over nothingYet — positioned after the stageable checks, before nothingYet.
  it("excluded (non-stageable) → excluded, even when nothingYet is also true", () => {
    expect(fateBucket(fate("—", false, false, true))).toBe("excluded");
    expect(fateBucket(fate("—", false, true, true))).toBe("excluded");
  });

  it("a stageable/conflict fate is never reclassified excluded — those checks still win first", () => {
    // (Not reachable through rowFate's own output — conflict/direction always win before excluded
    // is even considered — but fateBucket's OWN precedence must hold even for a hand-built Fate.)
    expect(fateBucket(fate("⚠", false, false, true))).toBe("conflict");
    expect(fateBucket(fate("↓", true, false, true))).toBe("apply");
    expect(fateBucket(fate("↑", true, false, true))).toBe("capture");
  });

  it("non-stageable, nothingYet, not excluded → none", () => {
    expect(fateBucket(fate("—", false, true))).toBe("none");
  });

  it("non-stageable, not nothingYet, not excluded → ok", () => {
    expect(fateBucket(fate("—", false, false))).toBe("ok");
  });

  // A rule-excluded OR opted-out row's real rowFate output (never a hand-built Fate fixture)
  // buckets "excluded" — "ok"/"in sync" must not silently count a device-rule-excluded row.
  it("excludedHere row (real rowFate output) buckets excluded, not ok/none", () => {
    const excludedInput: FateInput = {
      direction: null, conflict: false, nothingYet: false, installed: true,
      hasUpdate: false, carrierSynced: false, storeListOn: null, locallyOn: false,
      ruleSharing: EVERYWHERE, localException: null, deviceClass: "desktop", desktopOnly: false, excludedHere: true,
      hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
    };
    const excludedFate = rowFate(excludedInput);
    expect(excludedFate.sentence).toBe("Not synced on this device");
    expect(excludedFate.stageable).toBe(false);
    expect(excludedFate.nothingYet).toBe(false);
    expect(excludedFate.excluded).toBe(true);
    expect(fateBucket(excludedFate)).toBe("excluded");
  });

  // The opt-out cause buckets identically to the class-rule cause — same user-rule
  // family, same placement — via the direction-derivable live shape.
  it("optedOutHere row (real rowFate output, direction-derivable shape) buckets excluded too", () => {
    const optedOutInput: FateInput = {
      direction: "apply", conflict: false, nothingYet: false, installed: false,
      hasUpdate: false, carrierSynced: false, storeListOn: null, locallyOn: false,
      ruleSharing: EVERYWHERE, localException: null, deviceClass: "desktop", desktopOnly: false, excludedHere: false, optedOutHere: true,
      hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
    };
    const optedOutFate = rowFate(optedOutInput);
    expect(optedOutFate.sentence).toBe("Not synced on this device");
    expect(optedOutFate.excluded).toBe(true);
    expect(fateBucket(optedOutFate)).toBe("excluded");
  });

  // fateBucket reads the Fate's OWN nothingYet verdict, never
  // an external/caller-computed flag — a degraded apply fate buckets "none" even when a caller's
  // separate `pres === "no-settings"` guess would have said otherwise.
  it("a degraded apply fate (empty verb set) buckets none via its own nothingYet field", () => {
    const degradedInput: FateInput = {
      direction: "apply", conflict: false, nothingYet: false, installed: true,
      hasUpdate: false, carrierSynced: true, storeListOn: false, locallyOn: false,
      ruleSharing: EVERYWHERE, localException: null, deviceClass: "desktop", desktopOnly: false, excludedHere: false,
      hasSettingsPayload: false, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
    };
    const degradedFate = rowFate(degradedInput);
    expect(degradedFate.sentence).toBe("No settings yet");
    expect(degradedFate.nothingYet).toBe(true);
    // Note: the INPUT's own nothingYet is false here — fateBucket still reads "none" because it
    // trusts the Fate's own verdict, not this (deliberately wrong) caller flag.
    expect(fateBucket(degradedFate)).toBe("none");
  });
});

describe("fateBucketCounts — counts parity on a mixed row set", () => {
  it("conflict counts under the apply/'down' pill (today's placement, preserved); locked is tallied apart; excluded gets its own tally", () => {
    const buckets: RowBucket[] = ["capture", "capture", "apply", "conflict", "ok", "excluded", "none", "locked"];
    expect(fateBucketCounts(buckets)).toEqual({ up: 2, down: 2, ok: 1, none: 1, excluded: 1, locked: 1 });
  });

  // The split is a presentation split, not a recount: under the device relation these rows are put
  // back exactly where they have always been, so that surface cannot move by a single digit.
  it("puts locked back under 'none' for the device relation, and leaves it out for a remote", () => {
    const counts = fateBucketCounts(["none", "locked", "locked"]);
    expect(nonePresented(counts, { kind: "device" })).toBe(3);
    expect(nonePresented(counts, { kind: "remote", name: "work" })).toBe(1);
  });

  it("an enable-only ↓ row on a no-settings state counts under 'down' (apply), never 'none'", () => {
    const enableOnlyBucket = fateBucket(fate("↓", true, true)); // ↓ Turns on, nothingYet: true
    expect(enableOnlyBucket).toBe("apply");
    expect(fateBucketCounts([enableOnlyBucket])).toEqual({ up: 0, down: 1, ok: 0, none: 0, excluded: 0, locked: 0 });
  });

  it("excluded-only set counts entirely under 'excluded', nothing else", () => {
    expect(fateBucketCounts(["excluded", "excluded"])).toEqual({ up: 0, down: 0, ok: 0, none: 0, excluded: 2, locked: 0 });
  });

  it("empty set counts all zero", () => {
    expect(fateBucketCounts([])).toEqual({ up: 0, down: 0, ok: 0, none: 0, excluded: 0, locked: 0 });
  });
});

describe("partitionSection — active/insync/excluded/nosettings partition", () => {
  it("conflict, apply, capture, and locked are all active", () => {
    for (const b of ["conflict", "apply", "capture", "locked"] as const) expect(partitionSection(b)).toBe("active");
  });

  it("ok folds into insync; excluded folds into its OWN section (never insync); none folds into nosettings", () => {
    expect(partitionSection("ok")).toBe("insync");
    expect(partitionSection("excluded")).toBe("excluded");
    expect(partitionSection("none")).toBe("nosettings");
  });
});

describe("legacyLockedFamilyBucket — a locked row buckets by its family's raw state, never its fate", () => {
  it("a locked parent with a DIRECTIONAL (apply) companion buckets apply, not 'ok' — the regression", () => {
    // familyRollup treats a locked member as neutral, so a directional companion (e.g. a plain
    // settings dir with real changes) pulls the family's rollup off "locked" onto its own state.
    // fateWithInput's display bypass would still hand fateBucket a non-stageable "—" fate for the
    // row itself — feeding THAT to fateBucket silently vanishes the family into "ok". The fix
    // reads the family's raw state instead, never fate, for a locked row.
    expect(legacyLockedFamilyBucket("store-newer")).toBe("apply");
    expect(legacyLockedFamilyBucket("never-synced")).toBe("apply");
  });

  it("a locked parent with a DIRECTIONAL (capture) companion buckets capture", () => {
    expect(legacyLockedFamilyBucket("local-changed")).toBe("capture");
    expect(legacyLockedFamilyBucket("not-captured")).toBe("capture");
  });

  it("a locked parent whose companions pull both ways (family differs) buckets conflict", () => {
    expect(legacyLockedFamilyBucket("differs")).toBe("conflict");
  });

  it("a solo locked family (no directional companion — rollup stays 'locked') buckets locked", () => {
    expect(legacyLockedFamilyBucket("locked")).toBe("locked");
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
  // These lines are plain text — no glyph prefix, no trailing triangle. The renderer composes
  // the leading chevron and the fold icon.
  it("in-sync line pluralizes, no glyph/triangle", () => {
    expect(insyncLineText(1)).toBe("1 item in sync");
    expect(insyncLineText(2)).toBe("2 items in sync");
  });

  it("more-files line", () => {
    expect(moreFilesText(5)).toBe("… 5 more files");
  });

  // The FILES row's collapsed count pill's aria-label/tooltip.
  it("files-change label", () => {
    expect(filesChangeLabel(1)).toBe("1 files change");
    expect(filesChangeLabel(4)).toBe("4 files change");
  });

  // Verbatim-consistent with the row sentence ("Not synced on this
  // device") — pill → fold → row wording maps at zero cost.
  // Plain text (see insyncLineText's comment above).
  it("excluded line pluralizes, no glyph/triangle", () => {
    expect(excludedLineText(1)).toBe("1 item not synced on this device");
    expect(excludedLineText(2)).toBe("2 items not synced on this device");
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
  // Plain text (see insyncLineText's comment above).
  it("pluralizes, no glyph/triangle", () => {
    expect(nosettingsLineText(1)).toBe("1 item with no settings yet");
    expect(nosettingsLineText(16)).toBe("16 items with no settings yet");
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


describe("statusBarStatuses — the status bar counts the rows the Sync Center lists", () => {
  const av = (over: Partial<Availability>): Availability => ({
    kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false, ...over,
  });
  const st = (group: string, state: GroupState) => ({ group, state });
  const noFamily = { selfGroup: "config-sync", parentOf: () => null };

  // The 2026-07-27 phone find: a desktop-only plugin can't run here and `stageableRow` calls it
  // unstageable, so the center never counts it as pending — the bar's raw bucketCounts did:
  // center "in sync", bar "↓2", forever.
  it("drops desktop-only rows, the one class the center calls unstageable", () => {
    const avail: Record<string, Availability> = {
      "plugin-a": av({}),
      "plugin-simpread": av({ kind: "not-installed", localVersion: null, desktopOnly: true }),
    };
    const statuses = [st("plugin-a", "in-sync"), st("plugin-simpread", "differs")];
    expect(statusBarStatuses(statuses, (g) => avail[g], true, noFamily)).toEqual([{ group: "plugin-a", state: "in-sync" }]);
  });

  // Not-installed and outdated rows DO stage in the center (there the state's ACTION is the
  // payload), so a bar that dropped them read low against the very pills it mirrors.
  it("keeps not-installed and outdated rows — the center stages and counts them", () => {
    const avail: Record<string, Availability> = {
      "plugin-git": av({ kind: "not-installed", localVersion: null }),
      "plugin-b": av({ drift: "behind", localVersion: "0.9.0" }),
    };
    const statuses = [st("plugin-git", "store-newer"), st("plugin-b", "store-newer")];
    expect(statusBarStatuses(statuses, (g) => avail[g], false, noFamily)).toEqual([
      { group: "plugin-git", state: "store-newer" },
      { group: "plugin-b", state: "store-newer" },
    ]);
  });

  it("applies the version-ahead presentation and keeps groups with no availability info", () => {
    const avail: Record<string, Availability> = { "plugin-a": av({ drift: "ahead", storeVersion: "0.9.0" }) };
    const statuses = [st("plugin-a", "in-sync"), st("mystery", "store-newer")];
    expect(statusBarStatuses(statuses, (g) => avail[g], false, noFamily)).toEqual([
      { group: "plugin-a", state: "local-changed" }, // ahead + in-sync presents as to-capture
      { group: "mystery", state: "store-newer" }, // no availability info → keep, don't hide
    ]);
  });

  // The carriers dissolve into their section's head chip and never render as rows, so the view's
  // counts drop them. The bar must drop them too, or it reads one higher in EACH direction than the
  // pills right above it. Both read the same exported set (ENABLEMENT_CARRIER_GROUPS), so a third
  // copy of those two strings cannot appear.
  it("drops the two on/off carriers, like every count in the view", () => {
    const statuses = [st("core-plugins", "local-changed"), st("community-plugins", "store-newer"), st("hotkeys", "in-sync")];
    expect(statusBarStatuses(statuses, () => undefined, false, noFamily)).toEqual([{ group: "hotkeys", state: "in-sync" }]);
  });

  // The self item has its own sidebar destination and never enters the list; counting it made the
  // bar read one higher than every pill on the screen.
  it("drops the self group", () => {
    expect(statusBarStatuses([st("config-sync", "local-changed"), st("hotkeys", "in-sync")], () => undefined, false, noFamily)).toEqual([
      { group: "hotkeys", state: "in-sync" },
    ]);
  });

  // A companion is one row in the center (folded into its parent's family), so it must be one row
  // here too — otherwise Appearance's themes/snippets each added their own ↑.
  it("folds companions into their parent, and rolls their states up together", () => {
    const family = { selfGroup: "config-sync", parentOf: (g: string) => (g === "themes" || g === "snippets" ? "appearance" : null) };
    const statuses = [st("appearance", "in-sync"), st("themes", "local-changed"), st("snippets", "in-sync")];
    // one row, and the family's pending capture survives the fold
    expect(statusBarStatuses(statuses, () => undefined, false, family)).toEqual([{ group: "appearance", state: "local-changed" }]);
  });

  it("leaves a companion standing alone when its parent is not compiled here", () => {
    const family = { selfGroup: "config-sync", parentOf: () => "appearance" };
    expect(statusBarStatuses([st("snippets", "local-changed")], () => undefined, false, family)).toEqual([
      { group: "snippets", state: "local-changed" },
    ]);
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

// memberDecisionsFromSharing / MemberDecision retired with the two-layer cutover
// (2026-08-12-enablement-two-layers-design.md): "what has this element decided" is no longer a
// projection of the item's own runsOn plus a structural card state — it is decideEnablement over a
// stored rule and this device's own exception (tests/enablementDecision.test.ts).

describe("enablementCarrierFor / carrierIsSynced", () => {
  it("community items carry via community-plugins; core items via core-plugins", () => {
    // The input is the item's REF, not its group name: which list an item's enablement rides is a
    // fact about the item's section, so nothing reads a prefix back out of a name.
    expect(enablementCarrierFor("community/zk-prefixer")).toBe("community-plugins");
    expect(enablementCarrierFor("core/file-explorer")).toBe("core-plugins");
  });
  it("carrierIsSynced checks the carrier's own REF against the compiled set", () => {
    expect(carrierIsSynced("community/zk-prefixer", ["obsidian/community-plugins", "obsidian/hotkeys"])).toBe(true);
    expect(carrierIsSynced("community/zk-prefixer", ["obsidian/core-plugins", "obsidian/hotkeys"])).toBe(false);
    expect(carrierIsSynced("core/file-explorer", ["obsidian/core-plugins"])).toBe(true);
    expect(carrierIsSynced("core/file-explorer", [])).toBe(false);
  });
});

// ── Unified grammar view skeleton (type sections, pills, folds, footer) ─────────────────────

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
    expect(sectionCountLabel(31, 31, false)).toBe("31");
  });
  it("filtered form: compact visible/total, one form on every platform", () => {
    expect(sectionCountLabel(31, 6, true)).toBe("6/31");
  });
});

// The sidebar's count badges reserve a digit slot so their icons line up as a column. The
// reservation is measured, not written into the stylesheet, because a fixed number is wrong in both
// directions at once — the two tests below are those two directions.
describe("widestCountDigits", () => {
  it("reserves what the widest count actually needs, so nothing overflows the column", () => {
    expect(widestCountDigits([7, 312, 1])).toBe(3);
    expect(widestCountDigits([5, 1024, 9])).toBe(4);
  });

  it("reserves no more than that, so short counts carry no dead space", () => {
    expect(widestCountDigits([14, 51, 42])).toBe(2);
    expect(widestCountDigits([3, 1, 9])).toBe(1);
  });

  // A pane with nothing to count still reserves one slot: "0" is one character wide, and the
  // badges that would show it are suppressed at 0 anyway.
  it("never reserves zero slots", () => {
    expect(widestCountDigits([0, 0, 0])).toBe(1);
    expect(widestCountDigits([])).toBe(1);
  });
});

describe("unifiedFooterSummary", () => {
  it("0 selected", () => {
    expect(unifiedFooterSummary({ applyN: 0, installs: 0, turnsOn: 0, settings: 0, captureN: 0 })).toBe("Nothing selected");
  });
  // Counts lead every phrase, so they scan down one edge.
  it("apply only", () => {
    expect(unifiedFooterSummary({ applyN: 5, installs: 2, turnsOn: 3, settings: 4, captureN: 0 })).toBe(
      "5 selected · 2 install · 3 turn on · 4 settings"
    );
  });
  it("mixed apply + capture", () => {
    expect(unifiedFooterSummary({ applyN: 5, installs: 2, turnsOn: 3, settings: 4, captureN: 2 })).toBe(
      "7 selected · 2 install · 3 turn on · 4 settings · 2 capture"
    );
  });
  // The line exists to say what the buttons can't. `2 selected — captures 2` beside a
  // `Capture 2 items` button was the same fact twice, so it renders nothing at all now.
  it("says nothing when the buttons already say it", () => {
    expect(unifiedFooterSummary({ applyN: 0, installs: 0, turnsOn: 0, settings: 0, captureN: 2 })).toBe("");
    expect(unifiedFooterSummary({ applyN: 1, installs: 0, turnsOn: 0, settings: 0, captureN: 0 })).toBe("");
  });
  // Two directions means two buttons and no single total — the line is the only place the whole
  // selection is counted, so it stays even with no apply-side breakdown.
  it("stays when both directions are staged", () => {
    expect(unifiedFooterSummary({ applyN: 1, installs: 0, turnsOn: 0, settings: 0, captureN: 2 })).toBe("3 selected · 2 capture");
  });
});

// ── Remote pane C-grammar model ────────────────────────────────────────────────────────────────

describe("onOffFlips", () => {
  it("community-plugins.json string-array format: on-at-remote / off-at-remote sets", () => {
    expect(onOffFlips('["a"]', '["a","b"]')).toEqual({ onAtRemote: ["b"], offAtRemote: [], remoteOnCount: 2, localOnCount: 1 });
  });

  it("core-plugins.json map format: on-at-remote / off-at-remote sets", () => {
    expect(onOffFlips('{"a":true,"b":false}', '{"a":false,"b":true}')).toEqual({ onAtRemote: ["b"], offAtRemote: ["a"], remoteOnCount: 1, localOnCount: 1 });
  });

  it("null local → every remote-on plugin lands in onAtRemote", () => {
    expect(onOffFlips(null, '["x","y"]')).toEqual({ onAtRemote: ["x", "y"], offAtRemote: [], remoteOnCount: 2, localOnCount: 0 });
  });

  it("null remote → every store-on plugin lands in offAtRemote", () => {
    expect(onOffFlips('["x","y"]', null)).toEqual({ onAtRemote: [], offAtRemote: ["x", "y"], remoteOnCount: 0, localOnCount: 2 });
  });

  it("overlapping membership in different order → both lists empty", () => {
    expect(onOffFlips('["a","b"]', '["b","a"]')).toEqual({ onAtRemote: [], offAtRemote: [], remoteOnCount: 2, localOnCount: 2 });
  });

  it("outputs are sorted", () => {
    expect(onOffFlips(null, '["z","a","m"]')).toEqual({ onAtRemote: ["a", "m", "z"], offAtRemote: [], remoteOnCount: 3, localOnCount: 0 });
  });

  it("an unparseable side degrades to an empty list instead of throwing", () => {
    expect(() => onOffFlips("not json", '["x"]')).not.toThrow();
    expect(onOffFlips("not json", '["x"]')).toEqual({ onAtRemote: ["x"], offAtRemote: [], remoteOnCount: 1, localOnCount: 0 });
  });
});

describe("onOffNarrationLines", () => {
  const idDisplay = (id: string): string => id;

  it("whole-list on-side: flip count equals the remote source size", () => {
    const result = onOffNarrationLines(["a", "b"], [], 2, 0, idDisplay, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "its entire list — 2 plugins" });
    expect(result.off).toBeNull();
  });

  it("whole-list off-side: flip count equals the store source size", () => {
    const result = onOffNarrationLines([], ["a", "b", "c"], 0, 3, idDisplay, "kickstart");
    expect(result.off).toEqual({ prefix: "off at kickstart: ", value: "everything in your store's list — 3 plugins" });
    expect(result.on).toBeNull();
  });

  it("whole-list on both sides simultaneously", () => {
    const result = onOffNarrationLines(["a"], ["b", "c"], 1, 2, idDisplay, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "its entire list — 1 plugin" });
    expect(result.off).toEqual({ prefix: "off at kickstart: ", value: "everything in your store's list — 2 plugins" });
  });

  it("capped case: more than 5 names truncates to 5 plus a count of the rest", () => {
    const ids = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"];
    // sourceOnCount (100) far exceeds the flip count so this is NOT the whole-list case.
    const result = onOffNarrationLines(ids, [], 100, 0, idDisplay, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "g1, g2, g3, g4, g5, and 2 more" });
  });

  it("≤5 flips lists all of them, no truncation", () => {
    const ids = ["g1", "g2", "g3"];
    const result = onOffNarrationLines(ids, [], 100, 0, idDisplay, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "g1, g2, g3" });
  });

  it("empty side is omitted entirely", () => {
    const result = onOffNarrationLines([], [], 0, 0, idDisplay, "kickstart");
    expect(result.on).toBeNull();
    expect(result.off).toBeNull();
  });

  it("sorts by display name, not by element id", () => {
    const displayOf = (id: string): string => ({ id1: "Zebra", id2: "Apple" })[id] ?? id;
    const result = onOffNarrationLines(["id1", "id2"], [], 100, 0, displayOf, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "Apple, Zebra" });
  });

  it("id fallback: an unresolved display name falls back to the raw element id", () => {
    const result = onOffNarrationLines(["raw-id"], [], 100, 0, idDisplay, "kickstart");
    expect(result.on).toEqual({ prefix: "on at kickstart: ", value: "raw-id" });
  });
});

describe("familyRollup — companion groups dissolve into their parent's state", () => {
  const m = (name: string, state: GroupState, fileCount = 0): FamilyMember => ({ name, state, fileCount });

  it("all in sync → in-sync, nothing actionable", () => {
    const r = familyRollup([m("parent", "in-sync"), m("themes", "in-sync"), m("snippets", "in-sync")]);
    expect(r).toEqual({ state: "in-sync", applyMembers: [], captureMembers: [], applyFiles: 0, captureFiles: 0 });
  });

  it("in-sync + nothing-yet → in-sync (not no-settings — one member DOES have settled content)", () => {
    const r = familyRollup([m("parent", "in-sync"), m("themes", "no-settings")]);
    expect(r.state).toBe("in-sync");
  });

  it("every member no-settings → no-settings", () => {
    const r = familyRollup([m("parent", "no-settings"), m("themes", "no-settings")]);
    expect(r.state).toBe("no-settings");
  });

  it("settings-only: parent wants capture, companions carry no files", () => {
    const r = familyRollup([m("parent", "local-changed"), m("themes", "in-sync"), m("snippets", "no-settings")]);
    expect(r).toEqual({ state: "local-changed", applyMembers: [], captureMembers: ["parent"], applyFiles: 0, captureFiles: 0 });
  });

  it("files-only: parent settled, a companion contributes files", () => {
    const r = familyRollup([m("parent", "in-sync"), m("themes", "store-newer", 5)]);
    expect(r).toEqual({ state: "store-newer", applyMembers: ["themes"], captureMembers: [], applyFiles: 5, captureFiles: 0 });
  });

  it("both-direction mix (an apply member + a capture member, neither itself 'differs') → differs", () => {
    const r = familyRollup([m("parent", "local-changed"), m("themes", "store-newer", 3)]);
    expect(r.state).toBe("differs");
    expect(r.applyMembers).toEqual(["themes"]);
    expect(r.captureMembers).toEqual(["parent"]);
    expect(r.applyFiles).toBe(3);
  });

  it("a member itself 'differs' forces the family to differs — that member counts into neither list (unstageable conflict, not a direction)", () => {
    const r = familyRollup([m("parent", "in-sync"), m("themes", "differs", 2)]);
    expect(r.state).toBe("differs");
    expect(r.applyMembers).toEqual([]);
    expect(r.captureMembers).toEqual([]);
    expect(r.applyFiles).toBe(0);
  });

  it("empty companions ≡ the parent's own state — no companion-less row's rollup drifts from its real state", () => {
    expect(familyRollup([m("parent", "store-newer", 4)])).toEqual({
      state: "store-newer", applyMembers: ["parent"], captureMembers: [], applyFiles: 4, captureFiles: 0,
    });
    expect(familyRollup([m("parent", "never-synced")]).state).toBe("never-synced");
    expect(familyRollup([m("parent", "local-changed")]).state).toBe("local-changed");
    expect(familyRollup([m("parent", "not-captured")]).state).toBe("not-captured");
    expect(familyRollup([m("parent", "no-settings")]).state).toBe("no-settings");
  });

  it("a locked member is neutral — contributes to neither direction", () => {
    const r = familyRollup([m("parent", "local-changed"), m("themes", "locked")]);
    expect(r.captureMembers).toEqual(["parent"]);
    expect(r.state).toBe("local-changed");
  });

  // A solo neutral member must roll up to ITS OWN state, not a
  // special-cased guess — "locked" has no no-settings/in-sync special case to fall into.
  it("solo locked parent (no companions) → locked, not in-sync", () => {
    expect(familyRollup([m("parent", "locked")]).state).toBe("locked");
  });

  it("solo no-settings parent (no companions) → no-settings", () => {
    expect(familyRollup([m("parent", "no-settings")]).state).toBe("no-settings");
  });

  it("a locked parent with a directional companion still goes directional — neutral fallback only applies when NOTHING is directional", () => {
    const r = familyRollup([m("parent", "locked"), m("themes", "store-newer", 2)]);
    expect(r.state).toBe("store-newer");
    expect(r.applyMembers).toEqual(["themes"]);
    expect(r.applyFiles).toBe(2);
  });
});

describe("mergeFamilyChanges — Files card concat", () => {
  const changes = (added: string[], updated: string[], deleted: string[]): FileChanges => ({ added, updated, deleted });

  it("parent (null prefix) paths are unchanged", () => {
    const r = mergeFamilyChanges([{ prefix: null, changes: changes(["a.json"], [], []) }]);
    expect(r).toEqual({ added: ["a.json"], updated: [], deleted: [] });
  });

  it("a companion's paths get '<prefix>/' prepended", () => {
    const r = mergeFamilyChanges([{ prefix: "themes", changes: changes(["Foo.css"], [], []) }]);
    expect(r).toEqual({ added: ["themes/Foo.css"], updated: [], deleted: [] });
  });

  it("parent + companions concatenate across all three kinds", () => {
    const r = mergeFamilyChanges([
      { prefix: null, changes: changes(["app.json"], ["b.json"], []) },
      { prefix: "themes", changes: changes([], ["Foo.css"], ["Bar.css"]) },
      { prefix: "snippets", changes: changes(["baz.css"], [], []) },
    ]);
    expect(r).toEqual({
      added: ["app.json", "snippets/baz.css"],
      updated: ["b.json", "themes/Foo.css"],
      deleted: ["themes/Bar.css"],
    });
  });
});

describe("foldCompanionEntries — remote pane companions merge into their parent", () => {
  const file = (itemRel: string): RemoteDiffFile => ({ itemRel, kind: "updated", local: "a", remote: "b" });
  const entry = (group: string, files: RemoteDiffFile[] = []): RemoteDiffEntry => ({ group, files });
  const appearanceParentOf = (g: string): string | null => (g.startsWith("appearance-") ? "appearance" : null);

  it("non-companions pass through untouched", () => {
    const entries = [entry("app", [file("data.json")])];
    expect(foldCompanionEntries(entries, () => null)).toEqual(entries);
  });

  it("merges a companion into its existing parent entry, prefixing itemRel with the companion group", () => {
    const entries = [entry("appearance", [file("app.css")]), entry("appearance-themes", [file("Foo.css")])];
    const result = foldCompanionEntries(entries, appearanceParentOf);
    expect(result).toEqual([entry("appearance", [file("app.css"), { ...file("Foo.css"), itemRel: "appearance-themes/Foo.css" }])]);
  });

  it("creates a missing parent entry when only the companion appears in the diff", () => {
    const entries = [entry("appearance-themes", [file("Foo.css")])];
    const result = foldCompanionEntries(entries, appearanceParentOf);
    expect(result).toEqual([entry("appearance", [{ ...file("Foo.css"), itemRel: "appearance-themes/Foo.css" }])]);
  });

  it("order is stable: first-seen position wins for the merged family", () => {
    const entries = [entry("app"), entry("appearance-themes", [file("Foo.css")]), entry("core-plugins")];
    const result = foldCompanionEntries(entries, appearanceParentOf);
    expect(result.map((e) => e.group)).toEqual(["app", "appearance", "core-plugins"]);
  });

  it("multiple companions of the same parent all merge in, each under its own prefix (chip-count aggregation implied by the concat)", () => {
    const entries = [entry("appearance-themes", [file("Foo.css")]), entry("appearance-snippets", [file("Bar.css")])];
    const result = foldCompanionEntries(entries, appearanceParentOf);
    expect(result).toEqual([
      entry("appearance", [
        { ...file("Foo.css"), itemRel: "appearance-themes/Foo.css" },
        { ...file("Bar.css"), itemRel: "appearance-snippets/Bar.css" },
      ]),
    ]);
  });
});

describe("fileEntryFor — direction-aware file entries", () => {
  it("apply, raw 'deleted' (store-only): a brand-new file lands locally — + / view, nothing to diff against", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "data.json" }, "apply", false);
    expect(e).toEqual({ glyph: "+", label: "data.json", affordance: "view", note: null, tooltip: APPLY_ADDED_TOOLTIP });
  });
  it("apply, raw 'added' (local-only): apply removes it to match the store — del, no affordance", () => {
    const e = fileEntryFor({ kind: "added", rel: "stale.json" }, "apply", false);
    expect(e).toEqual({ glyph: "del", label: "stale.json", affordance: "none", note: null, tooltip: APPLY_DELETED_TOOLTIP });
  });
  it("apply, raw 'updated' (both sides exist): both-sides — neutral glyph, diff", () => {
    const e = fileEntryFor({ kind: "updated", rel: "data.json" }, "apply", false);
    expect(e).toEqual({ glyph: "·", label: "data.json", affordance: "diff", note: null, tooltip: APPLY_UPDATED_TOOLTIP });
  });
  it("capture, raw 'added' (local-only, capture would add it to the store): + glyph — the diff-kind vocabulary holds under capture too, never ↑", () => {
    const e = fileEntryFor({ kind: "added", rel: "data.json" }, "capture", false);
    expect(e).toEqual({ glyph: "+", label: "data.json", affordance: "diff", note: null, tooltip: CAPTURE_ADDED_TOOLTIP });
  });
  it("capture, raw 'updated': neutral glyph — diff", () => {
    const e = fileEntryFor({ kind: "updated", rel: "data.json" }, "capture", false);
    expect(e).toEqual({ glyph: "·", label: "data.json", affordance: "diff", note: null, tooltip: CAPTURE_UPDATED_TOOLTIP });
  });
  it("capture, raw 'deleted' (store-only, capture would remove it from the store): a real deletion — del, no affordance", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "gone.json" }, "capture", false);
    expect(e).toEqual({ glyph: "del", label: "gone.json", affordance: "none", note: null, tooltip: CAPTURE_DELETED_TOOLTIP });
  });
  it("encrypted apply-added: still + glyph, but no preview", () => {
    const e = fileEntryFor({ kind: "deleted", rel: "secret.json" }, "apply", true);
    expect(e).toEqual({ glyph: "+", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview", tooltip: APPLY_ADDED_TOOLTIP });
  });
  it("encrypted apply-updated: neutral glyph, no preview", () => {
    const e = fileEntryFor({ kind: "updated", rel: "secret.json" }, "apply", true);
    expect(e).toEqual({ glyph: "·", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview", tooltip: APPLY_UPDATED_TOOLTIP });
  });
  it("encrypted capture-side: + glyph, no preview", () => {
    const e = fileEntryFor({ kind: "added", rel: "secret.json" }, "capture", true);
    expect(e).toEqual({ glyph: "+", label: "secret.json", affordance: "none", note: "changed — encrypted, no preview", tooltip: CAPTURE_ADDED_TOOLTIP });
  });
  it("encrypted deletion (either direction): del strikethrough is unaffected by encryption — nothing to preview either way", () => {
    expect(fileEntryFor({ kind: "added", rel: "secret.json" }, "apply", true)).toEqual({ glyph: "del", label: "secret.json", affordance: "none", note: null, tooltip: APPLY_DELETED_TOOLTIP });
    expect(fileEntryFor({ kind: "deleted", rel: "secret.json" }, "capture", true)).toEqual({ glyph: "del", label: "secret.json", affordance: "none", note: null, tooltip: CAPTURE_DELETED_TOOLTIP });
  });

  // Both directions × three kinds produce +/·/del with the right
  // tooltip — table-driven, against the exported tooltip constants (the same producer
  // fileEntryFor itself reads from), so a future edit to any of them can't drift silently.
  describe("both directions × three kinds — the diff-kind vocabulary is direction-independent, only the tooltip differs", () => {
    const cases: { dir: "apply" | "capture"; kind: "added" | "updated" | "deleted"; glyph: "+" | "·" | "del"; tooltip: string }[] = [
      { dir: "capture", kind: "added", glyph: "+", tooltip: CAPTURE_ADDED_TOOLTIP },
      { dir: "capture", kind: "updated", glyph: "·", tooltip: CAPTURE_UPDATED_TOOLTIP },
      { dir: "capture", kind: "deleted", glyph: "del", tooltip: CAPTURE_DELETED_TOOLTIP },
      // apply mirrors added/deleted (fileEntryFor's own doc comment) — feed the RAW kind that
      // produces each EFFECTIVE outcome under apply direction.
      { dir: "apply", kind: "deleted", glyph: "+", tooltip: APPLY_ADDED_TOOLTIP }, // store-only → new locally
      { dir: "apply", kind: "updated", glyph: "·", tooltip: APPLY_UPDATED_TOOLTIP },
      { dir: "apply", kind: "added", glyph: "del", tooltip: APPLY_DELETED_TOOLTIP }, // local-only → removed by apply
    ];
    for (const c of cases) {
      it(`${c.dir}/${c.kind} → ${c.glyph} · "${c.tooltip}"`, () => {
        const e = fileEntryFor({ kind: c.kind, rel: "f" }, c.dir, false);
        expect(e.glyph).toBe(c.glyph);
        expect(e.tooltip).toBe(c.tooltip);
      });
    }
  });
});

describe("stagedPayload — unified staging", () => {
  const enabledAvail: Availability = { kind: "enabled", drift: null, localVersion: "1.0.0", storeVersion: null, anchor: "plugin", desktopOnly: false };
  const notInstalledAvail: Availability = { kind: "not-installed", drift: null, localVersion: null, storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false };
  const behindAvail: Availability = { kind: "enabled", drift: "behind", localVersion: "1.0.0", storeVersion: "1.1.0", anchor: "plugin", desktopOnly: false };

  const fate = (glyph: Fate["glyph"], turnsOn = false, stageable = true): Fate => ({ glyph, sentence: "x", chips: [], stageable, turnsOn, nothingYet: false, excluded: false });

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
    companionNames: over.companionNames ?? { apply: [], capture: [] },
  });

  it("unselected rows are excluded from both sides", () => {
    const { apply, capture } = stagedPayload([
      row({ id: "a", fate: fate("↓"), selected: false }),
      row({ id: "b", fate: fate("↑"), selected: false }),
    ]);
    expect(apply).toEqual([]);
    expect(capture).toEqual([]);
  });

  // An opted-out PARENT's row is forced to glyph "—"/stageable:false —
  // rowDirection reads `row.fate.glyph`, so the row is skipped by `dir === null` BEFORE the
  // companion fan-out (`row.companionNames`) ever runs. This is what keeps the family's presented
  // "inert" row honest even though the ROLLUP that produced the row's underlying direction never
  // knew about the opt-out (only the parent's own group is checked) — a
  // real, still-uncaptured companion never sneaks into the payload through the parent's own entry.
  it("a parent forced inert (opted-out shape: glyph —, stageable false) excludes itself AND its companions from the payload, even though the rollup fed it a real family direction", () => {
    const { apply, capture } = stagedPayload([
      row({
        id: "plugin-remotely-save",
        fate: fate("—", false, false),
        companionNames: { apply: ["remotely-save-companion"], capture: [] },
      }),
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

  it("capture rows carry action 'none' by default — capture never enables anything as a side effect of a plain settings/member push", () => {
    expect(stagedPayload([row({ id: "x", fate: fate("↑"), availability: notInstalledAvail })]).capture).toEqual([{ name: "x", action: "none" }]);
  });

  // The Enablement fallback row's "Turn it on" choice folds
  // into the row's own fate.turnsOn via effectiveFate/fallbackTurnsOn (SyncCenterView.ts) — the
  // SAME bridge apply already uses, no parallel derivation — so a capture-direction row staged
  // with turnsOn:true must deliver CaptureItem action "enable" (the capture-side enable path).
  it("a capture row whose fate says turnsOn (the Enablement fallback's 'Turn it on' choice) carries action 'enable'", () => {
    expect(stagedPayload([row({ id: "x", fate: fate("↑", true), availability: notInstalledAvail })]).capture).toEqual([{ name: "x", action: "enable" }]);
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

  // A resolved conflict row must stage exactly what its real
  // turnsOn says — stagedPayload itself already honors whatever `fate.turnsOn` it's given for a
  // conflict row (it never re-derives it), so this pins that contract explicitly: a caller that
  // feeds a conflict row a REAL (non-frozen) turnsOn value gets the full matrix + member
  // contribution, exactly like a normal directed row would.
  it("a resolved conflict row whose real fate turns it on stages the -enable action AND contributes its elementId", () => {
    const { apply } = stagedPayload([
      row({
        id: "plugin-x",
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: true, nothingYet: false, excluded: false },
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
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false, excluded: false },
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

  // ── Companion fan-out ───────────────────────────────────────────────────────────────────────
  describe("companion fan-out", () => {
    it("an apply-direction row stages its apply-side companions as plain entries, after itself", () => {
      const { apply } = stagedPayload([
        row({ id: "appearance", fate: fate("↓"), companionNames: { apply: ["appearance-themes", "appearance-snippets"], capture: [] } }),
      ]);
      expect(apply).toEqual([
        { name: "appearance", action: "none" },
        { name: "appearance-themes", action: "none" },
        { name: "appearance-snippets", action: "none" },
      ]);
    });

    it("a capture-direction row stages its capture-side companions", () => {
      const { capture } = stagedPayload([row({ id: "appearance", fate: fate("↑"), companionNames: { apply: [], capture: ["appearance-themes"] } })]);
      expect(capture).toEqual([
        { name: "appearance", action: "none" },
        { name: "appearance-themes", action: "none" },
      ]);
    });

    it("a row with no companions fans out nothing (current single-row behavior unchanged)", () => {
      const { apply } = stagedPayload([row({ id: "x", fate: fate("↓") })]);
      expect(apply).toEqual([{ name: "x", action: "none" }]);
    });

    it("dedups a companion name already pushed to that side", () => {
      const { apply } = stagedPayload([
        row({ id: "a", fate: fate("↓"), companionNames: { apply: ["shared"], capture: [] } }),
        row({ id: "b", fate: fate("↓"), companionNames: { apply: ["shared"], capture: [] } }),
      ]);
      expect(apply.filter((i) => i.name === "shared")).toHaveLength(1);
    });

    it("only the row's effective (conflict-resolved) direction's companions stage", () => {
      const { apply, capture } = stagedPayload([
        row({
          id: "appearance",
          fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false, excluded: false },
          conflict: true,
          conflictChoice: "apply",
          companionNames: { apply: ["appearance-themes"], capture: ["appearance-snippets"] },
        }),
      ]);
      expect(apply.map((i) => i.name)).toEqual(["appearance", "appearance-themes"]);
      expect(capture).toEqual([]);
    });
  });
});

describe("effectiveFate — single per-row derivation shared by staging/footer/display", () => {
  const baseInput: FateInput = {
    direction: "apply", conflict: false, nothingYet: false, installed: true,
    hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
    ruleSharing: EVERYWHERE, localException: null, deviceClass: "desktop", desktopOnly: false, excludedHere: false,
    hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
  };
  const plainFate: Fate = { glyph: "↓", sentence: "Applies settings", chips: [], stageable: true, turnsOn: false, nothingYet: false, excluded: false };
  const conflictFate: Fate = { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false, excluded: false };

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

  // The end-to-end scenario, wired through the real pipeline
  // (effectiveFate's output feeding stagedPayload directly) rather than a hand-built turnsOn — a
  // resolved conflict on a carrier-synced plugin whose store list wants it on stages
  // install-enable/update-enable/enable per the matrix AND contributes its elementId, never the
  // silent "none" a frozen conflict fate would produce.
  it("integration: a resolved conflict whose store list turns it on stages install-enable and contributes its elementId", () => {
    const input: FateInput = { ...baseInput, installed: false, carrierSynced: true, storeListOn: true, locallyOn: false };
    const resolved = effectiveFate(conflictFate, input, "apply", false);
    const notInstalled: Availability = { kind: "not-installed", drift: null, localVersion: null, storeVersion: "1.0.0", anchor: "plugin", desktopOnly: false };
    const { apply } = stagedPayload([
      {
        id: "plugin-x", itemName: "plugin-x", fate: resolved, selected: true,
        carrier: "community-plugins", elementId: "x", availability: notInstalled,
        conflictChoice: "apply", conflict: true, companionNames: { apply: [], capture: [] },
      },
    ]);
    expect(apply.find((i) => i.name === "plugin-x")).toEqual({ name: "plugin-x", action: "install-enable" });
    expect(apply.find((i) => i.name === "community-plugins")).toEqual({ name: "community-plugins", action: "none", stagedMembers: ["x"] });
  });
});

describe("keysRowModel", () => {
  const file: SyncGroup = { name: "plugin-dataview", path: "{configDir}/plugins/dataview/data.json", type: "file", devices: "all" };
  const folder: SyncGroup = { name: "snippets", path: "{configDir}/snippets", type: "folder", devices: "all" };
  const text: SyncGroup = { name: "vimrc", path: ".vimrc-support", type: "file", devices: "all" };

  it("renders nothing at all when the item travels neither way — the row above already said so", () => {
    expect(keysRowModel({ item: "none", group: file, encrypted: false, patterns: [] })).toEqual({ kind: "hidden" });
  });

  it("says why a folder has no keys instead of leaving a gap", () => {
    expect(keysRowModel({ item: "both", group: folder, encrypted: false, patterns: [] })).toEqual({
      kind: "note",
      text: "A folder travels as a whole — the direction above covers every file in it.",
    });
  });

  it("says why a file with no JSON in it has no keys", () => {
    expect(keysRowModel({ item: "both", group: text, encrypted: false, patterns: [] })).toEqual({
      kind: "note",
      text: "No keys in this file — it travels whole or not at all.",
    });
  });

  it("says why a whole-file-encrypted item has no keys", () => {
    expect(keysRowModel({ item: "both", group: file, encrypted: true, patterns: [] })).toEqual({
      kind: "note",
      text: "This file is stored as one encrypted blob — it travels whole or not at all.",
    });
  });

  it("lists the keys that already carry a rule, and says nothing about the rest", () => {
    expect(keysRowModel({ item: "both", group: file, encrypted: false, patterns: ["apiKey", "theme"] })).toEqual({
      kind: "rules",
      keys: ["apiKey", "theme"],
    });
  });

  it("says nothing extra under a narrowed item — the key controls' own stops carry that fact", () => {
    expect(keysRowModel({ item: "pull", group: file, encrypted: false, patterns: [] })).toEqual({ kind: "rules", keys: [] });
  });
});

describe("withheldKeysClause", () => {
  const push = (keys: string[]): string | null => withheldKeysClause({ remote: "main", item: "Dataview", direction: "push", keys });

  it("says nothing when nothing is held back", () => {
    expect(push([])).toBeNull();
  });

  it("names one key, and says whose value survives", () => {
    expect(push(["apiKey"])).toBe("Overwrites this remote's Dataview. apiKey keeps whatever main already has.");
  });

  it("names two", () => {
    expect(push(["apiKey", "theme"])).toBe("Overwrites this remote's Dataview. apiKey and theme keep whatever main already has.");
  });

  it("names two and counts the rest", () => {
    expect(push(["a", "b", "c", "d"])).toBe("Overwrites this remote's Dataview. a, b and 2 more keys keep whatever main already has.");
  });

  it("pull speaks of YOUR value, since that is the side being preserved", () => {
    expect(withheldKeysClause({ remote: "main", item: "Appearance", direction: "pull", keys: ["accentColor"] })).toBe(
      "Takes this remote's Appearance. accentColor keeps your value."
    );
    expect(withheldKeysClause({ remote: "main", item: "Appearance", direction: "pull", keys: ["a", "b"] })).toBe(
      "Takes this remote's Appearance. a and b keep your values."
    );
  });
});

describe("uncomparableClause — the three sayings, apart", () => {
  it("speaks for this device when its own passphrase is the missing one", () => {
    expect(uncomparableClause({ side: "here", remote: "work-vault", configured: false })).toBe(
      "This item is encrypted and this device has no passphrase, so its two copies can't be compared."
    );
  });

  it("names the mismatch when no key was ever configured for the remote", () => {
    expect(uncomparableClause({ side: "there", remote: "work-vault", configured: false })).toBe(
      "work-vault's copy is encrypted with a different passphrase."
    );
  });

  it("blames the saved key when one was configured and still does not open the copy", () => {
    expect(uncomparableClause({ side: "there", remote: "work-vault", configured: true })).toBe(
      "The passphrase saved for work-vault doesn't open its copy."
    );
  });
});
