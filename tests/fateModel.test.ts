import { describe, expect, it } from "vitest";
import { rowFate, FateInput } from "../src/ui/fateModel";

const base: FateInput = {
  direction: "apply", conflict: false, nothingYet: false, installed: true,
  hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
  memberRule: "all", deviceClass: "desktop", desktopOnly: false, excludedHere: false,
  hasSettingsPayload: true, special: null, folderFileCount: null, encrypted: false,
};

describe("rowFate — spec §3 verb table", () => {
  it("install + turn on + settings", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true });
    expect(f.glyph).toBe("↓");
    expect(f.sentence).toBe("Installs · turns on · applies settings");
    expect(f.chips).toContain("not installed here");
    expect(f.turnsOn).toBe(true);
  });
  it("install, off in the store list", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.chips).toContain("stays off");
  });
  it("installed, off here, store list turns it on — no settings", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: true });
    expect(f.sentence).toBe("Turns on");
  });
  it("update", () => {
    const f = rowFate({ ...base, hasUpdate: true });
    expect(f.sentence).toBe("Updates · applies settings");
  });
  it("appearance special", () => {
    const f = rowFate({ ...base, special: "appearance" });
    expect(f.sentence).toBe("Applies theme & snippets — live");
  });
  it("folder", () => {
    const f = rowFate({ ...base, special: "folder", folderFileCount: 2 });
    expect(f.sentence).toBe("Applies 2 files");
  });
  it("capture settings", () => {
    const f = rowFate({ ...base, direction: "capture" });
    expect(f.glyph).toBe("↑");
    expect(f.sentence).toBe("Captures settings");
  });
  it("capture: turned on here", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true });
    expect(f.sentence).toBe("Turned on here — shares it");
  });
  it("capture: Appearance", () => {
    const f = rowFate({ ...base, direction: "capture", special: "appearance" });
    expect(f.sentence).toBe("Captures theme & snippets");
  });
  it("capture: folder", () => {
    const f = rowFate({ ...base, direction: "capture", special: "folder", folderFileCount: 2 });
    expect(f.sentence).toBe("Captures 2 files");
  });
  it("conflict", () => {
    const f = rowFate({ ...base, conflict: true });
    expect(f.glyph).toBe("⚠");
    expect(f.sentence).toBe("Changed on both sides");
    expect(f.stageable).toBe(false);
  });
  it("in sync / nothing yet", () => {
    expect(rowFate({ ...base, direction: null }).sentence).toBe("In sync");
    expect(rowFate({ ...base, direction: null, nothingYet: true }).sentence).toBe("No settings yet");
    expect(rowFate({ ...base, direction: null }).stageable).toBe(false);
  });
});

// C-#28: a derived APPLY direction may never carry an empty verb set — it degrades to the
// nothing-yet presentation instead of rendering a bare glyph with no sentence. Capture is
// deliberately NOT symmetric (controller ruling, review round 2): a capture-directional rollup
// only exists because some member is genuinely local-changed/not-captured, and the only
// empty-verb capture shape is a `not-captured` member whose file count is structurally invisible
// (status.ts never attaches `changes` there) — real capturable work, not nothing-yet.
describe("rowFate — empty-verb degradation (C-#28, apply-only)", () => {
  it("apply, empty verb set (the live 5-row scenario: installed, stays off, no settings, no update) degrades to nothing-yet", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: false });
    expect(f.glyph).toBe("—");
    expect(f.sentence).toBe("No settings yet");
    expect(f.stageable).toBe(false);
    expect(f.turnsOn).toBe(false);
    expect(f.nothingYet).toBe(true);
  });
  it("apply, empty verb set still carries its chips unaffected (stays off)", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: false });
    expect(f.chips).toContain("stays off");
  });

  // Guard: the degradation fires ONLY on a genuinely empty verb set — every path that already
  // produces a non-empty sentence stays byte-identical (existing fate tests above are the fence;
  // these pin the same guarantee explicitly against this rule).
  it("never fires on appearance special (verb always non-null)", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, special: "appearance" });
    expect(f.sentence).toBe("Applies theme & snippets — live");
    expect(f.stageable).toBe(true);
  });
  it("never fires on a folder row with a file count (verb always non-null)", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, special: "folder", folderFileCount: 2 });
    expect(f.sentence).toBe("Applies 2 files");
    expect(f.stageable).toBe(true);
  });
  it("never fires when turning on is the only verb", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, storeListOn: true });
    expect(f.sentence).toBe("Turns on");
    expect(f.stageable).toBe(true);
  });
  it("never fires on a settings-only apply", () => {
    const f = rowFate({ ...base });
    expect(f.sentence).toBe("Applies settings");
    expect(f.stageable).toBe(true);
  });
  it("never fires on an install chain", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true });
    expect(f.sentence).toBe("Installs · turns on · applies settings");
    expect(f.stageable).toBe(true);
  });
});

// C-#28 controller ruling (review round 2): capture never degrades — an empty capture verb set
// (no settings payload, no visible folder files, no carrier turn-on) is real, invisible-count
// work, so it renders a generic count-free verb instead.
describe("rowFate — capture empty verb set stays directional (C-#28 ruling)", () => {
  it("capture, empty verb set: generic 'Captures files', stageable, no degradation", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: null });
    expect(f.glyph).toBe("↑");
    expect(f.sentence).toBe("Captures files");
    expect(f.stageable).toBe(true);
    expect(f.turnsOn).toBe(false);
    expect(f.nothingYet).toBe(false);
  });
  it("a real (non-empty) capture verb never falls back to the generic copy", () => {
    const f = rowFate({ ...base, direction: "capture" });
    expect(f.sentence).toBe("Captures settings");
    expect(f.sentence).not.toBe("Captures files");
  });
});

