/**
 * The v2 → v3 settings migration.
 *
 * This is the ONLY code in the plugin that will ever read a v2 `data.json` again, and the one
 * place a document is allowed to be rewritten — downward from v2, once, on the load that finds it
 * (see main.ts's loadSettings). Everything here is pure: the shell decides when to run it, saves
 * the result exactly once, and owns the localStorage half of the re-key.
 *
 * Two rules shape every function below.
 *
 * 1. **A v2 document is written by ANOTHER build**, so the v2 compile-time shapes are claims about
 *    it, not facts. Every level is therefore handled as a plain object of `unknown` values and
 *    rebuilt by SPREADING what was found — which is what carries a key this build has never heard
 *    of straight through the migration (including
 *    `customGroups` entries). A value whose shape we cannot read is left exactly as found
 *    rather than dropped or "fixed": this is a migration, not a validator, and the v3 validator
 *    (manifest.ts) refuses the same shapes v2's did, so a document that did not compile before does
 *    not start compiling now.
 * 2. **Preserve what the system DID, not what the menu SAID** — see `runsOnFrom`.
 *
 * The two v2 normalizers live here, because a v2 SHAPE is the only thing they ever
 * operated on: `mergeLegacyAppSliceItems` (the app-slice merge) and `drainEnabledOnLocal`
 * (`enabledOn: "local"` → this device's own list). In v2 both ran on EVERY load, because devices
 * still on an older build kept re-publishing the old form into the shared contract; there is no
 * such fleet any more (a v3 document is refused by every build that could write those shapes), so
 * they run exactly once, here.
 */
import { customItemFromGroup, Item } from "./registry";
import { isPlainObject } from "./sanitize";
import { EVERYWHERE, ItemId, ItemRef, itemRef, perClass, StorageSection, SyncGroup, THIS_DEVICE } from "./types";

// A document (or one level of one) as it comes off disk.
type Doc = Record<string, unknown>;

export interface V2Migration {
  // The v3 document: ready for withDefaults, and for exactly one save.
  document: Doc;
  // v2's CARRIED `deviceOptOuts` map (group name -> the device ids that opted it out), handed back
  // rather than dropped on the floor. v3 retires the field, but a device that jumps straight from
  // 2.20.0 to v3 has never run the build that copied its own entries into localStorage — dropping
  // the map without absorbing it first would silently start syncing items that device deliberately
  // opted out of. The shell absorbs it (main.ts's absorbCarriedDeviceOptOuts) before saving.
  carriedDeviceOptOuts: unknown;
}


// v2 encoded an item's family as a PREFIX on its id; v3 nests by section instead.
// One producer for that translation, used by all three v2 fields keyed by an item id — `items`,
// `memberRules` and `localMembers` — because a derived key needs exactly one producer:
// three copies of "does it start with community:?" is precisely the shape that drifts.
//
// `beta` is not among the answers, and cannot be: v2 gave a BRAT plugin the `community:` prefix
// like any other community plugin, and v3 keeps it stored there. An item that changed its
// storage key the day BRAT adopted it would be churn no benefit justifies.
const V2_SECTION_PREFIXES: readonly { prefix: string; section: StorageSection }[] = [
  { prefix: "core:", section: "core" },
  { prefix: "community:", section: "community" },
];

export function v2ItemLocation(v2Id: string): { section: StorageSection; id: ItemId } {
  for (const { prefix, section } of V2_SECTION_PREFIXES) {
    if (v2Id.startsWith(prefix)) return { section, id: v2Id.slice(prefix.length) };
  }
  // A bare id is one of the three Obsidian cards (app/appearance/hotkeys). Anything else bare —
  // e.g. the inert `core-plugins` key v2's carrier chip used to write, which no def claimed and
  // nothing compiled — lands there too: one rule, no special cases, and the user's document keeps
  // every key it arrived with. It no longer STAYS inert past this point, though: the v4 migration
  // (v4Migration.ts rule 6) now actively neutralizes a `synced` value found there for the two
  // carrier ids, because v3 never gave it meaning and a v4 build otherwise would.
  return { section: "obsidian", id: v2Id };
}

