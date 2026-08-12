import { describe, expect, it } from "vitest";
import {
  companionConflictError,
  companionNameConflictError,
  normalizeCompanionPath,
  sortCompanionMemberNames,
  validateCompanionBasename,
  validateCompanionPath,
} from "../src/ui/itemCard";
import {
  buildItemDefs,
  companionConflict,
  companionNameConflict,
  CompileSettings,
  compileItems,
  defRef,
  emptyItem,
  Item,
  ItemDef,
  RegistryEnv,
} from "../src/core/registry";
import { leftoverStoreRels } from "../src/core/leftover";
import { Section } from "../src/core/types";
import { itemsIn } from "./items";

// spec docs/superpowers/specs/2026-07-25-unified-card-design.md §4/§8, D7/D8; task-7-brief.md.

function settings(partial: Partial<Record<Section, Record<string, Item>>> = {}): CompileSettings {
  return { items: itemsIn(partial) };
}

function on(overrides: Partial<Item> = {}): Item {
  return { ...emptyItem(), enabled: true, ...overrides };
}

const EMPTY_ENV: RegistryEnv = { cores: [], plugins: [], betaIds: new Set() };

const ENV: RegistryEnv = {
  cores: [{ id: "graph", name: "Graph view", fileExists: true }],
  plugins: [{ id: "dataview", name: "Dataview" }],
  betaIds: new Set(),
};

describe("normalizeCompanionPath", () => {
  it("trims, converts backslashes, collapses '//' and strips leading/trailing slashes", () => {
    expect(normalizeCompanionPath("  attachments  ")).toBe("attachments");
    expect(normalizeCompanionPath("a\\b\\c")).toBe("a/b/c");
    expect(normalizeCompanionPath("a//b///c")).toBe("a/b/c");
    expect(normalizeCompanionPath("/a/b/")).toBe("a/b");
    expect(normalizeCompanionPath("a/b/")).toBe("a/b");
  });
});

describe("validateCompanionPath", () => {
  it("rejects empty (incl. whitespace-only)", () => {
    expect(validateCompanionPath("")).toEqual({ ok: false, error: "Enter a path." });
    expect(validateCompanionPath("   ")).toEqual({ ok: false, error: "Enter a path." });
    expect(validateCompanionPath("///")).toEqual({ ok: false, error: "Enter a path." });
  });

  it("rejects absolute unix paths", () => {
    expect(validateCompanionPath("/etc/passwd").ok).toBe(false);
    expect(validateCompanionPath("/attachments").ok).toBe(false);
  });

  it("rejects absolute windows paths (drive letter or backslash-rooted)", () => {
    expect(validateCompanionPath("C:\\Users\\me").ok).toBe(false);
    expect(validateCompanionPath("c:/Users/me").ok).toBe(false);
  });

  it("rejects any '..' segment, including a disguised one after normalization", () => {
    expect(validateCompanionPath("..").ok).toBe(false);
    expect(validateCompanionPath("../secrets").ok).toBe(false);
    expect(validateCompanionPath("attachments/../../etc").ok).toBe(false);
    expect(validateCompanionPath("a/..b/c").ok).toBe(true); // "..b" is not a ".." segment
  });

  it("accepts a plain vault-relative path and returns its normalized form", () => {
    expect(validateCompanionPath("my folder/sub")).toEqual({ ok: true, path: "my folder/sub" });
    expect(validateCompanionPath(" attachments/ ")).toEqual({ ok: true, path: "attachments" });
  });

  it("handles backslash path separators as forward slashes for both absolute-detection and the accepted path", () => {
    expect(validateCompanionPath("a\\b")).toEqual({ ok: true, path: "a/b" });
  });
});

describe("companionConflictError copy", () => {
  it("names the offending item", () => {
    expect(companionConflictError("Appearance")).toBe("Appearance already syncs this path.");
  });
});

describe("validateCompanionBasename (final-review MUST-FIX 1 — UI-level: refuses the add BEFORE persist)", () => {
  it("rejects a basename containing a space", () => {
    expect(validateCompanionBasename("assets/My Folder")).toBe(
      'Folder name "My Folder" must use only letters, digits, "-" or "_", starting with a letter or digit.'
    );
  });

  it("rejects a basename containing a dot", () => {
    expect(validateCompanionBasename("assets/my.backup")).not.toBeNull();
  });

  it("accepts a legal basename (letters, digits, '-', '_')", () => {
    expect(validateCompanionBasename("assets/my-folder_1")).toBeNull();
  });
});

