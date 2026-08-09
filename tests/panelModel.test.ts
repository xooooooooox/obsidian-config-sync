import { describe, expect, it } from "vitest";
import { capFileEntries, insyncLineText, statusBarStatuses, moreFilesText, visibleUnderFilter, fateBucket, fateBucketCounts, partitionSection, legacyLockedFamilyBucket, RowBucket, directionForState, effectiveDirection, matchesSearch, nosettingsLineText, defaultPolicy, isValidPolicy, policyOptions, presentedState, sectionForItem, stageableRow, stageableState, runProgressLabel, showColdStartBanner, memberDecisionsFromScopes, enablementCarrierFor, carrierIsSynced, TYPE_SECTION_TITLES, typeSectionForRow, sectionCountLabel, mobileSectionCountLabel, unifiedFooterSummary, fileEntryFor, stagedPayload, StageableRow, effectiveFate, remoteSections, onOffFlips, onOffLineText, onOffNarrationLines, familyRollup, FamilyMember, mergeFamilyChanges, foldCompanionEntries, groupExcludedHere } from "../src/ui/panelModel";
import { GroupState, GroupStatus, OTHER_STORE_FILES_GROUP, RemoteDiffEntry, RemoteDiffFile } from "../src/core/status";
import { FileChanges, SyncGroup } from "../src/core/types";
import { Availability } from "../src/core/availability";
import { Fate, FateInput, rowFate } from "../src/ui/fateModel";
import { ItemCategory } from "../src/core/catalog";

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

// C-#24 fix round 2: live verification found the group-level `devices` axis alone (the original
// fix) misses the case where a group's own `devices` stays "all" while its Plain-mode
// `fileRule.scope` carries the real exclusion — the exact reported scenario (Settings-sync menu
// write on Hotkeys). groupExcludedHere reads BOTH axes independently.
describe("groupExcludedHere — C-#24 fix round 2 (devices AND fileRule.scope, independently)", () => {
  const group = (overrides: Partial<SyncGroup>): SyncGroup => ({ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all", ...overrides });

  it("devices mismatch alone (no fileRule) → true — the original axis, unregressed", () => {
    expect(groupExcludedHere(group({ devices: "mobile" }), "desktop")).toBe(true);
  });

  it("devices: all + fileRule.scope: mobile on desktop → true — the reported live scenario", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { scope: "mobile", encrypted: false } }), "desktop")).toBe(true);
  });

  it("fileRule.scope: desktop on desktop → false — this device's own class, not excluded", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { scope: "desktop", encrypted: false } }), "desktop")).toBe(false);
  });

  it("fileRule.scope: all → false", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { scope: "all", encrypted: false } }), "desktop")).toBe(false);
  });

  it("fileRule absent, devices: all → false — byte-identical to before this fix", () => {
    expect(groupExcludedHere(group({ devices: "all" }), "desktop")).toBe(false);
  });

  it("symmetric on a mobile device: fileRule.scope: desktop excludes; scope: mobile does not", () => {
    expect(groupExcludedHere(group({ devices: "all", fileRule: { scope: "desktop", encrypted: false } }), "mobile")).toBe(true);
    expect(groupExcludedHere(group({ devices: "all", fileRule: { scope: "mobile", encrypted: false } }), "mobile")).toBe(false);
  });
});

// A minimal Fate fixture — only glyph/stageable/nothingYet drive fateBucket, everything else is
// filler. `nothingYet` defaults false (a plain directional/conflict/in-sync fixture never is it).
function fate(glyph: Fate["glyph"], stageable: boolean, nothingYet = false): Fate {
  return { glyph, sentence: "", chips: [], stageable, turnsOn: false, nothingYet };
}