export function v2ItemRef(v2Id: string): ItemRef {
  const { section, id } = v2ItemLocation(v2Id);
  return itemRef(section, id);
}


// v2's flat `RuleScope` ("all" | "desktop" | "mobile" | "local") → v3's `Sharing` union. Used for
// field rules, file rules and per-element maps alike, so the three cannot disagree.
//
// An unrecognised value is returned VERBATIM rather than guessed at. v2's own validator
// (validateSyncManifest) rejected any scope outside RULE_SCOPES, so such a document already
// refused to compile and showed the user why; v3's validator rejects the same value in the same
// place, which is exactly the behaviour we are preserving. Inventing "everywhere" for it would
// instead make a broken document start syncing, silently, under a rule the user never wrote.
function sharingFrom(scope: unknown): unknown {
  if (scope === "all") return EVERYWHERE;
  if (scope === "desktop" || scope === "mobile") return perClass(scope);
  if (scope === "local") return THIS_DEVICE;
  return scope;
}

// `{scope, encrypted, locked?}` → `{sharing, encrypted, locked?}`, for a field rule (where the
// key-name pattern is the map key or the rule's own `pattern`) and for a Plain-mode file rule.
// `fileRule.scope: "local"` maps like any other and stays unrepresentable: `asFileSharing` refuses
// it, exactly as v2's FILE_RULE_SCOPES refused "local" there.
function ruleFrom(rule: unknown): unknown {
  if (!isPlainObject(rule)) return rule;
  const out: Doc = { ...rule };
  if ("scope" in out) {
    out.sharing = sharingFrom(out.scope);
    delete out.scope;
  }
  return out;
}

// `perItem` → `perElement`: key name -> element value -> sharing.
function perElementFrom(perItem: unknown): unknown {
  if (!isPlainObject(perItem)) return perItem;
  const out: Doc = {};
  for (const [key, elements] of Object.entries(perItem)) {
    if (!isPlainObject(elements)) {
      out[key] = elements;
      continue;
    }
    const mapped: Doc = {};
    for (const [element, scope] of Object.entries(elements)) mapped[element] = sharingFrom(scope);
    out[key] = mapped;
  }
  return out;
}

// `companions[].scope` → `companions[].device`. Same value space (a DeviceClass), same
// meaning; only the word changed, because `scope` meant three different things in v2.
function companionFrom(companion: unknown): unknown {
  if (!isPlainObject(companion)) return companion;
  const out: Doc = { ...companion };
  if ("scope" in out) {
    out.device = out.scope;
    delete out.scope;
  }
  return out;
}

function deviceFrom(v: unknown): "all" | "desktop" | "mobile" | undefined {
  return v === "all" || v === "desktop" || v === "mobile" ? v : undefined;
}

/**
 * v2's `enabledOn` + `memberRules[id]` → one `runsOn`.
 *
 * THE RULING THIS ENCODES: preserve what the system DID, not what the menu SAID. In v2 the
 * Runs-on menu's device choice ("Computers only"/"Phones only") lived in `memberRules` and was
 * read by NOTHING but the menu — the capture/apply mask followed `enabledOn`, which only the
 * settings card wrote. So when the two disagreed, `enabledOn` was the truth about this device's
 * behaviour and `memberRules` was a label. The device axis therefore takes `enabledOn` first, the
 * class value from `memberRules` second, and `all` when neither says anything: a document where
 * the two disagreed keeps its effective masking, and the menu starts telling the truth about it.
 *
 * The force axis is orthogonal and comes only from `memberRules`. `where: "everywhere"` for both
 * values is deliberate and behaviour-preserving: v2's "here" rules are
 * fleet-wide in effect whatever the copy says, and whether they SHOULD be is a product question
 * the migration explicitly does not answer — the new field just makes the answer cheap to change.
 *
 * `enabledOn: "local"` never reaches here: `drainEnabledOnLocal` has already moved it to this
 * device's own list, which is where v2 read it from too. A value neither axis recognises is
 * DROPPED, not ignored-and-kept: v2 ignored it at the point of use and left it on disk,
 * but both fields it could live in retire with v2, so there is nowhere left to keep it. It
 * did nothing in v2 either, so nothing observable goes with it — see the same note at the orphan
 * pass in migrateV2Settings, which is the other place this decision shows.
 *
 * Returns undefined for a rule that says nothing at all, so the key is simply absent — the same
 * never-write-a-no-op-value discipline this codebase applies throughout.
 */
