import { describe, expect, it } from "vitest";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { FileChanges } from "../src/core/types";
// Resolving a conflict has ONE control since R4 — the pair inside the Files block, under the
// entry list — and one decision behind it. A diff in this plugin shows "what THIS choice would
// do" (`diffPair`'s `produced` is post-transform), so the choice pair lives in the same block the
// diffs open in. Everything routes through `pickConflictSide`; these tests drive it and the
// descriptor the pair is handed (`conflictResolve`'s DiffResolveControl, now the view's own type).

interface ResolveInternals {
  conflictChoice: Map<string, "apply" | "capture">;
  selected: Set<string>;
  renderGen: number;
  repaintResolveSegments: (name: string) => void;
  refreshItemRow: (name: string) => void;
  refreshActionBar: () => void;
  pickConflictSide: (name: string, choice: "apply" | "capture") => void;
  conflictResolve: (r: unknown, changes: FileChanges) => { group: string; chosen: "apply" | "capture" | null; scopeNote: string | null; onPick: (side: "apply" | "capture") => void };
}

// The three repaints a choice triggers all need a live pane; the decision under test is what runs
// before them, and it is the part that has to be identical whichever entrance called it. Stubbing
// them here is the same line the pre-existing tests drew around `render`.
function viewFor(): ResolveInternals {
  const view = new SyncCenterView({} as never, {} as never) as unknown as ResolveInternals;
  view.repaintResolveSegments = () => {};
  view.refreshItemRow = () => {};
  view.refreshActionBar = () => {};
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
