import type { MemberRule } from "../core/types";

export interface FateInput {
  direction: "apply" | "capture" | null; // null → in sync / nothing yet
  conflict: boolean;                     // both sides changed
  nothingYet: boolean;                   // no store data & no local settings
  installed: boolean;                    // plugin present locally (true for non-plugins)
  hasUpdate: boolean;                    // store has newer plugin version
  carrierSynced: boolean;                // the on/off list is a synced item
  storeListOn: boolean | null;           // null → no enablement dimension (obsidian/folder/self)
  locallyOn: boolean;
  memberRule: MemberRule;
  deviceClass: "desktop" | "mobile";
  desktopOnly: boolean;
  excludedHere: boolean;                 // this row's own compiled group is scoped away from
                                          // deviceClass by the item's Settings-sync file rule
                                          // (C-#24) — never a store fact, just this device's rule;
                                          // only read when direction is null (a directional/
                                          // conflict family member always wins)
  optedOutHere?: boolean;                 // C-#45: THIS device opted this row's own group out via
                                          // the Stop-syncing menu's "On this device" — a DIFFERENT
                                          // cause from excludedHere (a per-device choice, not a
                                          // class rule) AND a DIFFERENT precedence: checked
                                          // unconditionally, BEFORE conflict/direction (spec §1
                                          // "renders inert" has no family-member-wins exception,
                                          // unlike excludedHere's direction-null-only C-#24 gate —
                                          // fix-round 2, a not-installed plugin derives a real
                                          // "apply" direction independent of this fact, so gating
                                          // it the same way as excludedHere made it unreachable).
                                          // Same row treatment as excludedHere once it wins: glyph/
                                          // sentence/chip/stageable identical, only the card CLAUSE
                                          // differentiates (stateClauseText, SyncCenterView.ts).
                                          // Optional so every pre-existing FateInput literal in
                                          // this suite stays byte-identical.
  hasSettingsPayload: boolean;           // this run writes settings files
  versionAhead: { installed: string; stored: string } | null; // C-#37: installed plugin version
                                          // is newer than the store's recorded version (drift
                                          // "ahead") — capture's real work here is recording the
                                          // newer version, independent of hasSettingsPayload
  special: "appearance" | "folder" | null; // "folder": a dir-type row — its own files ARE the
                                            // payload, folderFileCount REPLACES the settings verb
                                            // (never joins); non-null AND non-folder rows with a
                                            // nonzero folderFileCount are a family whose companion
                                            // dir(s) contribute files alongside the row's own
                                            // settings — join, don't replace (c-livetest batch5)
  folderFileCount: number | null;        // non-null → contributes "…N files" (replace for a
                                          // folder row, join for any other row with companions)
  encrypted: boolean;
}

export interface Fate {
  glyph: "↓" | "↑" | "—" | "⚠";
  sentence: string;   // text only, no glyph
  chips: string[];    // ordered, copy-final
  stageable: boolean; // false → dimmed row, hidden checkbox, skipped by select-all
  turnsOn: boolean;   // the run will switch it on here (drives stagedMembers + footer)
  // C-#28 hardening: true exactly when this Fate IS the nothing-yet presentation (direct, or
  // degraded from an empty-verb direction) — the single source of truth bucket derivation reads
  // (fateBucket), rather than a caller's separately-computed `nothingYet` guess that can
  // disagree with what rowFate actually decided.
  nothingYet: boolean;
  // C-#45 §7 (fix-round 4): true exactly when this Fate IS the excluded presentation — either
  // cause (optedOutHere OR C-#24 excludedHere), same "own fate field" precedent as nothingYet
  // above, and for the same reason: fateBucket must know the row is excluded WITHOUT re-deriving
  // the fact from FateInput (which it never receives — only a Fate), and without re-testing
  // sentence text (fragile, and the two excluded-cause sentences are already identical by design).
  excluded: boolean;
}

function effectiveTurnsOn(i: FateInput): boolean {
  if (!i.carrierSynced || i.storeListOn === null) return false;
  switch (i.memberRule) {
    case "never-here": return false;
    case "always-here": return !i.locallyOn;
    case "desktop": return i.deviceClass === "desktop" && i.storeListOn && !i.locallyOn;
    case "mobile": return i.deviceClass === "mobile" && i.storeListOn && !i.locallyOn;
    case "all": return i.storeListOn && !i.locallyOn;
  }
}