export function runsOnFrom(enabledOn: unknown, memberRule: unknown): Doc | undefined {
  const device = deviceFrom(enabledOn) ?? deviceFrom(memberRule) ?? "all";
  const force =
    memberRule === "always-here"
      ? { state: "on", where: "everywhere" }
      : memberRule === "never-here"
        ? { state: "off", where: "everywhere" }
        : undefined;
  if (device === "all" && force === undefined) return undefined;
  return force === undefined ? { device } : { device, force };
}


// v2 shape revision: the three app.json slice
// cards (editor/files-links/other) plus a top-level `appJson` mode merge into a single "app" item.
// Appearance's only-ever borrowed app.json key was showInlineTitle; that snapshot is hardcoded
// here rather than derived — it is a frozen fact about v2.
// Same-pattern rules/perItem entries are first-seen-wins, in encounter order
// editor → files-links → other → appearance.
//
// Mutates the flat v2 item map in place, exactly as the v2 original did — this runs on a private
// copy the migration owns, never on the caller's document.
const LEGACY_APP_SLICE_IDS = ["editor", "files-links", "other"] as const;
const APPEARANCE_BORROWED_KEYS = ["showInlineTitle"] as const;

export function mergeLegacyAppSliceItems(items: Doc, appJson: unknown): boolean {
  const legacy = LEGACY_APP_SLICE_IDS.filter((id) => items[id] !== undefined);
  if (legacy.length === 0 && appJson === undefined) return false;

  const rules: Doc = {};
  const perItem: Doc = {};
  let enabled = false;
  for (const id of LEGACY_APP_SLICE_IDS) {
    const cfg = items[id];
    if (cfg === undefined) continue;
    if (isPlainObject(cfg)) {
      enabled = enabled || cfg.enabled === true;
      const sf = cfg.settingsFile;
      if (isPlainObject(sf)) {
        if (isPlainObject(sf.rules)) for (const [k, r] of Object.entries(sf.rules)) if (!(k in rules)) rules[k] = r;
        if (isPlainObject(sf.perItem)) for (const [k, p] of Object.entries(sf.perItem)) if (!(k in perItem)) perItem[k] = p;
      }
    }
    delete items[id];
  }
  const appearance = items["appearance"];
  const appearanceSf = isPlainObject(appearance) ? appearance.settingsFile : undefined;
  for (const key of APPEARANCE_BORROWED_KEYS) {
    if (!isPlainObject(appearanceSf)) continue;
    const borrowed = isPlainObject(appearanceSf.rules) ? appearanceSf.rules[key] : undefined;
    if (borrowed !== undefined && !(key in rules)) rules[key] = borrowed;
    if (isPlainObject(appearanceSf.rules)) delete appearanceSf.rules[key];
    if (isPlainObject(appearanceSf.perItem)) delete appearanceSf.perItem[key];
  }
  // No `companions: []`. v2 still wrote it so a device on an older build could read the entry;
  // v3 stops writing it because no build that reads
  // `companions` unguarded can read a v3 document at all — the version gate refuses it.
  // `appJson?.mode ?? "fields"` — verbatim, including a value this build does not recognise. v2
  // carried whatever was stored there and let the compile path decide (only "fields" was ever
  // special-cased); coercing it here would break this module's own rule 1 in the one function
  // whose job is to reproduce v2 exactly.
  const appJsonMode = isPlainObject(appJson) ? appJson.mode : undefined;
  items["app"] = {
    enabled,
    settingsFile: { mode: appJsonMode ?? "fields", rules, perItem },
  };
  return true;
}

