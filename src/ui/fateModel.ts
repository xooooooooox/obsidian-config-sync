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
  hasSettingsPayload: boolean;           // this run writes settings files
  special: "appearance" | null;
  folderFileCount: number | null;        // non-null → folder row ("Applies N files")
  encrypted: boolean;
}

export interface Fate {
  glyph: "↓" | "↑" | "—" | "⚠";
  sentence: string;   // text only, no glyph
  chips: string[];    // ordered, copy-final
  stageable: boolean; // false → dimmed row, hidden checkbox, skipped by select-all
  turnsOn: boolean;   // the run will switch it on here (drives stagedMembers + footer)
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
  if (i.direction === "apply" && !i.installed) chips.push("not installed here");
  if (i.desktopOnly) chips.push("desktop only");
  if (i.carrierSynced && i.storeListOn === false && i.memberRule !== "always-here" && !i.locallyOn) {
    chips.push("stays off");
  }
  if (i.memberRule === "never-here") chips.push("off here — your rule");
  else if (i.memberRule === "always-here") chips.push("on here — your rule");
  if (i.encrypted) chips.push("🔒 encrypted");
  return chips;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function settingsVerb(i: FateInput, capturedTurnsOn: boolean): string | null {
  if (i.special === "appearance") return "applies theme & snippets — live";
  if (i.folderFileCount !== null) return `applies ${i.folderFileCount} files`;
  if (i.direction === "capture") {
    if (capturedTurnsOn) return "turned on here — shares it";
    return i.hasSettingsPayload ? "captures settings" : null;
  }
  return i.hasSettingsPayload ? "applies settings" : null;
}

export function rowFate(i: FateInput): Fate {
  const chips = buildChips(i);

  if (i.conflict) {
    return { glyph: "⚠", sentence: "Changed on both sides", chips, stageable: false, turnsOn: false };
  }

  if (i.direction === null) {
    const sentence = i.nothingYet ? "Nothing to sync yet" : "In sync";
    return { glyph: "—", sentence, chips, stageable: false, turnsOn: false };
  }

  const stageable = true;

  if (i.direction === "capture") {
    const capturedTurnsOn = i.carrierSynced && i.storeListOn === false && i.locallyOn;
    const verb = settingsVerb(i, capturedTurnsOn);
    const sentence = capitalize(verb ?? "");
    return { glyph: "↑", sentence, chips, stageable, turnsOn: false };
  }

  const turnsOn = effectiveTurnsOn(i);
  const segments: string[] = [];
  if (!i.installed) segments.push("installs");
  else if (i.hasUpdate) segments.push("updates");
  if (turnsOn) segments.push("turns on");
  const verb = settingsVerb(i, false);
  if (verb !== null) segments.push(verb);
  const sentence = capitalize(segments.join(" · "));
  return { glyph: "↓", sentence, chips, stageable, turnsOn };
}