// C-#24: a rule-excluded item tells the truth instead of masquerading as "In sync".
describe("rowFate — excludedHere (C-#24)", () => {
  it("neutral + excludedHere: honest sentence, unstageable, dash glyph, your-rule chip", () => {
    const f = rowFate({ ...base, direction: null, excludedHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.glyph).toBe("—");
    expect(f.stageable).toBe(false);
    expect(f.turnsOn).toBe(false);
    expect(f.chips).toContain("your rule");
  });
  it("excludedHere wins over nothingYet — the rule is why, not incidental emptiness", () => {
    const f = rowFate({ ...base, direction: null, excludedHere: true, nothingYet: true });
    expect(f.sentence).toBe("Not synced on this device");
  });
  it("a directional family member keeps its directional sentence — excludedHere is ignored", () => {
    const f = rowFate({ ...base, direction: "apply", excludedHere: true });
    expect(f.sentence).not.toBe("Not synced on this device");
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).not.toContain("your rule");
  });
  it("a conflicted family keeps its conflict sentence — excludedHere is ignored", () => {
    const f = rowFate({ ...base, conflict: true, excludedHere: true });
    expect(f.sentence).toBe("Changed on both sides");
    expect(f.chips).not.toContain("your rule");
  });
  it("excludedHere false is byte-identical to the pre-existing sentences (in sync / nothing yet)", () => {
    expect(rowFate({ ...base, direction: null, excludedHere: false }).sentence).toBe("In sync");
    expect(rowFate({ ...base, direction: null, excludedHere: false, nothingYet: true }).sentence).toBe("No settings yet");
    expect(rowFate({ ...base, direction: null, excludedHere: false }).chips).not.toContain("your rule");
  });
});

describe("rowFate — Runs on re-derivation", () => {
  it("never-here removes turns on, adds rule chip", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "never-here" });
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).toContain("off here — your rule");
    expect(f.turnsOn).toBe(false);
  });
  it("always-here on a store-off plugin adds turns on + rule chip", () => {
    const f = rowFate({ ...base, storeListOn: false, memberRule: "always-here" });
    expect(f.sentence).toBe("Turns on · applies settings");
    expect(f.chips).toContain("on here — your rule");
  });
  it("class rule suppresses turn-on on the wrong class", () => {
    const f = rowFate({ ...base, storeListOn: true, memberRule: "mobile", deviceClass: "desktop" });
    expect(f.turnsOn).toBe(false);
  });
  it("carrier unsynced suppresses enablement verbs entirely", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true, carrierSynced: false });
    expect(f.sentence).toBe("Installs · applies settings");
    expect(f.sentence).not.toContain("turns on");
  });
});

// c-livetest batch5 task 1: a family whose companion(s) contribute files joins the folder verb
// after the row's own settings verb, instead of the folder row's REPLACE behavior above.
describe("rowFate — family file-verb join (c-livetest batch5)", () => {
  it("settings + files: join, settings verb first", () => {
    const f = rowFate({ ...base, folderFileCount: 3 });
    expect(f.sentence).toBe("Applies settings · applies 3 files");
  });
  it("files-only (no settings payload): folder verb alone, no dangling separator", () => {
    const f = rowFate({ ...base, hasSettingsPayload: false, folderFileCount: 3 });
    expect(f.sentence).toBe("Applies 3 files");
  });
  it("capture side: settings + files join", () => {
    const f = rowFate({ ...base, direction: "capture", folderFileCount: 3 });
    expect(f.sentence).toBe("Captures settings · captures 3 files");
  });
  it("capture side, files-only", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, folderFileCount: 3 });
    expect(f.sentence).toBe("Captures 3 files");
  });
  it("zero folderFileCount never joins (no companions actionable this direction)", () => {
    const f = rowFate({ ...base, folderFileCount: 0 });
    expect(f.sentence).toBe("Applies settings");
  });
  it("folder-type row (special: 'folder') keeps its byte-identical replace sentence even with hasSettingsPayload true", () => {
    const f = rowFate({ ...base, special: "folder", folderFileCount: 3 });
    expect(f.sentence).toBe("Applies 3 files");
  });
  it("appearance special keeps its byte-identical sentence even with a nonzero folderFileCount", () => {
    const f = rowFate({ ...base, special: "appearance", folderFileCount: 3 });
    expect(f.sentence).toBe("Applies theme & snippets — live");
  });
  it("joins alongside install + turns on", () => {
    const f = rowFate({ ...base, installed: false, storeListOn: true, folderFileCount: 2 });
    expect(f.sentence).toBe("Installs · turns on · applies settings · applies 2 files");
  });

  // Review fix (CRITICAL): a folder row in a state with no `changes` attached (e.g.
  // "not-captured" — groupStatus never attaches one there) has folderFileCount:null, not 0. The
  // special:"folder" branch must fall through to the generic settings verb, never render empty.
  it("folder row with folderFileCount:null falls through to the generic settings verb (capture)", () => {
    const f = rowFate({ ...base, direction: "capture", special: "folder", folderFileCount: null, hasSettingsPayload: true });
    expect(f.sentence).toBe("Captures settings");
  });
  it("folder row with folderFileCount:null falls through to the generic settings verb (apply)", () => {
    const f = rowFate({ ...base, special: "folder", folderFileCount: null, hasSettingsPayload: true });
    expect(f.sentence).toBe("Applies settings");
  });
});