// In late v2, "this device"
// stopped living in `ItemConfig.enabledOn` and moved to the settings-level list, so a stored
// `enabledOn: "local"` is a pre-retarget artifact v2 already ignored where it was read. Drains
// every such id into that list and deletes the dead key. Mutates both, in place, like the v2
// original; the ids stay in v2 form here and are re-keyed to ItemRefs once, by the caller.
export function drainEnabledOnLocal(items: Doc, thisDeviceIds: string[]): boolean {
  let changed = false;
  for (const [id, cfg] of Object.entries(items)) {
    if (!isPlainObject(cfg) || cfg.enabledOn !== "local") continue;
    if (!thisDeviceIds.includes(id)) thisDeviceIds.push(id);
    delete cfg.enabledOn;
    changed = true;
  }
  return changed;
}

// The carried device opt-out map: dropped from the document without losing the choice itself.

// This device's group names inside v2's carried map. Anything that isn't the old shape (a hand
// edit, a future build's replacement) contributes nothing and is left alone.
// The field is gone from v3, but a document being
// migrated is by definition still carrying it.
export function deviceOptOutsFor(map: unknown, deviceId: string): string[] {
  if (!isPlainObject(map)) return [];
  return Object.entries(map)
    .filter(([, ids]) => Array.isArray(ids) && ids.includes(deviceId))
    .map(([name]) => name);
}


// One item's v2 `ItemConfig` → v3 `Item`. `memberRule` is this item's entry in the top-level
// `memberRules` side table, which v3 does not have: a rule lives on the thing it governs.
function itemFrom(cfg: unknown, memberRule: unknown): unknown {
  if (!isPlainObject(cfg)) return cfg; // left exactly as found — see this module's rule 1
  const item: Doc = { ...cfg };

  // v2's `enabled` is v3's `synced` — same
  // field, renamed key, so this is a KEY rename, not a value change (mirrors `customPath` → `path`
  // below).
  if ("enabled" in item) {
    item.synced = item.enabled;
    delete item.enabled;
  }

  const enabledOn = item.enabledOn;
  delete item.enabledOn;
  const runsOn = runsOnFrom(enabledOn, memberRule);
  if (runsOn !== undefined) item.runsOn = runsOn;

  if (isPlainObject(item.settingsFile)) {
    const sf: Doc = { ...item.settingsFile };
    // `settingsFile.customPath` → the item's own `path`: a path is a property of the
    // item, not of the rules that read its file. Carried whenever the key was present, including
    // an empty string — v2's `customPath ?? defaultPath` only fell back on an absent value, and so
    // does v3's `item.path ?? defaultPath`.
    if ("customPath" in sf) {
      item.path = sf.customPath;
      delete sf.customPath;
    }
    if (isPlainObject(sf.fileRule)) sf.fileRule = ruleFrom(sf.fileRule);
    if (isPlainObject(sf.rules)) {
      const rules: Doc = {};
      for (const [pattern, rule] of Object.entries(sf.rules)) rules[pattern] = ruleFrom(rule);
      sf.rules = rules;
    }
    if ("perItem" in sf) {
      sf.perElement = perElementFrom(sf.perItem);
      delete sf.perItem;
    }
    // Both maps are required by the v3 shape, and `deriveMode` reads their key counts without a
    // guard. v2's own type and its own deriveMode said exactly the same, so a settingsFile missing
    // one of them is a hand edit that already crashed v2 — but this function BUILDS the v3 shape,
    // and building it incomplete is a different failure from carrying an unreadable value. An
    // absent key holds nothing, so filling it can lose nothing.
    if (!("rules" in sf)) sf.rules = {};
    if (!("perElement" in sf)) sf.perElement = {};
    item.settingsFile = sf;
  }

  if (Array.isArray(item.companions)) {
    // An empty list is dropped rather than rewritten: `companions: []` is what v2 wrote on every
    // entry for an older build's benefit and every read has always been `?? []`, so
    // removing it here is provably behaviour-neutral and stops the migrated document from carrying
    // ~100 keys v3 would never write. A non-empty list is real configuration and is only remapped.
    if (item.companions.length === 0) delete item.companions;
    else item.companions = item.companions.map(companionFrom);
  }

  return item;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// A private copy of a JSON sub-tree, all the way down. Applied to the two structures the migration
// REWRITES — the item map and each custom entry — because the two restored normalizers mutate what
// they are given (that is how v2 wrote them, and reproducing v2 exactly is the point) and because
// nothing under `items` should stay shared with the caller's document afterwards.
//
// It is NOT applied to the whole document: the top level is a shallow `{ ...data }`, so a value the
// migration only RENAMES or carries — `remotes`, `runHistory`, `bratIndex` — is still the caller's
// own object. That is deliberate rather than an oversight; those values are never written through
// here, and a whole-document deep copy would also break the identity return that makes a non-v2
// document provably untouched.
// Total: anything that is not an array or a plain object is a leaf and comes back as itself.
function ownCopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ownCopy);
  if (!isPlainObject(v)) return v;
  const out: Doc = {};
  for (const [k, x] of Object.entries(v)) out[k] = ownCopy(x);
  return out;
}