describe("companionNameConflict (final-review MUST-FIX 1 — UI-level: refuses the add BEFORE persist)", () => {
  const defs = buildItemDefs(ENV);
  const dataview = defs.find((d) => d.section === "community" && d.id === "dataview") as ItemDef;

  it("rejects a basename that collides with a reserved registry group name", () => {
    expect(companionNameConflict("assets/hotkeys", defs, settings({}), null)).toBe("hotkeys");
  });

  it("rejects a basename that collides with a DIFFERENT item's already-configured companion, even though the full paths differ", () => {
    const cfg = itemsIn({ community: { [dataview.id]: on({ companions: [{ path: "a/logs", device: "all", enabled: true }] }) } });
    expect(companionNameConflict("b/logs", defs, { items: cfg }, null)).toBe("logs");
  });

  it("excludes the entry being edited — renaming a path while keeping the same basename does not self-collide", () => {
    const cfg = itemsIn({ community: { [dataview.id]: on({ companions: [{ path: "a/logs", device: "all", enabled: true }] }) } });
    const s = { items: cfg };
    expect(companionNameConflict("other/logs", defs, s, { ref: defRef(dataview), path: "a/logs" })).toBeNull();
  });

  it("a genuinely free basename returns null", () => {
    expect(companionNameConflict("assets/totally-free-name", defs, settings({}), null)).toBeNull();
  });
});

describe("companionNameConflictError copy", () => {
  it("names the offending id", () => {
    expect(companionNameConflictError("logs")).toBe('"logs" is already used by another synced item — rename this folder or choose a different path.');
  });
});

