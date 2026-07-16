import { describe, expect, it } from "vitest";
import { classifyMerge } from "../src/core/merge";
import { SyncGroup } from "../src/core/types";

// {configDir}-relative file group → store rel "store/configdir/<name>.json" (groupStorePath
// rewrites the {configDir} prefix to the literal "configdir" segment; see src/core/pathing.ts).
function group(name: string, overrides: Partial<SyncGroup> = {}): SyncGroup {
  return { name, path: `{configDir}/${name}.json`, type: "file", devices: "all", ...overrides };
}

function storeRel(name: string): string {
  return `store/configdir/${name}.json`;
}

// A plain (non-configDir) directory group, so store rels nest under "store/<name>/...".
function dirGroup(name: string, overrides: Partial<SyncGroup> = {}): SyncGroup {
  return { name, path: name, type: "dir", devices: "all", ...overrides };
}

describe("classifyMerge", () => {
  it("switch-list files with equal membership in a different order classify identical, not conflict", () => {
    const g = group("community-plugins");
    const local = new Map([[storeRel("community-plugins"), '["a","b","c"]']]);
    const remote = new Map([[storeRel("community-plugins"), '["c",\n "a", "b"]']]);
    const plan = classifyMerge([g], local, [g], remote);
    expect(plan.conflicts).toEqual([]);
    expect(plan.auto.identical).toContain(`file:${storeRel("community-plugins")}`);
  });

  it("switch-list files with a real membership difference still conflict", () => {
    const g = group("community-plugins");
    const local = new Map([[storeRel("community-plugins"), '["a","b"]']]);
    const remote = new Map([[storeRel("community-plugins"), '["a","b","c"]']]);
    const plan = classifyMerge([g], local, [g], remote);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.kind).toBe("file");
  });

  it("non-switch-list files keep byte comparison (reordered JSON arrays conflict)", () => {
    const g = group("hotkeys");
    const local = new Map([[storeRel("hotkeys"), '["a","b"]']]);
    const remote = new Map([[storeRel("hotkeys"), '["b","a"]']]);
    const plan = classifyMerge([g], local, [g], remote);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("empty-empty edge: all empty inputs produce an empty plan", () => {
    const plan = classifyMerge([], new Map(), [], new Map());
    expect(plan).toEqual({
      auto: { addGroups: [], writeFiles: [], keptLocalGroups: [], keptLocalFiles: [], identical: [] },
      conflicts: [],
    });
  });

  it("remote-only group with its files lands in addGroups + writeFiles", () => {
    const remoteGroup = group("hotkeys");
    const remoteFiles = new Map([[storeRel("hotkeys"), '{"a":1}']]);

    const plan = classifyMerge([], new Map(), [remoteGroup], remoteFiles);

    expect(plan.auto.addGroups).toEqual([remoteGroup]);
    expect(plan.auto.writeFiles).toEqual([{ rel: storeRel("hotkeys"), content: '{"a":1}', name: "hotkeys" }]);
    expect(plan.auto.keptLocalGroups).toEqual([]);
    expect(plan.auto.keptLocalFiles).toEqual([]);
    expect(plan.auto.identical).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("local-only group + files are kept, never conflict", () => {
    const localGroup = dirGroup("appearance");
    const localFiles = new Map([["store/appearance/theme.css", "body{}"]]);

    const plan = classifyMerge([localGroup], localFiles, [], new Map());

    expect(plan.auto.keptLocalGroups).toEqual(["appearance"]);
    expect(plan.auto.keptLocalFiles).toEqual(["store/appearance/theme.css"]);
    expect(plan.auto.addGroups).toEqual([]);
    expect(plan.auto.writeFiles).toEqual([]);
    expect(plan.auto.identical).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("identical group definitions and identical file content on both sides are informational only", () => {
    const g = group("hotkeys");
    const files = new Map([[storeRel("hotkeys"), '{"a":1}']]);

    const plan = classifyMerge([g], files, [g], new Map(files));

    expect(plan.auto.identical).toEqual([`file:${storeRel("hotkeys")}`, "group:hotkeys"]);
    expect(plan.auto.addGroups).toEqual([]);
    expect(plan.auto.writeFiles).toEqual([]);
    expect(plan.auto.keptLocalGroups).toEqual([]);
    expect(plan.auto.keptLocalFiles).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("definition conflict: same content but different key order is NOT a conflict", () => {
    const local: SyncGroup = { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" };
    // Same fields, different insertion order.
    const remote: SyncGroup = { devices: "all", type: "file", path: "{configDir}/hotkeys.json", name: "hotkeys" };

    const plan = classifyMerge([local], new Map(), [remote], new Map());

    expect(plan.conflicts).toEqual([]);
    expect(plan.auto.identical).toEqual(["group:hotkeys"]);
  });

  it("definition conflict: same content but different key order in a nested fields array is NOT a conflict", () => {
    const local: SyncGroup = {
      name: "plugin-config-sync",
      path: "{configDir}/plugins/config-sync/data.json",
      type: "file",
      devices: "all",
      mode: "fields",
      fields: [
        { pattern: "rootPath", action: "strip", locked: true },
        { pattern: "remotes", action: "strip", locked: true },
      ],
    };
    const remote: SyncGroup = {
      devices: "all",
      fields: [
        { locked: true, action: "strip", pattern: "rootPath" },
        { action: "strip", locked: true, pattern: "remotes" },
      ],
      mode: "fields",
      name: "plugin-config-sync",
      path: "{configDir}/plugins/config-sync/data.json",
      type: "file",
    };

    const plan = classifyMerge([local], new Map(), [remote], new Map());

    expect(plan.conflicts).toEqual([]);
    expect(plan.auto.identical).toEqual(["group:plugin-config-sync"]);
  });

  it("definition conflict: differing group definitions produce a conflict entry", () => {
    const local = group("hotkeys", { devices: "all" });
    const remote = group("hotkeys", { devices: "desktop" });

    const plan = classifyMerge([local], new Map(), [remote], new Map());

    expect(plan.conflicts).toEqual([{ kind: "definition", name: "hotkeys", local, remote }]);
    expect(plan.auto.identical).toEqual([]);
    expect(plan.auto.addGroups).toEqual([]);
    expect(plan.auto.keptLocalGroups).toEqual([]);
  });

  it("file conflict: byte-differing content on both sides produces a conflict entry", () => {
    const g = group("hotkeys");
    const localFiles = new Map([[storeRel("hotkeys"), '{"a":1}']]);
    const remoteFiles = new Map([[storeRel("hotkeys"), '{"a":2}']]);

    const plan = classifyMerge([g], localFiles, [g], remoteFiles);

    expect(plan.conflicts).toEqual([
      { kind: "file", name: "hotkeys", rel: storeRel("hotkeys"), localContent: '{"a":1}', remoteContent: '{"a":2}' },
    ]);
    expect(plan.auto.identical).toEqual(["group:hotkeys"]);
  });

  it("file whose owning group only exists on one side still resolves a name via that side's groups", () => {
    // Group "theme" only exists remotely; a local orphan file happens to share its store path
    // (e.g. leftover from a deleted group) and conflicts with the remote's file for that group.
    const remoteGroup = group("theme");
    const localFiles = new Map([[storeRel("theme"), '{"local":true}']]);
    const remoteFiles = new Map([[storeRel("theme"), '{"remote":true}']]);

    const plan = classifyMerge([], localFiles, [remoteGroup], remoteFiles);

    expect(plan.conflicts).toEqual([
      { kind: "file", name: "theme", rel: storeRel("theme"), localContent: '{"local":true}', remoteContent: '{"remote":true}' },
    ]);
  });

  it("a non-store rel (e.g. store.lock.json) resolves to an empty owning-group name", () => {
    const remoteFiles = new Map([["store.lock.json", "{}"]]);

    const plan = classifyMerge([], new Map(), [], remoteFiles);

    expect(plan.auto.writeFiles).toEqual([{ rel: "store.lock.json", content: "{}", name: "" }]);
  });

  it("mixed scenario: full MergePlan shape across every cell, deterministically ordered", () => {
    const localOnly = dirGroup("appearance");
    const bothIdentical = group("hotkeys");
    const bothDiffer = group("theme", { devices: "all" });
    const bothDifferRemote = group("theme", { devices: "desktop" });
    const remoteOnly = dirGroup("community-plugins");

    const localGroups = [bothDiffer, bothIdentical, localOnly];
    const remoteGroups = [remoteOnly, bothDifferRemote, bothIdentical];

    const localFiles = new Map([
      ["store/appearance/theme.css", "local-only-file"],
      [storeRel("hotkeys"), "same"],
      [storeRel("theme"), "local-theme"],
      ["store/only-local-file/x.json", "orphan-local"],
    ]);
    const remoteFiles = new Map([
      ["store/community-plugins/data.json", "remote-only-file"],
      [storeRel("hotkeys"), "same"],
      [storeRel("theme"), "remote-theme"],
      ["store.lock.json", "{}"],
    ]);

    const plan = classifyMerge(localGroups, localFiles, remoteGroups, remoteFiles);

    expect(plan.auto.addGroups).toEqual([remoteOnly]);
    expect(plan.auto.writeFiles).toEqual([
      { rel: "store.lock.json", content: "{}", name: "" },
      { rel: "store/community-plugins/data.json", content: "remote-only-file", name: "community-plugins" },
    ]);
    expect(plan.auto.keptLocalGroups).toEqual(["appearance"]);
    expect(plan.auto.keptLocalFiles).toEqual(["store/appearance/theme.css", "store/only-local-file/x.json"]);
    expect(plan.auto.identical).toEqual([`file:${storeRel("hotkeys")}`, "group:hotkeys"]);
    expect(plan.conflicts).toEqual([
      { kind: "definition", name: "theme", local: bothDiffer, remote: bothDifferRemote },
      { kind: "file", name: "theme", rel: storeRel("theme"), localContent: "local-theme", remoteContent: "remote-theme" },
    ]);
  });
});