describe("fateBucket — spec §1 truth table (ledger C-#23)", () => {
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

  it("non-stageable, nothingYet → none", () => {
    expect(fateBucket(fate("—", false, true))).toBe("none");
  });

  it("non-stageable, not nothingYet → ok", () => {
    expect(fateBucket(fate("—", false, false))).toBe("ok");
  });

  // C-#24: a rule-excluded row's real rowFate output (never a hand-built Fate fixture) still
  // buckets "ok" — inert, unstageable, inside the in-sync fold — the wording lied, not the
  // inertness (spec §1 "Bucket").
  it("excludedHere row (real rowFate output) buckets ok, not none", () => {
    const excludedInput: FateInput = {
      direction: null, conflict: false, nothingYet: false, installed: true,
      hasUpdate: false, carrierSynced: false, storeListOn: null, locallyOn: false,
      memberRule: "all", deviceClass: "desktop", desktopOnly: false, excludedHere: true,
      hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
    };
    const excludedFate = rowFate(excludedInput);
    expect(excludedFate.sentence).toBe("Not synced on this device");
    expect(excludedFate.stageable).toBe(false);
    expect(excludedFate.nothingYet).toBe(false);
    expect(fateBucket(excludedFate)).toBe("ok");
  });

  // C-#28 hardening (review round 2): fateBucket reads the Fate's OWN nothingYet verdict, never
  // an external/caller-computed flag — a degraded apply fate buckets "none" even when a caller's
  // separate `pres === "no-settings"` guess would have said otherwise.
  it("a degraded apply fate (empty verb set) buckets none via its own nothingYet field", () => {
    const degradedInput: FateInput = {
      direction: "apply", conflict: false, nothingYet: false, installed: true,
      hasUpdate: false, carrierSynced: true, storeListOn: false, locallyOn: false,
      memberRule: "all", deviceClass: "desktop", desktopOnly: false, excludedHere: false,
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

describe("fateBucketCounts — counts parity on a mixed row set (ledger C-#23)", () => {
  it("conflict counts under the apply/'down' pill (today's placement, preserved); locked counts under 'none'", () => {
    const buckets: RowBucket[] = ["capture", "capture", "apply", "conflict", "ok", "none", "locked"];
    expect(fateBucketCounts(buckets)).toEqual({ up: 2, down: 2, ok: 1, none: 2 });
  });

  it("an enable-only ↓ row on a no-settings state counts under 'down' (apply), never 'none'", () => {
    const enableOnlyBucket = fateBucket(fate("↓", true, true)); // ↓ Turns on, nothingYet: true
    expect(enableOnlyBucket).toBe("apply");
    expect(fateBucketCounts([enableOnlyBucket])).toEqual({ up: 0, down: 1, ok: 0, none: 0 });
  });

  it("empty set counts all zero", () => {
    expect(fateBucketCounts([])).toEqual({ up: 0, down: 0, ok: 0, none: 0 });
  });
});

describe("partitionSection — active/insync/nosettings partition (ledger C-#23)", () => {
  it("conflict, apply, capture, and locked are all active", () => {
    for (const b of ["conflict", "apply", "capture", "locked"] as const) expect(partitionSection(b)).toBe("active");
  });

  it("ok folds into insync; none folds into nosettings", () => {
    expect(partitionSection("ok")).toBe("insync");
    expect(partitionSection("none")).toBe("nosettings");
  });
});

describe("legacyLockedFamilyBucket — a locked row's bucket, reproducing pre-task familyState placement (review fix)", () => {
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

  it("a solo locked family (no directional companion — rollup stays 'locked') keeps its pre-task placement", () => {
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
    expect(sectionCountLabel(31, 31, false)).toBe("31");
  });
  it("filtered form: visible of total", () => {
    expect(sectionCountLabel(31, 6, true)).toBe("6 of 31");
  });
});

describe("mobileSectionCountLabel — C-#41 spec §2", () => {
  it("unfiltered form is byte-identical to the desktop label", () => {
    expect(mobileSectionCountLabel(31, 31, false)).toBe("31");
  });
  it("filtered form compacts 'X of Y' to 'X/Y'", () => {
    expect(mobileSectionCountLabel(31, 6, true)).toBe("6/31");
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

// ── Remote pane C-grammar model (c-livetest batch4 task 1) ─────────────────────────────────────

describe("remoteSections", () => {
  const entry = (group: string): RemoteDiffEntry => ({ group, files: [] });

  it("carriers (core-plugins, community-plugins) are extracted to their sections' onOff, never entries", () => {
    const entries = [entry("core-plugins"), entry("community-plugins"), entry("app")];
    const categoryOf = (g: string): ItemCategory | "beta" => (g === "app" ? "obsidian" : "core");
    const result = remoteSections(entries, categoryOf, (g) => g);
    const core = result.find((s) => s.section === "core");
    const community = result.find((s) => s.section === "community");
    expect(core?.onOff).toEqual(entry("core-plugins"));
    expect(core?.entries).toEqual([]);
    expect(community?.onOff).toEqual(entry("community-plugins"));
    expect(community?.entries).toEqual([]);
  });

  it("beta category lands in Community", () => {
    const entries = [entry("plugin-x")];
    const result = remoteSections(entries, () => "beta", (g) => g);
    expect(result).toEqual([{ section: "community", onOff: null, entries: [entry("plugin-x")] }]);
  });

  it("custom lands in Your folders", () => {
    const entries = [entry("my-folder")];
    const result = remoteSections(entries, () => "custom", (g) => g);
    expect(result).toEqual([{ section: "folders", onOff: null, entries: [entry("my-folder")] }]);
  });

  it("entries sort by displayNameOf (localeCompare)", () => {
    const entries = [entry("b"), entry("a"), entry("c")];
    const displayNameOf = (g: string): string => ({ a: "Alpha", b: "Beta", c: "Charlie" })[g] ?? g;
    const result = remoteSections(entries, () => "custom", displayNameOf);
    expect(result[0]?.entries.map((e) => e.group)).toEqual(["a", "b", "c"]);
  });

  it("sections with no onOff and no entries are absent from the result", () => {
    expect(remoteSections([], () => "obsidian", (g) => g)).toEqual([]);
  });

  it("result is ordered by TYPE_SECTION_ORDER", () => {
    const entries = [entry("my-folder"), entry("app"), entry("plugin-x"), entry("core-plugins")];
    const categoryOf = (g: string): ItemCategory | "beta" => {
      if (g === "app") return "obsidian";
      if (g === "plugin-x") return "community";
      return "custom";
    };
    const result = remoteSections(entries, categoryOf, (g) => g);
    expect(result.map((s) => s.section)).toEqual(["obsidian", "core", "community", "folders"]);
  });

  it("OTHER_STORE_FILES_GROUP sorts last within folders regardless of display name", () => {
    const entries = [entry(OTHER_STORE_FILES_GROUP), entry("zzz-folder"), entry("aaa-folder")];
    const result = remoteSections(entries, () => "custom", (g) => g);
    expect(result[0]?.entries.map((e) => e.group)).toEqual(["aaa-folder", "zzz-folder", OTHER_STORE_FILES_GROUP]);
  });
});

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

describe("onOffLineText", () => {
  it("singular, closed", () => {
    expect(onOffLineText(1, false)).toBe("On/off list · differs for 1 plugin ▸");
  });
  it("plural, open", () => {
    expect(onOffLineText(2, true)).toBe("On/off list · differs for 2 plugins ▾");
  });
});

// ── Family rollup (c-livetest batch5 task 1) ────────────────────────────────────────────────────

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

  // Review fix (IMPORTANT): a solo neutral member must roll up to ITS OWN state, not a
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

describe("mergeFamilyChanges — spec §4 Files card concat", () => {
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

  const fate = (glyph: Fate["glyph"], turnsOn = false, stageable = true): Fate => ({ glyph, sentence: "x", chips: [], stageable, turnsOn, nothingYet: false });

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

  // I-2 fix (2026-08-06 final review): the Enablement fallback row's "Turn it on" choice folds
  // into the row's own fate.turnsOn via effectiveFate/fallbackTurnsOn (SyncCenterView.ts) — the
  // SAME bridge apply already uses, no parallel derivation — so a capture-direction row staged
  // with turnsOn:true must deliver CaptureItem action "enable", restoring the pre-C
  // disabledRowAction capture-side enable path the §4 amendment names.
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

  // Review fix #1 (task 6 round 2): a resolved conflict row must stage exactly what its real
  // turnsOn says — stagedPayload itself already honors whatever `fate.turnsOn` it's given for a
  // conflict row (it never re-derives it), so this pins that contract explicitly: a caller that
  // feeds a conflict row a REAL (non-frozen) turnsOn value gets the full matrix + member
  // contribution, exactly like a normal directed row would.
  it("a resolved conflict row whose real fate turns it on stages the -enable action AND contributes its elementId (the exact missing case review fix #1 calls out)", () => {
    const { apply } = stagedPayload([
      row({
        id: "plugin-x",
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: true, nothingYet: false },
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
        fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false },
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

  // ── Companion fan-out (c-livetest batch5 task 1) ────────────────────────────────────────────
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
          fate: { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false },
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

describe("effectiveFate — single per-row derivation shared by staging/footer/display (task 6 round 2 fix)", () => {
  const baseInput: FateInput = {
    direction: "apply", conflict: false, nothingYet: false, installed: true,
    hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
    memberRule: "all", deviceClass: "desktop", desktopOnly: false, excludedHere: false,
    hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
  };
  const plainFate: Fate = { glyph: "↓", sentence: "Applies settings", chips: [], stageable: true, turnsOn: false, nothingYet: false };
  const conflictFate: Fate = { glyph: "⚠", sentence: "Changed on both sides", chips: [], stageable: false, turnsOn: false, nothingYet: false };

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
        conflictChoice: "apply", conflict: true, companionNames: { apply: [], capture: [] },
      },
    ]);
    expect(apply.find((i) => i.name === "plugin-x")).toEqual({ name: "plugin-x", action: "install-enable" });
    expect(apply.find((i) => i.name === "community-plugins")).toEqual({ name: "community-plugins", action: "none", stagedMembers: ["x"] });
  });
});
