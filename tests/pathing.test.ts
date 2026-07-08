import { describe, expect, it } from "vitest";
import { groupRealPath, groupStorePath, relativeTo, PathingError } from "../src/core/pathing";

describe("groupRealPath", () => {
  it("resolves {configDir} against the device config dir", () => {
    expect(groupRealPath("{configDir}/snippets", ".obsidian_apple")).toBe(".obsidian_apple/snippets");
  });
  it("returns vault-root paths untouched", () => {
    expect(groupRealPath(".obsidian.vimrc", ".obsidian_apple")).toBe(".obsidian.vimrc");
  });
});

describe("groupStorePath", () => {
  it("maps {configDir} to the canonical configdir/ folder", () => {
    expect(groupStorePath("{configDir}/plugins/cmdr/data.json")).toBe("configdir/plugins/cmdr/data.json");
  });
  it("strips the leading dot of vault-root paths", () => {
    expect(groupStorePath(".obsidian.vimrc")).toBe("obsidian.vimrc");
  });
  it("keeps dot-less vault paths unchanged", () => {
    expect(groupStorePath("some/folder/file.md")).toBe("some/folder/file.md");
  });
});

describe("relativeTo", () => {
  it("returns the path relative to a base dir", () => {
    expect(relativeTo("a/b", "a/b/c/d.json")).toBe("c/d.json");
  });
  it("throws when the path is outside the base", () => {
    expect(() => relativeTo("a/b", "a/x/c")).toThrow(PathingError);
  });
});