function buildChips(i: FateInput): string[] {
  const chips: string[] = [];
  // C-#45 fix-round 2: an opted-out row is inert regardless of any derivable direction (spec §1 —
  // stronger than C-#24, no direction-null gating) — root cause of the live failure (kickstart,
  // Remotely Save): a not-installed plugin derives a real "apply" direction from the availability
  // ladder independent of the opt-out fact, so `not installed here`/`stays off` (both describe
  // what a RUN would do) leaked through even though the row is now forced to never run. Suppressed
  // here the same way excludedHere's direction:null already made them unreachable for that cause.
  // Fix-round 3 (live-verified on kickstart): the Runs-on ENABLEMENT-rule chips (`off here —
  // your rule`/`on here — your rule`) are ALSO run-consequence facts — a Runs-on rule is moot
  // while the whole item is ignored on this device, and showing it next to `your rule` reads as
  // duplicate/conflicting attribution (the mock-final opted-out row shows only `your rule` +
  // intrinsic facts). `desktop only`/`encrypted` stay unconditional — intrinsic item facts, not
  // run consequences, consistent with how a C-#24 class-excluded row already renders them.
  const inert = i.optedOutHere === true;
  if (!inert && i.direction === "apply" && !i.installed) chips.push("not installed here");
  if (i.desktopOnly) chips.push("desktop only");
  if ((i.direction === null && i.excludedHere) || inert) chips.push("your rule");
  if (!inert && i.carrierSynced && i.storeListOn === false && i.memberRule !== "always-here" && !i.locallyOn) {
    chips.push("stays off");
  }
  if (!inert) {
    if (i.memberRule === "never-here") chips.push("off here — your rule");
    else if (i.memberRule === "always-here") chips.push("on here — your rule");
  }
  if (i.encrypted) chips.push("encrypted");
  return chips;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

// C-#37: shared between rowFate's capture branch (the row sentence) and versionAheadClause below
// (the card clause) so the two can never disagree about which capture case a row is in.
function capturedTurnsOn(i: FateInput): boolean {
  return i.carrierSynced && i.storeListOn === false && i.locallyOn;
}

// Family file-verb join (c-livetest batch5 task 1): a non-folder, non-appearance row whose
// companion(s) contribute files gets the folder verb APPENDED after its own settings verb (or
// alone when it has none) — distinct from a real folder row, which REPLACES the settings verb
// outright (unchanged behavior, `special: "folder"`).
function joinFolderVerb(settingsPart: string | null, folderVerb: string): string {
  return settingsPart === null ? folderVerb : `${settingsPart} · ${folderVerb}`;
}

function settingsVerb(i: FateInput, turnedOn: boolean): string | null {
  if (i.direction === "capture") {
    if (turnedOn) return "turned on here — shares it";
    if (i.special === "appearance") return "captures theme & snippets";
    // A folder row with no changes attached (e.g. "not-captured" — groupStatus never attaches
    // `changes` there) has folderFileCount:null, NOT a file count of zero: it must fall through
    // to the generic settings verb below exactly as a non-folder row would, never render empty.
    if (i.special === "folder" && i.folderFileCount !== null) return `captures ${i.folderFileCount} files`;
    const settingsPart = i.hasSettingsPayload ? "captures settings" : null;
    if (i.special !== "folder" && i.folderFileCount !== null && i.folderFileCount > 0) {
      return joinFolderVerb(settingsPart, `captures ${i.folderFileCount} files`);
    }
    return settingsPart;
  }
  if (i.special === "appearance") return "applies theme & snippets — live";
  if (i.special === "folder" && i.folderFileCount !== null) return `applies ${i.folderFileCount} files`;
  const settingsPart = i.hasSettingsPayload ? "applies settings" : null;
  if (i.special !== "folder" && i.folderFileCount !== null && i.folderFileCount > 0) {
    return joinFolderVerb(settingsPart, `applies ${i.folderFileCount} files`);
  }
  return settingsPart;
}

// C-#29: cause-voice copy — nothing has ever been saved, on either side.
export const NOTHING_YET_SENTENCE = "No settings yet";

// C-#28: an APPLY direction can never carry an empty verb set — the direction becomes
// unrepresentable and degrades to the nothing-yet presentation instead (bare glyph, no
// sentence, yet still "stageable"). Chips are unaffected — they describe facts about the row
// (e.g. `stays off`) independent of whether this run actually has anything to do. Apply-only
// (controller ruling, review round 2): a capture-directional rollup only ever exists because a
// member is genuinely local-changed/not-captured; local-changed members always carry a visible
// file count already, so the only empty-verb capture shape is a `not-captured` companion whose
// count is structurally invisible (status.ts never attaches `changes` there) — real capturable
// work, not nothing-yet. Apply direction has no such invisible-count member, so an empty apply
// verb set genuinely means there's nothing to do.
function nothingYetFate(chips: string[]): Fate {
  return { glyph: "—", sentence: NOTHING_YET_SENTENCE, chips, stageable: false, turnsOn: false, nothingYet: true, excluded: false };
}

export function rowFate(i: FateInput): Fate {
  const chips = buildChips(i);

  // C-#45 fix-round 2 (root cause of the live kickstart failure — Remotely Save stayed "Installs"
  // in To apply after "On this device"): opt-out is STRONGER than C-#24 class exclusion (spec §1
  // "renders inert" is unconditional) — an opted-out row is inert regardless of any derivable
  // direction or conflict, so this runs BEFORE the conflict/directional branches below, not gated
  // on direction===null the way excludedHere is. A not-installed plugin (or any row whose family
  // derives a real direction from the availability ladder/companion changes independent of the
  // opt-out fact) would otherwise never reach the direction===null branch that used to be the only
  // place this fact was read — the fact was threaded into FateInput but could never win.
  // excludedHere (class rule) is UNCHANGED below — it keeps its existing C-#24 direction-null-only
  // precedence byte-identical, since a genuinely still-syncing family member legitimately outranks
  // a class-scope mismatch on a DIFFERENT row of the same family; opt-out has no such family-wins
  // debate (spec §1 is unconditional for this row's own group).
  if (i.optedOutHere === true) {
    return { glyph: "—", sentence: "Not synced on this device", chips, stageable: false, turnsOn: false, nothingYet: false, excluded: true };
  }

  if (i.conflict) {
    return { glyph: "⚠", sentence: "Changed on both sides", chips, stageable: false, turnsOn: false, nothingYet: false, excluded: false };
  }

  if (i.direction === null) {
    // C-#24: a rule-excluded item never masquerades as "In sync" — only when the family has no
    // directional/conflict member of its own (checked above) does the exclusion get to speak.
    if (i.excludedHere) {
      return { glyph: "—", sentence: "Not synced on this device", chips, stageable: false, turnsOn: false, nothingYet: false, excluded: true };
    }
    if (i.nothingYet) return nothingYetFate(chips);
    return { glyph: "—", sentence: "In sync", chips, stageable: false, turnsOn: false, nothingYet: false, excluded: false };
  }

  const stageable = true;

  if (i.direction === "capture") {
    const turnedOn = capturedTurnsOn(i);
    const verb = settingsVerb(i, turnedOn);
    // C-#37: version-ahead's own segment joins after whatever verb chain above produced (·
    // grammar), never replaces it — a pure version-ahead row (verb null) renders it alone.
    const versionVerb = i.versionAhead !== null ? `records version ${i.versionAhead.installed}` : null;
    const joined = versionVerb === null ? verb : verb === null ? versionVerb : `${verb} · ${versionVerb}`;
    // C-#28 controller ruling: an empty capture verb set is real, invisible-count work (a
    // `not-captured` companion — see nothingYetFate's comment) — never degrades. Generic,
    // count-free copy: specific counts already render through settingsVerb above.
    const sentence = capitalize(joined ?? "captures files");
    return { glyph: "↑", sentence, chips, stageable, turnsOn: false, nothingYet: false, excluded: false };
  }

  const turnsOn = effectiveTurnsOn(i);
  const segments: string[] = [];
  if (!i.installed) segments.push("installs");
  else if (i.hasUpdate) segments.push("updates");
  if (turnsOn) segments.push("turns on");
  const verb = settingsVerb(i, false);
  if (verb !== null) segments.push(verb);
  if (segments.length === 0) return nothingYetFate(chips);
  const sentence = capitalize(segments.join(" · "));
  return { glyph: "↓", sentence, chips, stageable, turnsOn, nothingYet: false, excluded: false };
}

// C-#37: the three version-ahead on-capture card clauses (spec §3, copy final) — keyed off
// `input.versionAhead` (caller narrows it non-null before calling) plus the same flags
// settingsVerb's capture branch reads, never by matching the row sentence strings, so every
// non-version-ahead row's clause stays byte-identical.
export function versionAheadClause(input: FateInput, versionAhead: { installed: string; stored: string }): string {
  if (capturedTurnsOn(input)) {
    return `Turned on here — your other devices will turn it on the next time they apply. Also records the newer ${versionAhead.installed} so they can update`;
  }
  if (input.hasSettingsPayload) {
    return `Shares your settings with your other devices — and records the newer ${versionAhead.installed} so they can update`;
  }
  return `Installed ${versionAhead.installed} is newer than the store's ${versionAhead.stored} — capture records it so your other devices can update`;
}
