// Schema-catch-up gate (CLAUDE.md's schema-first rule): the files under schema/ are
// hand-maintained documentation of a persisted shape, not code the build type-checks against, so
// nothing else in this suite would catch them drifting from the producers they describe. No
// JSON-schema validator library is a devDependency (package.json) and none is added here — these
// are structural assertions against the parsed schema JSON and a couple of real-shaped fixtures,
// checked the same way the schema files themselves are checked: producer literal vs. producer
// literal (CURRENT_SCHEMA, STORE_LOCK_VERSION, the WRITTEN_* key lists), not a copy of either
// re-typed by hand.
import { Platform } from "obsidian";
import { beforeAll, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA } from "../src/core/settingsMigration";
import { STORE_LOCK_VERSION, WRITTEN_GROUP_KEYS, WRITTEN_LOCK_ENTRY_KEYS, WRITTEN_LOCK_KEYS } from "../src/core/manifest";
import { emptyItemMap, withItem, WRITTEN_ITEM_KEYS, type ItemMap } from "../src/core/registry";
import { perElementKeyFor } from "../src/core/switchList";
import { DEVICE_ELEMENTS_KEY } from "../src/core/deviceElements";
import { DEVICE_FIELDS_KEY } from "../src/core/deviceFields";
import { PASSPHRASE_SECRET_ID } from "../src/core/secrets";
import { EVERYWHERE, perClass, THIS_DEVICE } from "../src/core/types";

// obsidianmd/no-nodejs-modules: fs must be reached through a Platform.isDesktop-guarded dynamic
// import() — the same discipline tests/versionGates.test.ts's readSourceFile follows. vitest's cwd
// is the repo root, so a plain relative path reaches schema/ without needing node:path or __dirname.
async function readSchema(name: string): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  if (!Platform.isDesktop) throw new Error("schema-file assertions run on desktop only");
  const fs = await import("node:fs");
  const raw = fs.readFileSync(`schema/${name}`, "utf8");
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

// Every key that appears as an OBJECT KEY anywhere in a parsed JSON value — never a substring match
// against prose, so a description that mentions "scope" or "perItem" in running text (explaining
// what changed) cannot masquerade as, or hide, an actual property name.
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe("schema/*.schema.json parse as valid JSON", () => {
  it("data.schema.json", async () => expect(readSchema("data.schema.json")).resolves.toBeTruthy());
  it("config-sync.schema.json", async () => expect(readSchema("config-sync.schema.json")).resolves.toBeTruthy());
  it("store-lock.schema.json", async () => expect(readSchema("store-lock.schema.json")).resolves.toBeTruthy());
  it("local-storage.schema.json", async () => expect(readSchema("local-storage.schema.json")).resolves.toBeTruthy());
  it("run-history.schema.json", async () => expect(readSchema("run-history.schema.json")).resolves.toBeTruthy());
});