// v2's `customGroups: SyncGroup[]` → entries of `items.custom`. The v2 literal is first
// brought up to the v3 SyncGroup vocabulary (`dir` → `folder`, `scope` → `sharing`, `perItem` →
// `perElement`), then handed to registry.ts's `customItemFromGroup` — the SAME group → item
// producer the Advanced tab persists through, so a migrated custom rule and a re-edited one can
// never end up shaped differently. Its carried-tail handling is what guarantees
// that a v2 custom entry keeps its unknown fields.
function customItemsFrom(customGroups: unknown): [string, Item][] {
  if (!Array.isArray(customGroups)) return [];
  const out: [string, Item][] = [];
  for (const raw of customGroups) {
    // A entry with no usable name is one v2's own validator rejected (GROUP_NAME_RE), so the
    // document it came from never compiled; there is no name to key it under here either.
    if (!isPlainObject(raw) || typeof raw.name !== "string") continue;
    const g: Doc = ownCopy(raw) as Doc; // same ownership rule as the item map — see ownCopy
    if (g.type === "dir") g.type = "folder";
    if (Array.isArray(g.fields)) g.fields = g.fields.map(ruleFrom);
    if (isPlainObject(g.fileRule)) g.fileRule = ruleFrom(g.fileRule);
    if ("perItem" in g) {
      g.perElement = perElementFrom(g.perItem);
      delete g.perItem;
    }
    // The name becomes the map key and stops being a field inside the entry — one source of truth
    // for a custom item's identity, the same way the key pattern is for a field rule.
    out.push([raw.name, customItemFromGroup(g as unknown as SyncGroup)]);
  }
  return out;
}

/**
 * A v2 `data.json` → a v3 one.
 *
 * Total and pure: the input is never mutated, and no input shape can make it throw — the load path
 * has to be able to order its writes for safety rather than around exceptions. Idempotent by the
 * only route that matters: a document that is not a v2 document comes back untouched, so a second
 * run over the result is a no-op and a v3 document never enters at all.
 */
