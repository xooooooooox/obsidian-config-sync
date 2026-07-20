import { describe, expect, it } from "vitest";
import { diffLines, collapseUnchanged, DiffOp } from "../src/ui/diffView";

const c = (n: number): DiffOp[] => Array.from({ length: n }, (_, i) => ({ kind: "common" as const, text: `c${i}` }));
const del = (t: string): DiffOp => ({ kind: "del", text: t });
const ins = (t: string): DiffOp => ({ kind: "ins", text: t });

describe("diffLines", () => {
  it("marks a single changed line as del+ins amid common", () => {
    const ops = diffLines("a\nb\nc", "a\nX\nc");
    expect(ops).not.toBeNull();
    expect(ops!.map((o) => o.kind)).toEqual(["common", "del", "ins", "common"]);
  });
});

describe("collapseUnchanged", () => {
  it("keeps `context` lines around a change and folds the far run into a gap", () => {
    // 10 common, one del, 10 common; context 3
    const ops = [...c(10), del("x"), ...c(10)];
    const rows = collapseUnchanged(ops, 3);
    // leading fold(7) + 3 common + del + 3 common + trailing fold(7)
    expect(rows.map((r) => (r.kind === "gap" ? `gap${r.count}` : r.kind))).toEqual([
      "gap7", "common", "common", "common", "del", "common", "common", "common", "gap7",
    ]);
  });
  it("does not fold a between-change run of 2*context or shorter", () => {
    const ops = [del("x"), ...c(6), ins("y")]; // 6 == 2*3
    const rows = collapseUnchanged(ops, 3);
    expect(rows.some((r) => r.kind === "gap")).toBe(false);
    expect(rows).toHaveLength(8);
  });
  it("renders a run shorter than minGap inline instead of a gap", () => {
    const ops = [del("x"), ...c(7), ins("y")]; // one non-context line in the middle → would be gap1
    const rows = collapseUnchanged(ops, 3, 2);
    expect(rows.some((r) => r.kind === "gap")).toBe(false); // gap of 1 < minGap 2 → shown inline
    expect(rows.filter((r) => r.kind === "common")).toHaveLength(7);
  });
  it("folds all-common input into one gap; all-changed input has no gap", () => {
    expect(collapseUnchanged(c(20), 3)).toEqual([{ kind: "gap", count: 20 }]);
    const changes = [del("a"), ins("b"), del("c")];
    expect(collapseUnchanged(changes, 3)).toEqual(changes);
  });
});
