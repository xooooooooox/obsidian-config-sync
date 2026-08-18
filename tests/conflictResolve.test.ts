import { describe, expect, it } from "vitest";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { FileChanges } from "../src/core/types";
import type { DiffResolveControl } from "../src/ui/diffView";

// Resolving a conflict now has TWO entrances — the card's `Resolve` row and the segmented control
// in each open diff's toolbar — and they must be the same decision, not two that happen to agree.
// The diff one exists because of what a diff in this plugin IS: `diffPair`'s `produced` has already
// been through captureTransform/applyTransform, so a diff never shows "how these two files differ",
// it shows "what THIS choice would do". The side you are looking at and the side you are choosing
// are the same parameter, so the control that switches one has to be the control that commits the
// other. Both entrances route through `pickConflictSide`; these tests drive it and the descriptor
// the toolbar is handed.

interface ResolveInternals {
  conflictChoice: Map<string, "apply" | "capture">;
  selected: Set<string>;
  render: (gen: number) => void;
  renderGen: number;
  pickConflictSide: (name: string, choice: "apply" | "capture") => void;
  conflictResolve: (r: unknown, changes: FileChanges) => DiffResolveControl;
}

function viewFor(): ResolveInternals {
  const view = new SyncCenterView({} as never, {} as never) as unknown as ResolveInternals;
  view.render = () => {}; // the real one needs a live pane; the decision under test runs before it
  return view;
}

const changes = (n: number): FileChanges => ({
  added: [],
  updated: Array.from({ length: n }, (_, i) => `f${i}.json`),
  deleted: [],
});

const ROW = { group: { name: "appearance", label: "Appearance" } };

describe("pickConflictSide — one decision, whichever entrance made it", () => {
  it("records the side and stages the row", () => {
    const v = viewFor();
    v.pickConflictSide("appearance", "apply");
    expect(v.conflictChoice.get("appearance")).toBe("apply");
    expect(v.selected.has("appearance")).toBe(true);
  });

  it("switches sides without unstaging", () => {
    const v = viewFor();
    v.pickConflictSide("appearance", "apply");
    v.pickConflictSide("appearance", "capture");
    expect(v.conflictChoice.get("appearance")).toBe("capture");
    expect(v.selected.has("appearance")).toBe(true);
  });

  // The same "click the active segment to unstage" idiom renderDirectionToggle uses. It matters
  // more here than elsewhere: Resolve is this row's ONLY staging affordance, since its checkbox
  // stays hidden until a side is picked.
  it("clears the choice and unstages when the active side is picked again", () => {
    const v = viewFor();
    v.pickConflictSide("appearance", "apply");
    v.pickConflictSide("appearance", "apply");
    expect(v.conflictChoice.has("appearance")).toBe(false);
    expect(v.selected.has("appearance")).toBe(false);
  });
});

describe("the descriptor handed to every diff toolbar", () => {
  it("reports the side already chosen, so both entrances paint the same state", () => {
    const v = viewFor();
    expect(v.conflictResolve(ROW, changes(1)).chosen).toBeNull();
    v.pickConflictSide("appearance", "capture");
    expect(v.conflictResolve(ROW, changes(1)).chosen).toBe("capture");
  });

  it("picking from a diff toolbar lands in the same place the Resolve row writes", () => {
    const v = viewFor();
    v.conflictResolve(ROW, changes(1)).onPick("apply");
    expect(v.conflictChoice.get("appearance")).toBe("apply");
    expect(v.selected.has("appearance")).toBe(true);
  });

  // A run writes a whole group (`ApplyItem`/`CaptureItem` carry a group name; `stagedMembers`, the
  // only partial mechanism, is switch-list-only), so on a multi-file item a side picked inside one
  // file's diff settles files that window never showed. Saying so is the difference between a scope
  // and a surprise.
  it("discloses the scope only when the file being viewed is not the whole item", () => {
    const v = viewFor();
    expect(v.conflictResolve(ROW, changes(1)).scopeNote).toBeNull();
    const note = v.conflictResolve(ROW, changes(3)).scopeNote;
    expect(note).not.toBeNull();
    expect(note).toContain("3 files");
    expect(note).toContain("Appearance");
  });
});