describe("data.schema.json", () => {
  let parsed: Record<string, unknown>;
  beforeAll(async () => {
    parsed = (await readSchema("data.schema.json")).parsed;
  });

  it("schemaVersion.const agrees with settingsMigration.ts's CURRENT_SCHEMA — producer vs. producer", () => {
    const props = parsed.properties as { schemaVersion: { const?: unknown } };
    expect(props.schemaVersion.const).toBe(CURRENT_SCHEMA);
  });

  it("declares draft-07 and every ConfigSyncSettings field as required at the top level", () => {
    expect(parsed.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(parsed.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "pkmMode",
        "rootPath",
        "remotes",
        "items",
        "ribbonButtons",
        "statusInMenu",
        "statusBarItem",
        "statusBarRemote",
        "ribbonDot",
        "mobileStatusBar",
        "remoteAutoCheck",
        "localPeriodicCheck",
        "runHistory",
      ])
    );
  });

  it("the itemMap definition requires all four storage sections and never a bare `beta` key", () => {
    const definitions = parsed.definitions as { itemMap: { required?: string[]; properties?: Record<string, unknown> } };
    expect(definitions.itemMap.required).toEqual(expect.arrayContaining(["obsidian", "core", "community", "custom"]));
    expect(Object.keys(definitions.itemMap.properties ?? {})).not.toContain("beta");
  });

  it("the item definition names exactly the fields this build writes — registry.ts's WRITTEN_ITEM_KEYS, producer vs. producer", () => {
    const definitions = parsed.definitions as { item: { properties?: Record<string, unknown> } };
    expect(Object.keys(definitions.item.properties ?? {}).sort()).toEqual([...WRITTEN_ITEM_KEYS].sort());
  });

  // A REAL fixture — built the same way the plugin itself would populate settings.items (registry.ts's
  // emptyItemMap/withItem, not a hand-typed object literal), exercising the shapes the schema
  // documents by name: a carrier's reserved perElement[""] key, a per-class sharing rule, a
  // this-device locked preset (the self item's rootPath/remotes strip), and a custom folder item.
  it("a realistically populated v4 items map satisfies the shape data.schema.json documents", () => {
    let items: ItemMap = emptyItemMap();
    items = withItem(items, "obsidian", "appearance", {
      synced: true,
      settingsFile: { mode: "fields", rules: {}, perElement: { enabledCssSnippets: { "my-snippet": THIS_DEVICE } } },
      companions: [{ path: "{configDir}/themes", device: "all", enabled: true }],
    });
    items = withItem(items, "obsidian", "core-plugins", {
      synced: true,
      settingsFile: { mode: "fields", rules: {}, perElement: { [perElementKeyFor("core-plugins")]: { graph: perClass("desktop") } } },
    });
    items = withItem(items, "core", "graph", { synced: true });
    items = withItem(items, "community", "config-sync", {
      synced: true,
      settingsFile: { mode: "fields", rules: { rootPath: { sharing: THIS_DEVICE, encrypted: false, locked: true } }, perElement: {} },
    });
    items = withItem(items, "community", "dataview", { synced: true, settingsFile: { mode: "plain", rules: {}, perElement: {} } });
    items = withItem(items, "custom", "notes-backup", { synced: true, type: "folder", path: "notes/backup" });

    const definitions = parsed.definitions as { itemMap: { required?: string[] } };
    for (const section of definitions.itemMap.required ?? []) {
      expect(items).toHaveProperty(section);
    }
    // Every entry, at every level, carries the one field Item.required names: `synced`.
    for (const bucket of Object.values(items)) {
      for (const item of Object.values(bucket)) {
        expect(item).toHaveProperty("synced");
        expect(typeof item.synced).toBe("boolean");
      }
    }
    // The reserved "" perElement key means "this whole file is the list" — it appears only on the
    // two carrier items, exactly as switchList.ts's perElementKeyFor and this schema's own
    // description of `settingsFile.perElement` say.
    expect(items.obsidian["core-plugins"]?.settingsFile?.perElement?.[""]).toEqual({ graph: perClass("desktop") });
    expect(EVERYWHERE.kind).toBe("everywhere"); // sanity: the sharing union's default kind this fixture leans on elsewhere
  });
});