describe("sortCompanionMemberNames", () => {
  it("dedupes and sorts", () => {
    expect(sortCompanionMemberNames(["b", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("companionConflict", () => {
  const defs = buildItemDefs(ENV);
  const appearance = defs.find((d) => d.id === "appearance") as ItemDef;
  const app = defs.find((d) => d.id === "app") as ItemDef;
  const hotkeys = defs.find((d) => d.id === "hotkeys") as ItemDef;
  const graph = defs.find((d) => d.section === "core" && d.id === "graph") as ItemDef;
  const dataview = defs.find((d) => d.section === "community" && d.id === "dataview") as ItemDef;

  it("returns null for a genuinely free path", () => {
    expect(companionConflict("attachments", defs, settings({}))).toBeNull();
  });

  it("rejects a path already an item's registry-default settings file", () => {
    expect(companionConflict("{configDir}/hotkeys.json", defs, settings({}))).toBe(hotkeys.label);
    expect(companionConflict("{configDir}/graph.json", defs, settings({}))).toBe(graph.label);
    expect(companionConflict("{configDir}/plugins/dataview/data.json", defs, settings({}))).toBe(dataview.label);
  });

  it("rejects a path already claimed via another item's CUSTOM settings-file path", () => {
    const cfg = itemsIn({ obsidian: { [hotkeys.id]: on({ path: "notes/hotkeys-custom.json" }) } });
    expect(companionConflict("notes/hotkeys-custom.json", defs, { items: cfg })).toBe(hotkeys.label);
    // the vacated registry default is free again once a custom path is set
    expect(companionConflict("{configDir}/hotkeys.json", defs, { items: cfg })).toBeNull();
  });

  it("rejects a path already one of an item's PRESET companions (themes/, snippets/), toggled or not", () => {
    expect(companionConflict("{configDir}/themes", defs, settings({}))).toBe(appearance.label);
    expect(companionConflict("{configDir}/snippets", defs, settings({}))).toBe(appearance.label);
  });

  it("rejects a path already a USER-added companion of some item", () => {
    const cfg = itemsIn({ obsidian: { [app.id]: on({ companions: [{ path: "notes/extra", device: "all", enabled: true }] }) } });
    expect(companionConflict("notes/extra", defs, { items: cfg })).toBe(app.label);
  });

  it("rejects the app.json path via the app card's own settings file, regardless of {configDir} form", () => {
    expect(companionConflict("{configDir}/app.json", defs, settings({}))).toBe(app.label);
  });

  it("self-card dedupe: adding a companion path the SAME item already owns (preset or user) is still a conflict", () => {
    // themes/ is appearance's own preset — re-"adding" it collides with itself, not some other item
    expect(companionConflict("{configDir}/themes", defs, settings({}))).toBe(appearance.label);
    const cfg = itemsIn({ obsidian: { [appearance.id]: on({ companions: [{ path: "notes/mine", device: "all", enabled: true }] }) } });
    expect(companionConflict("notes/mine", defs, { items: cfg })).toBe(appearance.label);
  });

  it("a path claimed via a companion is still reported even when a DIFFERENT item's own default would also match it — some real offending label, never null", () => {
    // app's own companion happens to sit on hotkeys.json's default spelling: the path really
    // is double-claimed (app's companion AND hotkeys' default settings file), so any
    // non-null, correctly-labelled answer is right — this pins that companionConflict does not
    // silently miss the collision just because two different carriers both claim it.
    const cfg = itemsIn({ obsidian: { [app.id]: on({ companions: [{ path: "{configDir}/hotkeys.json", device: "all", enabled: true }] }) } });
    const result = companionConflict("{configDir}/hotkeys.json", defs, { items: cfg });
    expect([app.label, hotkeys.label]).toContain(result);
  });

  it("case-insensitive: '{configDir}/Themes' conflicts with the themes preset", () => {
    // On case-insensitive filesystems, uppercase variants should match lowercase presets.
    // The hardening detects when uppercase is used where lowercase exists.
    expect(companionConflict("{configDir}/Themes", defs, settings({}))).toBe(appearance.label);
  });

  it("case-insensitive with trailing slash: '{configDir}/THEMES/' conflicts with themes preset", () => {
    // Both case-insensitivity AND trailing-slash normalization work together.
    // The path is normalized to remove the trailing slash, then compared case-insensitively.
    expect(companionConflict("{configDir}/THEMES/", defs, settings({}))).toBe(appearance.label);
  });

  it("a genuinely different path still returns null", () => {
    // Ensure the fix doesn't break normal free-path detection.
    expect(companionConflict("totally/different/path", defs, settings({}))).toBeNull();
  });
});

describe("custom settings-file path changes the compiled group's path (D7) without touching the old store rel", () => {
  it("compileItems emits the new path only; the old default path is not claimed anymore", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const before = compileItems(defs, settings({ obsidian: { hotkeys: on() } }));
    const beforeGroup = before.find((g) => g.name === "hotkeys");
    expect(beforeGroup?.path).toBe("{configDir}/hotkeys.json");

    const after = compileItems(
      defs,
      settings({ obsidian: { hotkeys: on({ path: "notes/my-hotkeys.json" }) } })
    );
    const afterGroup = after.find((g) => g.name === "hotkeys");
    expect(afterGroup?.path).toBe("notes/my-hotkeys.json");
    expect(afterGroup?.path).not.toBe(beforeGroup?.path);

    // the OLD default path is no longer reserved by anything once the item points elsewhere —
    // some other item is free to claim it now (proves compileItems truly moved the carrier, not
    // duplicated it).
    const stillFree = compileItems(
      defs,
      settings({ obsidian: { hotkeys: on({ path: "notes/my-hotkeys.json" }) } })
    );
    expect(stillFree.filter((g) => g.path === "{configDir}/hotkeys.json")).toHaveLength(0);
  });

  it("leftover pickup: once compiledGroups reflect the new path, the old store rel shows up as leftover (leftover.ts, no migration)", () => {
    const defs = buildItemDefs(EMPTY_ENV);
    const oldRel = "store/configdir/hotkeys.json";
    const compiledBefore = compileItems(defs, settings({ obsidian: { hotkeys: on() } }));
    // Before the change, the old rel is attributed to the hotkeys group — not leftover.
    expect(leftoverStoreRels([oldRel], compiledBefore)).toEqual([]);

    const compiledAfter = compileItems(
      defs,
      settings({ obsidian: { hotkeys: on({ path: "notes/my-hotkeys.json" }) } })
    );
    // After the change, compiledGroups no longer contain any group at the old store path — the
    // existing leftover-detection flow (main.ts's listLeftoverStoreFiles, unioned with the store's
    // own self-copy group list) picks the old rel up on its own; no migration code needed.
    const leftovers = leftoverStoreRels([oldRel], compiledAfter);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.rel).toBe(oldRel);
  });
});
