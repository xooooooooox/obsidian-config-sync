import { describe, expect, it } from "vitest";
import { buildCloneArgs, classifyLsRemote } from "../src/external/gitSource";

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

describe("buildCloneArgs", () => {
  it("omits --sparse when the store is at repo root (subdir empty)", () => {
    expect(buildCloneArgs("main", "git@h:me/c.git", "")).toEqual([
      "-c", "core.autocrlf=false", "clone", "--depth=1", "--filter=blob:none", "--branch", "main", "git@h:me/c.git", ".",
    ]);
  });
  it("adds --sparse when a subdir is given", () => {
    expect(buildCloneArgs("main", "git@h:me/c.git", "0-Extra/config-sync")).toEqual([
      "-c", "core.autocrlf=false", "clone", "--depth=1", "--filter=blob:none", "--sparse", "--branch", "main", "git@h:me/c.git", ".",
    ]);
  });
});