describe("config-sync.schema.json (legacy manifest) matches manifest.ts's current vocabulary", () => {
  let raw: string;
  let parsed: Record<string, unknown>;
  beforeAll(async () => {
    ({ raw, parsed } = await readSchema("config-sync.schema.json"));
  });

  it("no longer names \"scope\" or \"perItem\" as a property anywhere in the schema", () => {
    const keys = collectKeys(parsed);
    expect(keys.has("scope")).toBe(false);
    expect(keys.has("perItem")).toBe(false);
  });

  it("speaks the current sharing/perElement vocabulary in its own prose too", () => {
    expect(raw).toContain("perElement");
    expect(raw).toContain("\"kind\"");
  });

  it("group.type accepts only \"file\"/\"folder\" — \"dir\" is not a legal value here", () => {
    const groupsSchema = parsed.properties as { groups: { items: { properties: { type: { enum?: string[] } } } } };
    expect(groupsSchema.groups.items.properties.type.enum).toEqual(["file", "folder"]);
  });

  it("the group shape names exactly the fields parseGroup writes — manifest.ts's WRITTEN_GROUP_KEYS, producer vs. producer", () => {
    const groupsSchema = parsed.properties as { groups: { items: { properties?: Record<string, unknown> } } };
    expect(Object.keys(groupsSchema.groups.items.properties ?? {}).sort()).toEqual([...WRITTEN_GROUP_KEYS].sort());
  });
});

describe("store-lock.schema.json", () => {
  let parsed: Record<string, unknown>;
  beforeAll(async () => {
    parsed = (await readSchema("store-lock.schema.json")).parsed;
  });

  it("has no `version` const to disagree with manifest.ts's STORE_LOCK_VERSION (it documents the field as free-form, matching parseStoreLock reading it off the carried tail) — assert the pair only if one is ever declared", () => {
    const props = parsed.properties as { version?: { const?: unknown } };
    if (props.version?.const !== undefined) {
      expect(props.version.const).toBe(STORE_LOCK_VERSION);
    } else {
      expect(STORE_LOCK_VERSION).toBeGreaterThan(0); // the schema declares no const — nothing to compare, but the producer constant itself must still exist
    }
  });

  it("every entry requires `source`, matching parseStoreLockEntry's own refusal", () => {
    const definitions = parsed.definitions as { entry: { required?: string[] } };
    expect(definitions.entry.required).toContain("source");
  });

  it("top-level and entry properties name exactly the fields this build writes — manifest.ts's WRITTEN_LOCK_* lists, producer vs. producer", () => {
    const props = parsed.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual([...WRITTEN_LOCK_KEYS].sort());
    const definitions = parsed.definitions as { entry: { properties?: Record<string, unknown> } };
    expect(Object.keys(definitions.entry.properties ?? {}).sort()).toEqual([...WRITTEN_LOCK_ENTRY_KEYS].sort());
  });
});

describe("local-storage.schema.json names the keys the code actually uses", () => {
  let parsed: Record<string, unknown>;
  beforeAll(async () => {
    parsed = (await readSchema("local-storage.schema.json")).parsed;
  });

  it("documents the device-elements table under its producer's key and the passphrase under the secret id — producer vs. producer", () => {
    const props = parsed.properties as Record<string, unknown>;
    expect(Object.keys(props)).toContain(DEVICE_ELEMENTS_KEY);
    expect(Object.keys(props)).toContain(DEVICE_FIELDS_KEY);
    expect(Object.keys(props)).toContain(PASSPHRASE_SECRET_ID);
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["config-sync-device-optouts", "config-sync-baselines", "config-sync-device-id", "config-sync-coldstart-dismissed"])
    );
  });

  it("the device-elements value space is exactly on/off", () => {
    const definitions = parsed.definitions as { deviceElements: { additionalProperties: { additionalProperties: { enum?: string[] } } } };
    expect(definitions.deviceElements.additionalProperties.additionalProperties.enum).toEqual(["on", "off"]);
  });
});

describe("run-history.schema.json matches runHistory.ts's record shape", () => {
  let parsed: Record<string, unknown>;
  beforeAll(async () => {
    parsed = (await readSchema("run-history.schema.json")).parsed;
  });

  it("the kind enum carries every RunKind including the removal actions", () => {
    const definitions = parsed.definitions as { runRecord: { properties: { kind: { enum?: string[] } } } };
    expect(definitions.runRecord.properties.kind.enum).toEqual(["capture", "apply", "pull", "push", "adopt", "stop-sync", "delete-leftover"]);
  });
});
