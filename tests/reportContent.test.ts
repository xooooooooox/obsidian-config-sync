import { describe, expect, it } from "vitest";
import { chipTooltip, resultLevel, stripHeader } from "../src/ui/reportContent";
import { GroupResult } from "../src/core/types";

function result(overrides: Partial<GroupResult>): GroupResult {
  return {
    group: "demo",
    status: "ok",
    filesWritten: [],
    filesDeleted: [],
    messages: [],
    needsAppReload: false,
    changes: { added: [], updated: [], deleted: [] },
    ...overrides,
  };
}

describe("chipTooltip", () => {
  it("pluralizes per kind", () => {
    expect(chipTooltip("add", 1)).toBe("1 file added");
    expect(chipTooltip("upd", 2)).toBe("2 files updated");
    expect(chipTooltip("del", 3)).toBe("3 files deleted");
  });
});

// Producer -> level table: resultLevel is the
// presentation-only classification the run strip and message lines key off — it never touches
// GroupResult.status.
describe("resultLevel", () => {
  it("is 'ok' for a clean group with no note and no messages", () => {
    expect(resultLevel(result({}))).toBe("ok");
  });

  it("is 'error' whenever GroupResult.status is 'error' (hard failures: missing store data, thrown exceptions, missing local path)", () => {
    expect(resultLevel(result({ status: "error", messages: ["nothing to capture yet: ... does not exist in this vault"] }))).toBe("error");
  });

  it("is 'error' for a 'warn' stateNote even though GroupResult.status stays 'warning' (install/enable/update failed, update skipped)", () => {
    expect(
      resultLevel(
        result({
          status: "warning",
          stateNote: { kind: "warn", text: "⚠ install failed" },
          messages: ["couldn't download demo — install it manually"],
        })
      )
    ).toBe("error");
  });

  it("is 'warning' (a note, not an issue) for a success-side note — the version-fallback message on a successful install", () => {
    expect(
      resultLevel(
        result({
          status: "warning",
          stateNote: { kind: "ok", text: "⤓ installed & enabled 2.2.3" },
          messages: ["the captured version 2.2.2 is no longer downloadable — installed 2.2.3 instead"],
        })
      )
    ).toBe("warning");
  });

  it("is 'ok' for a purely informational message on an otherwise-successful group (e.g. 'installed the plugin only')", () => {
    expect(
      resultLevel(
        result({
          status: "ok",
          stateNote: { kind: "ok", text: "⤓ installed & enabled 2.5.0" },
          messages: ["no settings in the store — installed the plugin only"],
        })
      )
    ).toBe("ok");
  });
});

describe("stripHeader", () => {
  it("clean run: no issues, no notes", () => {
    expect(stripHeader([result({}), result({})])).toEqual({ issues: 0, notes: 0, tone: "clean" });
  });

  it("warnings-only run (e.g. version fallback): note tone, not counted as an issue", () => {
    const fallback = result({ status: "warning", stateNote: { kind: "ok", text: "⤓ installed & enabled 2.2.3" }, messages: ["fallback note"] });
    expect(stripHeader([result({}), fallback])).toEqual({ issues: 0, notes: 1, tone: "note" });
  });

  it("a genuine failure (install failed) is counted as an issue, even though its GroupResult.status is 'warning'", () => {
    const failed = result({ status: "warning", stateNote: { kind: "warn", text: "⚠ install failed" }, messages: ["couldn't download demo"] });
    expect(stripHeader([result({}), failed])).toEqual({ issues: 1, notes: 0, tone: "issue" });
  });

  it("errors win over notes: a run with both an issue and a note still reads as issue-toned", () => {
    const failed = result({ status: "warning", stateNote: { kind: "warn", text: "⚠ install failed" }, messages: ["couldn't download demo"] });
    const fallback = result({ status: "warning", stateNote: { kind: "ok", text: "⤓ installed & enabled 2.2.3" }, messages: ["fallback note"] });
    expect(stripHeader([failed, fallback])).toEqual({ issues: 1, notes: 1, tone: "issue" });
  });
});
