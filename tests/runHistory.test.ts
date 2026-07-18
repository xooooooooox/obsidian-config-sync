import { describe, expect, it } from "vitest";
import { GroupResult } from "../src/core/types";
import { worstStatus, countChanged, runDesc, summarizeRun, formatRunTime, pruneHistory, RunRecord } from "../src/core/runHistory";

const noChange = { added: [], updated: [], deleted: [] };
const res = (over: Partial<GroupResult>): GroupResult => ({
  group: "g",
  status: "ok",
  filesWritten: [],
  filesDeleted: [],
  messages: [],
  needsAppReload: false,
  changes: noChange,
  ...over,
});

describe("worstStatus", () => {
  it("returns the worst of ok < warning < error", () => {
    expect(worstStatus([res({ status: "ok" }), res({ status: "ok" })])).toBe("ok");
    expect(worstStatus([res({ status: "ok" }), res({ status: "warning" })])).toBe("warning");
    expect(worstStatus([res({ status: "warning" }), res({ status: "error" })])).toBe("error");
    expect(worstStatus([])).toBe("ok");
  });
});

describe("countChanged", () => {
  it("counts items that did something: non-ok, real file changes, or a state note", () => {
    expect(countChanged([res({ status: "ok" })])).toBe(0);
    expect(countChanged([res({ status: "warning" })])).toBe(1);
    expect(countChanged([res({ changes: { added: ["x"], updated: [], deleted: [] } })])).toBe(1);
    expect(countChanged([res({ stateNote: { kind: "ok", text: "installed" } })])).toBe(1);
  });
});

describe("runDesc", () => {
  it("clean run summarizes the count with the kind verb", () => {
    expect(runDesc("apply", null, [res({ changes: { added: ["a"], updated: [], deleted: [] } })])).toBe("1 item applied");
    expect(runDesc("capture", null, [res({ status: "ok" })])).toBe("no changes");
  });
  it("all-not-in-catalog reads as a manual-install summary", () => {
    const r = res({ status: "warning", messages: ["not in the community catalog — install it manually"] });
    expect(runDesc("apply", null, [r, r])).toBe("2 plugins not in the community catalog — install manually");
  });
  it("hard failures read as failed", () => {
    const r = res({ status: "error", messages: ["store has no data for this group"] });
    expect(runDesc("apply", null, [r])).toBe("1 item failed");
  });
});

describe("formatRunTime", () => {
  it("formats local wall-clock as YYYY-MM-DD HH:MM:SS", () => {
    const ms = new Date(2026, 6, 18, 5, 31, 7).getTime(); // month is 0-based: July
    expect(formatRunTime(ms)).toBe("2026-07-18 05:31:07");
  });
});

describe("summarizeRun", () => {
  it("builds a record with computed status/counts/desc and full results", () => {
    const results = [res({ status: "warning", messages: ["not in the community catalog — install it manually"] }), res({ status: "ok" })];
    const rec = summarizeRun(1000, "apply", null, results);
    expect(rec).toMatchObject({ at: 1000, kind: "apply", remote: null, status: "warning", changed: 1, issues: 1 });
    expect(rec.desc).toContain("not in the community catalog");
    expect(rec.results).toHaveLength(2);
  });
});

describe("pruneHistory", () => {
  const rec = (at: number): RunRecord => ({ at, kind: "apply", remote: null, status: "ok", changed: 0, issues: 0, desc: "", results: [] });
  const now = new Date(2026, 6, 18, 12, 0, 0).getTime();
  const day = 86_400_000;

  it("keeps at most maxCount, newest first, 0 = unlimited", () => {
    const recs = [rec(now), rec(now - day), rec(now - 2 * day), rec(now - 3 * day)];
    expect(pruneHistory(recs, 2, 0, now).map((r) => r.at)).toEqual([now, now - day]);
    expect(pruneHistory(recs, 0, 0, now)).toHaveLength(4);
  });
  it("drops records older than maxDays, 0 = forever", () => {
    const recs = [rec(now), rec(now - 5 * day), rec(now - 40 * day)];
    expect(pruneHistory(recs, 0, 30, now).map((r) => r.at)).toEqual([now, now - 5 * day]);
    expect(pruneHistory(recs, 0, 0, now)).toHaveLength(3);
  });
});