export function migrateV2Settings(data: Doc): V2Migration {
  if (data.schemaVersion !== 2) return { document: data, carriedDeviceOptOuts: undefined };

  const doc: Doc = { ...data };
  const carriedDeviceOptOuts = doc.deviceOptOuts;

  // v2's flat item map, DEEPLY privately owned from here on. The two normalizers below mutate what
  // they are given, and `mergeLegacyAppSliceItems` reaches two levels down — it deletes the
  // borrowed `showInlineTitle` out of `appearance.settingsFile.rules` — so a shallow copy of the
  // map and of each item would still leave the caller's document being edited.
  // A non-object `items` is not data — v2 could not read it either — and is replaced rather than
  // carried, because the v3 sections have to exist for anything else to land in them.
  const v2Items: Doc = isPlainObject(doc.items) ? (ownCopy(doc.items) as Doc) : {};
  const memberRules: Doc = isPlainObject(doc.memberRules) ? doc.memberRules : {};
  const thisDeviceIds = stringList(doc.localMembers);
  // Snapshot BEFORE the merge, which deletes the three slice ids: the orphan pass below asks "did
  // this id have an item of its own?", and after the merge `editor` no longer looks like it did.
  // Without this a stray memberRule for a retired slice id resurrects a junk `items.obsidian.editor`
  // entry that is inert but written to disk forever.
  const hadItem = new Set(Object.keys(v2Items));

  mergeLegacyAppSliceItems(v2Items, doc.appJson);
  drainEnabledOnLocal(v2Items, thisDeviceIds);

  const items: Record<StorageSection, Doc> = { obsidian: {}, core: {}, community: {}, custom: {} };
  for (const [v2Id, cfg] of Object.entries(v2Items)) {
    const { section, id } = v2ItemLocation(v2Id);
    items[section][id] = itemFrom(cfg, memberRules[v2Id]);
  }
  // A `memberRules` entry whose item has no `items` entry of its own. v2 read that side table
  // INDEPENDENTLY of `items` (memberRulesFor walked the map, not the item list), so such a rule was
  // live — an "always here"/"never here" really did force the switch. v3 has no side table, so the
  // rule either lands on an item or is lost; it lands, on an item that is off, which is what the
  // absent entry already meant.
  for (const [v2Id, rule] of Object.entries(memberRules)) {
    if (hadItem.has(v2Id) || v2Id in v2Items) continue;
    const runsOn = runsOnFrom(undefined, rule);
    // A value neither axis recognises is DROPPED here, deliberately. That is not parity with v2 —
    // v2 ignored it at the point of use and left it on disk (invariant II.2) — but `memberRules`
    // itself is retiring, so v3 has nowhere to keep it, and the migration is the one place allowed
    // to rewrite. It did nothing in v2 either, so nothing observable is lost with it; the same
    // applies to an unrecognised `enabledOn` in runsOnFrom.
    if (runsOn === undefined) continue;
    const { section, id } = v2ItemLocation(v2Id);
    items[section][id] = { synced: false, runsOn };
  }
  for (const [name, item] of customItemsFrom(doc.customGroups)) items.custom[name] = item;

  doc.items = items;
  // `localMembers` → `thisDeviceItems`, re-keyed to ItemRefs through the same producer the item map
  // used. Deduped the way every writer of this list already dedupes it (setLocalMember).
  //
  // SEEDED from an existing `thisDeviceItems`, never overwriting it (fix round 2, review NEW-I2).
  // A pure v2 document has no such field, so this is a plain rename there. The document that DOES
  // have both is the hybrid the transition window creates: adopting a store contract still written
  // by a 2.21.0 device applies the STORE's document as the base — `schemaVersion: 2` and all —
  // while preserving this device's locked-local presets, and `thisDeviceItems` is the only one of
  // the three whose NAME changed (catalog.ts's selfPresetRules locks rootPath/remotes/
  // thisDeviceItems; the store's v2 copy locks `localMembers`, so the value arriving in that field
  // is empty). Overwriting from a drained-empty `localMembers` silently emptied this device's own
  // device-local list and saved it.
  doc.thisDeviceItems = [...new Set([...stringList(doc.thisDeviceItems), ...thisDeviceIds.map(v2ItemRef)])];
  if ("bratPluginIndex" in doc) {
    doc.bratIndex = doc.bratPluginIndex;
    delete doc.bratPluginIndex;
  }
  delete doc.appJson;
  delete doc.customGroups;
  delete doc.localMembers;
  delete doc.memberRules;
  // The carried opt-out map retires with the fleet it existed for. Returned to the caller
  // first — see V2Migration.carriedDeviceOptOuts.
  delete doc.deviceOptOuts;
  doc.schemaVersion = 3;

  return { document: doc, carriedDeviceOptOuts };
}
