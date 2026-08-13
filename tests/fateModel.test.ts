import { describe, expect, it } from "vitest";
import { rowFate, versionAheadClause, FateInput } from "../src/ui/fateModel";
import { EVERYWHERE, perClass } from "../src/core/types";

const base: FateInput = {
  direction: "apply", conflict: false, nothingYet: false, installed: true,
  hasUpdate: false, carrierSynced: true, storeListOn: null, locallyOn: false,
  ruleSharing: EVERYWHERE, localException: null, deviceClass: "desktop", desktopOnly: false, excludedHere: false,
  hasSettingsPayload: true, versionAhead: null, special: null, folderFileCount: null, encrypted: false,
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

// C-#45 (spec 2026-08-10-c-livetest-batch22-device-optout.md §2): a DIFFERENT cause (a per-device
// choice, not a class rule) but the IDENTICAL row treatment as excludedHere — same glyph/sentence/
// chip/stageable; only the card clause (SyncCenterView.ts's stateClauseText) tells them apart.
// C-#45 fix-round 2 (live failure, kickstart real-use-case): Remotely Save stayed "Installs" in
// To apply after "On this device" — root cause, rowFate only consulted excludedHere/optedOutHere
// inside its direction===null branch (C-#24's family-member-wins precedence), but a not-installed
// plugin derives a REAL "apply" direction from the availability ladder independent of the opt-out
// fact, so that branch was unreachable for this row; the fact was threaded into FateInput but
// could never win. Fix: optedOutHere is now checked UNCONDITIONALLY, before conflict/direction —
// spec §1 "renders inert" has no family-member-wins exception, unlike excludedHere's C-#24 gate,
// which stays exactly as it was (see the "class exclusion" tests below). The tests below this
// comment REPLACE the fix-round-1 versions, which hand-built every case with `direction: null` —
// exactly the shape that masked this bug (the coordinator's own diagnosis).
describe("rowFate — optedOutHere (C-#45 fix-round 2: unconditional, not direction-null-gated)", () => {
  it("neutral + optedOutHere: same honest sentence, unstageable, dash glyph, your-rule chip as excludedHere", () => {
    const f = rowFate({ ...base, direction: null, optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.glyph).toBe("—");
    expect(f.stageable).toBe(false);
    expect(f.turnsOn).toBe(false);
    expect(f.chips).toContain("your rule");
  });
  it("optedOutHere wins over nothingYet — the rule is why, not incidental emptiness", () => {
    const f = rowFate({ ...base, direction: null, optedOutHere: true, nothingYet: true });
    expect(f.sentence).toBe("Not synced on this device");
  });
  // THE EXACT LIVE SHAPE (kickstart, Remotely Save): installed:false + a real "apply" direction
  // derived from the availability ladder (the plugin isn't installed here, so a plain apply row
  // would normally read "Installs") + optedOutHere:true. Truth-table case per the coordinator's
  // explicit ask.
  it("direction-derivable input (installed:false, apply ladder) + optedOutHere:true → inert excluded fate, not 'Installs' (live-failure repro)", () => {
    const f = rowFate({ ...base, direction: "apply", installed: false, optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.sentence).not.toContain("Installs");
    expect(f.glyph).toBe("—");
    expect(f.stageable).toBe(false);
    expect(f.chips).toContain("your rule");
    expect(f.chips).not.toContain("not installed here"); // a run-consequence chip — meaningless for an inert row
  });
  it("a directional family member does NOT override optedOutHere — opt-out has no family-member-wins exception (spec §1, unlike excludedHere)", () => {
    const f = rowFate({ ...base, direction: "apply", optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.chips).toContain("your rule");
  });
  it("a conflicted family does NOT override optedOutHere either — opt-out wins over conflict too", () => {
    const f = rowFate({ ...base, conflict: true, optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.glyph).toBe("—");
    expect(f.chips).toContain("your rule");
  });
  it("a capture-directional row does NOT override optedOutHere", () => {
    const f = rowFate({ ...base, direction: "capture", optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.glyph).toBe("—");
  });
  it("optedOutHere absent (the default for every pre-existing FateInput literal) is byte-identical to false", () => {
    expect(rowFate({ ...base, direction: null }).sentence).toBe("In sync");
    expect(rowFate({ ...base, direction: null }).chips).not.toContain("your rule");
    expect(rowFate({ ...base, direction: "apply" }).sentence).toBe("Applies settings");
  });
  it("both facts true at once still render the identical row (cause is a card-clause-only distinction)", () => {
    const f = rowFate({ ...base, direction: null, excludedHere: true, optedOutHere: true });
    expect(f.sentence).toBe("Not synced on this device");
    expect(f.chips).toContain("your rule");
  });
});

// C-#45 fix-round 3 (live-verified on kickstart, second residue after fix-round 2): the opted-out
// row rendered ["your rule", "off here — your rule", "encrypted"] against the mockup's single
// `your rule` (+ intrinsic facts) — a Runs-on ENABLEMENT rule is a run-consequence fact, moot
// while the whole item is ignored on this device, and duplicated the `your rule` attribution.
describe("rowFate — optedOutHere suppresses the local-exception chips (C-#45 fix-round 3)", () => {
  it("never-here's chip is suppressed when opted out — only your rule remains", () => {
    const f = rowFate({ ...base, direction: null, optedOutHere: true, localException: "off" });
    expect(f.chips).toContain("your rule");
    expect(f.chips).not.toContain("off here — your rule");
  });
  it("always-here's chip is suppressed when opted out — only your rule remains", () => {
    const f = rowFate({ ...base, direction: null, optedOutHere: true, localException: "on" });
    expect(f.chips).toContain("your rule");
    expect(f.chips).not.toContain("on here — your rule");
  });
  it("NOT opted out: the enablement-rule chip is unaffected (regression guard — only opt-out suppresses it)", () => {
    const f = rowFate({ ...base, localException: "off" });
    expect(f.chips).toContain("off here — your rule");
  });
  it("intrinsic-fact chips (encrypted, desktop only) survive opt-out — only run-consequence chips are suppressed", () => {
    const f = rowFate({ ...base, direction: null, optedOutHere: true, localException: "off", encrypted: true, desktopOnly: true });
    expect(f.chips).toEqual(["desktop only", "your rule", "encrypted"]); // exact set + order the mockup shows
  });
});

// Class exclusion (C-#24, excludedHere) keeps its EXISTING direction-null-only precedence
// byte-identical — these are the same assertions the fix-round-1 optedOutHere tests used to make
// (now proven wrong for opt-out), reattached to excludedHere where they remain correct: a
// genuinely still-syncing family member legitimately outranks a class-scope mismatch on a
// DIFFERENT row of the same family, so excludedHere must still lose to a real direction/conflict.
describe("rowFate — excludedHere keeps C-#24's family-member-wins precedence (fix-round-2 regression guard)", () => {
  it("a directional family member keeps its directional sentence — excludedHere is ignored (unchanged)", () => {
    const f = rowFate({ ...base, direction: "apply", excludedHere: true });
    expect(f.sentence).not.toBe("Not synced on this device");
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).not.toContain("your rule");
  });
  it("a conflicted family keeps its conflict sentence — excludedHere is ignored (unchanged)", () => {
    const f = rowFate({ ...base, conflict: true, excludedHere: true });
    expect(f.sentence).toBe("Changed on both sides");
    expect(f.chips).not.toContain("your rule");
  });
});

describe("rowFate — the two enablement layers", () => {
  it("never-here removes turns on, adds rule chip", () => {
    const f = rowFate({ ...base, storeListOn: true, localException: "off" });
    expect(f.sentence).toBe("Applies settings");
    expect(f.chips).toContain("off here — your rule");
    expect(f.turnsOn).toBe(false);
  });
  it("always-here on a store-off plugin adds turns on + rule chip", () => {
    const f = rowFate({ ...base, storeListOn: false, localException: "on" });
    expect(f.sentence).toBe("Turns on · applies settings");
    expect(f.chips).toContain("on here — your rule");
  });
  it("class rule suppresses turn-on on the wrong class", () => {
    const f = rowFate({ ...base, storeListOn: true, ruleSharing: perClass("mobile"), deviceClass: "desktop" });
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

// C-#37: files in-sync both sides but installed plugin version newer than the store's — a
// raw-in-sync row that presentedState relabels to-capture, whose only real work is recording the
// newer version. versionAhead joins after whatever verb chain the row already has (spec §2).
describe("rowFate — version-ahead capture (C-#37)", () => {
  const ahead = { installed: "2.2.3", stored: "2.2.2" };

  it("pure version-ahead: no settings payload, no other verb — records version alone", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, versionAhead: ahead });
    expect(f.glyph).toBe("↑");
    expect(f.sentence).toBe("Records version 2.2.3");
    expect(f.stageable).toBe(true);
    expect(f.nothingYet).toBe(false);
  });
  it("settings + version: joins after the settings verb", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: true, versionAhead: { installed: "2.1.0", stored: "2.0.9" } });
    expect(f.sentence).toBe("Captures settings · records version 2.1.0");
  });
  it("turned-on + version: joins after the turned-on verb", () => {
    const f = rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true, versionAhead: ahead });
    expect(f.sentence).toBe("Turned on here — shares it · records version 2.2.3");
  });
  it("versionAhead: null keeps every existing capture sentence byte-identical (fence)", () => {
    expect(rowFate({ ...base, direction: "capture" }).sentence).toBe("Captures settings");
    expect(rowFate({ ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true }).sentence).toBe("Turned on here — shares it");
  });
});

// C-#37: the card's on-capture clause — same three cases as the sentence above, asserted through
// the exported pure helper stateClauseText delegates to (spec §4).
describe("versionAheadClause — card on-capture clauses (C-#37, spec §3)", () => {
  const ahead = { installed: "2.2.3", stored: "2.2.2" };

  it("pure version-ahead", () => {
    const input: FateInput = { ...base, direction: "capture", hasSettingsPayload: false, versionAhead: ahead };
    expect(versionAheadClause(input, ahead)).toBe(
      "Installed 2.2.3 is newer than the store's 2.2.2 — capture records it so your other devices can update",
    );
  });
  it("settings + version", () => {
    const input: FateInput = { ...base, direction: "capture", hasSettingsPayload: true, versionAhead: ahead };
    expect(versionAheadClause(input, ahead)).toBe(
      "Shares your settings with your other devices — and records the newer 2.2.3 so they can update",
    );
  });
  it("turned-on + version", () => {
    const input: FateInput = {
      ...base, direction: "capture", hasSettingsPayload: false, storeListOn: false, locallyOn: true, versionAhead: ahead,
    };
    expect(versionAheadClause(input, ahead)).toBe(
      "Turned on here — your other devices will turn it on the next time they apply. Also records the newer 2.2.3 so they can update",
    );
  });
});
