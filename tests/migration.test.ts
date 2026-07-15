import { describe, expect, it } from "vitest";
import { migrateLegacyManifest } from "../src/core/manifest";
import { ManifestValidationError } from "../src/core/manifest";
import { SyncGroup } from "../src/core/types";
import { MemFS } from "./memfs";

const NOW = "2026-07-15T12:00:00.000Z";

describe("migrateLegacyManifest", () => {
  it("merges legacy groups into existing (existing wins by name), renames the file, migrated:true", async () => {
    const io = new MemFS();
    const legacyContent = JSON.stringify({
      version: 1,
      groups: [
        { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
        { name: "shared", path: "{configDir}/shared-legacy.json", type: "file", devices: "all" },
      ],
    });
    io.seed({ "cs/config-sync.json": legacyContent });
    const existing: SyncGroup[] = [
      { name: "shared", path: "{configDir}/shared-existing.json", type: "file", devices: "all" },
    ];

    const result = await migrateLegacyManifest(io, "cs", existing, NOW);

    expect(result.migrated).toBe(true);
    expect(result.groups).toEqual([
      { name: "shared", path: "{configDir}/shared-existing.json", type: "file", devices: "all" },
      { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
    ]);

    // original path gone
    expect(await io.exists("cs/config-sync.json")).toBe(false);
    // renamed file exists with original content
    expect(await io.exists("cs/config-sync.json.migrated-2026-07-15")).toBe(true);
    expect(await io.read("cs/config-sync.json.migrated-2026-07-15")).toBe(legacyContent);
  });

  it("passes through unchanged when no legacy file exists", async () => {
    const io = new MemFS();
    const existing: SyncGroup[] = [{ name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" }];

    const result = await migrateLegacyManifest(io, "cs", existing, NOW);

    expect(result).toEqual({ groups: existing, migrated: false });
  });

  it("throws ManifestValidationError on malformed legacy content and leaves the file untouched", async () => {
    const io = new MemFS();
    io.seed({ "cs/config-sync.json": "not json" });

    await expect(migrateLegacyManifest(io, "cs", [], NOW)).rejects.toThrow(ManifestValidationError);

    expect(await io.exists("cs/config-sync.json")).toBe(true);
    expect(await io.read("cs/config-sync.json")).toBe("not json");
  });
});
