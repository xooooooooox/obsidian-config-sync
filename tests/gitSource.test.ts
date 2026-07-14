import { describe, expect, it } from "vitest";
import { classifyLsRemote } from "../src/external/gitSource";

describe("classifyLsRemote", () => {
  it("reports branchFound=true when ls-remote prints a ref line", () => {
    const out = "a1b2c3\trefs/heads/main\n";
    expect(classifyLsRemote({ stdout: out })).toEqual({ kind: "ok", branchFound: true });
  });
  it("reports branchFound=false when the repo is reachable but the branch is absent (empty stdout)", () => {
    expect(classifyLsRemote({ stdout: "  \n" })).toEqual({ kind: "ok", branchFound: false });
  });
  it("reports an error with the git message when the call throws", () => {
    expect(classifyLsRemote({ error: new Error("Permission denied (publickey).") })).toEqual({
      kind: "error",
      message: "Permission denied (publickey).",
    });
  });
});
