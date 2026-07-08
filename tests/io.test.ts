import { describe, expect, it } from "vitest";
import { listFilesRecursive, ensureParentDir, pruneEmptyDirsUnder } from "../src/core/io";
import { MemFS } from "./memfs";

describe("listFilesRecursive", () => {
  it("returns all files under a dir, sorted, full paths", async () => {
    const io = new MemFS();
    io.seed({ "a/x.md": "1", "a/sub/y.md": "2", "b/z.md": "3" });
    expect(await listFilesRecursive(io, "a")).toEqual(["a/sub/y.md", "a/x.md"]);
  });
});

describe("ensureParentDir", () => {
  it("creates missing ancestor dirs", async () => {
    const io = new MemFS();
    await ensureParentDir(io, "one/two/three/file.txt");
    expect(await io.exists("one/two/three")).toBe(true);
  });
  it("is a no-op for root-level files", async () => {
    const io = new MemFS();
    await ensureParentDir(io, "file.txt");
    expect(io.dirs.size).toBe(0);
  });
});

describe("pruneEmptyDirsUnder", () => {
  it("removes empty subdirs but keeps the base and non-empty dirs", async () => {
    const io = new MemFS();
    io.seed({ "base/keep/file.md": "x" });
    await io.mkdir("base/empty/nested");
    await pruneEmptyDirsUnder(io, "base");
    expect(await io.exists("base/empty")).toBe(false);
    expect(await io.exists("base/keep")).toBe(true);
    expect(await io.exists("base")).toBe(true);
  });
});
