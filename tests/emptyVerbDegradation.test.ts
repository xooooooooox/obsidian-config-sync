import { describe, expect, it } from "vitest";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { SyncGroup } from "../src/core/types";
import { GroupStatus } from "../src/core/status";
import { Availability } from "../src/core/availability";
import { Fate } from "../src/ui/fateModel";
import { RowBucket } from "../src/ui/panelModel";

// C-#28 (docs/superpowers/specs/2026-08-09-c-livetest-batch13-empty-verbs.md), review round 2:
// the reviewer's gap was that fateModel.test.ts only pins rowFate in isolation — these tests
// drive the REAL private computeFateInput/computeFamilyRollup/deriveRow chain (SyncCenterView.ts)
// the live bug actually ran through, the same way scopeExcludedRow.test.ts drives the real
// plugin for C-#24 rather than hand-building a FateInput. `SyncCenterHost` is an interface, so a
// minimal fake implementing only what deriveRow's path actually calls
// (`companionParentOf`/`memberRuleFor`) is enough — no full plugin/app needed.
interface Harness {
  groups: SyncGroup[];
  statuses: Map<string, GroupStatus>;
  availability: Map<string, Availability>;
  deriveRow(r: { group: SyncGroup; status: GroupStatus }): { fate: Fate; bucket: RowBucket };
}

function harness(opts: {
  groups: SyncGroup[];
  statuses: Record<string, GroupStatus>;
  availability?: Record<string, Availability>;
  companionParentOf?: (group: string) => string | null;
  memberRuleFor?: () => string;
}): Harness {
  const host = {
    companionParentOf: opts.companionParentOf ?? (() => null),
    memberRuleFor: opts.memberRuleFor ?? (() => "all"),
    deviceOptedOut: () => false,
  };
  const view = new SyncCenterView({} as never, host as never);
  const instance = view as unknown as Harness;
  instance.groups = opts.groups;
  instance.statuses = new Map(Object.entries(opts.statuses));
  instance.availability = new Map(Object.entries(opts.availability ?? {}));
  return instance;
}

function fileGroup(name: string): SyncGroup {
  return { name, path: name, type: "file", devices: "all" };
}

function dirGroup(name: string): SyncGroup {
  return { name, path: name, type: "dir", devices: "all" };
}

describe("deriveRow — empty-verb degradation, integration (C-#28, review round 2)", () => {
  // CRITICAL fix under review: a `not-captured` companion never carries a `changes` payload
  // (status.ts:64) — its file count is structurally invisible, not zero. The parent itself has
  // no settings of its own ("no-settings" — neutral parent). The family still rolls up to a real
  // capture direction (the companion IS genuinely uncaptured work); the empty verb set must NOT
  // degrade to nothing-yet — it renders the generic, count-free capture verb and stays stageable.
  it("not-captured companion + neutral parent: ↑ Captures files, stageable, bucket capture", () => {
    const parent = fileGroup("custom-notes");
    const companion = dirGroup("notes-attachments");
    const h = harness({
      groups: [parent, companion],
      statuses: {
        "custom-notes": { group: "custom-notes", state: "no-settings" },
        "notes-attachments": { group: "notes-attachments", state: "not-captured" }, // no `changes`
      },
      companionParentOf: (g) => (g === "notes-attachments" ? "custom-notes" : null),
    });

    const derived = h.deriveRow({ group: parent, status: h.statuses.get("custom-notes")! });

    expect(derived.fate.glyph).toBe("↑");
    expect(derived.fate.sentence).toBe("Captures files");
    expect(derived.fate.stageable).toBe(true);
    expect(derived.fate.nothingYet).toBe(false);
    expect(derived.bucket).toBe("capture");
  });

  // The live 5-row bug, reproduced end to end: an installed-but-disabled plugin (section
  // "disabled", non-main — every state but "locked" stages there) whose family rolls up to
  // "no-settings" (no store data, no local settings) and whose enablement is already in sync
  // (store list also says off — `stays off`, no "turns on" verb). Pre-fix this derived a bare ↓
  // with an empty sentence, still stageable. Post-fix: degrades to nothing-yet, bucket "none" —
  // pinned at the deriveRow level, not just rowFate, per the reviewer's gap.
  it("the live 5-row scenario (disabled plugin, stays off, no settings): degrades, bucket none", () => {
    const plugin = fileGroup("plugin-format-converter");
    const carrier = fileGroup("community-plugins");
    const h = harness({
      groups: [plugin, carrier],
      statuses: {
        "plugin-format-converter": { group: "plugin-format-converter", state: "no-settings" },
      },
      availability: {
        "plugin-format-converter": { kind: "disabled", drift: null, localVersion: "1.0.0", storeVersion: null, anchor: "plugin", desktopOnly: false },
      },
    });

    const derived = h.deriveRow({ group: plugin, status: h.statuses.get("plugin-format-converter")! });

    expect(derived.fate.glyph).toBe("—");
    expect(derived.fate.sentence).toBe("No settings yet");
    expect(derived.fate.stageable).toBe(false);
    expect(derived.fate.nothingYet).toBe(true);
    expect(derived.fate.chips).toContain("stays off");
    expect(derived.bucket).toBe("none");
  });

  // Guard (generic capture copy never fires when a real count is available): a `local-changed`
  // companion always carries its `changes` (status.ts:72) — a real, visible file count — so the
  // verb stays the specific "Captures N files", never falling back to the count-free generic.
  it("local-changed companion with visible counts: Captures N files, not the generic fallback", () => {
    const parent = fileGroup("custom-notes-2");
    const companion = dirGroup("notes-attachments-2");
    const h = harness({
      groups: [parent, companion],
      statuses: {
        "custom-notes-2": { group: "custom-notes-2", state: "no-settings" },
        "notes-attachments-2": { group: "notes-attachments-2", state: "local-changed", changes: { added: ["a.png"], updated: [], deleted: [] } },
      },
      companionParentOf: (g) => (g === "notes-attachments-2" ? "custom-notes-2" : null),
    });

    const derived = h.deriveRow({ group: parent, status: h.statuses.get("custom-notes-2")! });

    expect(derived.fate.glyph).toBe("↑");
    expect(derived.fate.sentence).toBe("Captures 1 files");
    expect(derived.fate.sentence).not.toBe("Captures files");
    expect(derived.fate.stageable).toBe(true);
    expect(derived.bucket).toBe("capture");
  });
});
