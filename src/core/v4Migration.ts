/**
 * The v3 → v4 settings migration.
 *
 * The ONE piece of code that will ever read a v3 `data.json` again. Pure: the shell decides when it
 * runs, saves the result exactly once, and owns the localStorage half (main.ts's
 * freezeThisDeviceElements).
 *
 * The rule that shapes it, inherited from v2Migration.ts: a document was written by ANOTHER build,
 * so its compile-time types are claims, not facts. Every level is a plain object of `unknown`,
 * rebuilt by spreading what was found — which is what carries a key this build has never heard of
 * (invariant II.1) — and a value whose shape we cannot read is left exactly as found.
 *
 * `thisDeviceItems` migrates in TWO halves and the second one is not optional. A v3 pin did not
 * merely mask its element, it FORCED it (resolved against the persisted
 * list). The rule below preserves WHO decides; the `freeze` list the shell consumes preserves WHAT
 * was decided. Only both together leave every switch where it was.
 *
 * The structural this-device rule: a v3 core/community entry whose card was off masked its element
 * whatever its `runsOn` claimed, so an entry that is not synced gets a stored `this-device` rule
 * saying exactly what its absence meant — ahead of, and instead of, any class rule its own
 * `runsOn` would otherwise have produced (without it, the first capture after a v4 load would
 * publish every locally-enabled plugin the user had never chosen to sync, to the whole fleet).
 * Structural rules do NOT join the freeze list; only pins do.
 */
import { ruleHomeFor } from "./enablementRules";
import { isPlainObject } from "./sanitize";
import { EnablementList } from "./switchList";
import { parseItemRef, perClass, Sharing, THIS_DEVICE } from "./types";

// A document (or one level of one) as it comes off disk.
type Doc = Record<string, unknown>;

export interface V4Migration {
  // The v4 document: ready for withDefaults, and for exactly one save.
  document: Doc;
  // The elements whose LOCAL half the shell must freeze: the ids that were pinned to this device in
  // v3, per list. The shell reads each list file and records the element's real current state.
  freeze: { list: EnablementList; elementId: string }[];
}

// A rule the migration decided on, collected during the item walk and applied afterwards. Collected
// rather than written in place because a rule lands on the CARRIER — an entry of `items.obsidian`,
// which the same walk is rebuilding — and a write into a level the loop has not reached yet would be
// overwritten by that level's own rebuild.
interface RuleWrite {
  list: EnablementList;
  elementId: string;
  sharing: Sharing;
}

export function migrateV4Settings(input: Doc): V4Migration {
  if (input.schemaVersion !== 3) return { document: input, freeze: [] };

  const doc: Doc = { ...input, schemaVersion: 4 };
  // A non-object `items` is not data — no build could read it — and is replaced rather than carried,
  // exactly as migrateV2Settings does, because the sections have to exist for anything else to land
  // in them.
  const items: Doc = isPlainObject(doc.items) ? { ...doc.items } : {};
  const rules: RuleWrite[] = [];
  const freeze: V4Migration["freeze"] = [];

  // Rules 2/3 — per item: `enabled` → `synced`, the device axis leaves, `force`/`elements` are
  // dropped, every other key rides through.
  for (const [section, byId] of Object.entries(items)) {
    // A section only a NEWER build understands. Carried verbatim (invariant II.1) and not walked:
    // there is nothing here that could read it, and rebuilding it would publish a guess.
    if (!isPlainObject(byId)) continue;
    const next: Doc = {};
    for (const [id, raw] of Object.entries(byId)) {
      if (!isPlainObject(raw)) {
        next[id] = raw; // left exactly as found — see this module's header
        continue;
      }
      const item: Doc = { ...raw };
      // A KEY rename, not a value change: the stored value rides through verbatim, the way
      // v2Migration's own rename does. What reads it is ONE predicate, spelled `synced === true`
      // (and its complement `!== true`) everywhere below — "synced" means the boolean this build
      // writes, and nothing else. v3's readers asked `!item.synced`, which agrees for every boolean
      // and disagrees for a hand-edited truthy non-boolean (`synced: 1`): that value reads as
      // UNSYNCED here, which is the safe direction — it masks the element instead of publishing it.
      if ("enabled" in item) {
        item.synced = item.enabled;
        delete item.enabled;
      } else if (!("synced" in item)) {
        // Establish the field even where v3 never wrote `enabled`: readers already treat a missing
        // value as unsynced, and the written document must satisfy its own schema (`synced` required).
        item.synced = false;
      }
      const device = deviceAxisOf(item.runsOn); // "desktop" | "mobile" | null; ignores force
      delete item.runsOn;
      delete item.elements; // declared in v3 (registry.ts), never written — nothing to carry
      if (section === "custom") {
        if (device !== null) setCustomDeviceSharing(item, device);
      } else if (section === "core" || section === "community") {
        const list = listFor(section);
        // ORDER MATTERS here, and it is v2Migration.ts's rule 2 again: preserve what the system DID,
        // not what the menu SAID. An unsynced entry was masked as this-device in v3 whatever its
        // `runsOn` claimed, so the structural rule is tested FIRST. Migrating such an entry as a
        // class rule instead is the one shape where this migration would move a switch: on the
        // other device class that rule masks AND forces off, and subtractForceOff would delete an
        // element v3's pass-through never touched; on its own class it would make the element start
        // following a list it has never participated in.
        if (item.synced !== true) rules.push({ list, elementId: id, sharing: THIS_DEVICE });
        else if (device !== null) rules.push({ list, elementId: id, sharing: perClass(device) });
      }
      next[id] = item;
    }
    items[section] = next;
  }

  // Rule 4 — the pins, both halves. A pin outranks whatever the item's own fields implied, exactly
  // as v3's memberDecisionsFor overlaid it on top of the derived sharing.
  const pinned = new Set<string>();
  for (const ref of stringList(doc.thisDeviceItems)) {
    const parsed = parseItemRef(ref);
    // A `custom`/`obsidian` pin never had a masking effect (only on/off-list elements do), and an
    // unparseable string never named anything. Dropped, not carried into a shape that would.
    if (parsed === null || (parsed.section !== "core" && parsed.section !== "community")) continue;
    if (pinned.has(ref)) continue; // the list is a set by every writer's own discipline
    pinned.add(ref);
    const list = listFor(parsed.section);
    rules.push({ list, elementId: parsed.id, sharing: THIS_DEVICE });
    freeze.push({ list, elementId: parsed.id });
  }
  delete doc.thisDeviceItems;

  // Rule 5 — BRAT repos onto the plugins they describe. A skeleton minted here gets NO structural
  // rule: it had no entry in v3, so it had nothing for a rule to preserve.
  for (const [id, repo] of Object.entries(stringMap(doc.bratIndex))) {
    const community: Doc = isPlainObject(items.community) ? { ...items.community } : {};
    const existing = isPlainObject(community[id]) ? (community[id] as Doc) : {};
    community[id] = { synced: false, ...existing, bratRepo: repo };
    items.community = community;
  }
  delete doc.bratIndex;

  for (const rule of rules) writeRule(items, rule);

  // Rule 6 — the carriers' own `synced`. Until v4 a carrier compiled iff any item in its section was
  // synced (v3's anyEnabledInList); from v4 it compiles iff its own item says so. Without
  // this line, every user's on/off sync would silently stop on the first v4 load.
  //
  // The section predicate ALWAYS wins here, for the two carrier ids ONLY — never "existing value
  // wins". No v3 build ever wrote a carrier entry to `items.obsidian`: v3's own compile decided a
  // carrier's sync by anyEnabledInList over the section, and never read
  // `items.obsidian["core-plugins"|"community-plugins"]` at all. So a `synced` value already sitting
  // there is not a value ANY v3 build chose — it is v2-chip residue: v2's old carrier chip wrote an
  // inert `items["core-plugins"] = {enabled:true}` (a bare id, which v2ItemLocation's fallback lands
  // in the `obsidian` section) that no v3 build ever gave behaviour to, and whose write was
  // documented dead (v2Migration.ts's v2ItemLocation). Honouring it here would silently turn on
  // fleet-wide list sync for every user who once clicked that dead chip. Same rule as v2Migration.ts's
  // rule 2: preserve what the system DID, not what a dead write once said. `=== true` is the same one
  // predicate the item walk above uses, complemented — the two must agree, or an entry could be
  // structural AND count towards its carrier syncing. Any OTHER field already on the carrier entry (a
  // key a newer build wrote) still rides through — `carrier` is a spread of the existing entry, and
  // only `synced` is overwritten below.
  for (const section of ["core", "community"] as const) {
    const home = ruleHomeFor(listFor(section));
    const obsidian: Doc = isPlainObject(items[home.section]) ? { ...(items[home.section] as Doc) } : {};
    const carrier: Doc = isPlainObject(obsidian[home.id]) ? { ...(obsidian[home.id] as Doc) } : {};
    const byId = isPlainObject(items[section]) ? (items[section] as Doc) : {};
    carrier.synced = Object.values(byId).some((i) => isPlainObject(i) && i.synced === true);
    obsidian[home.id] = carrier;
    items[home.section] = obsidian;
  }

  doc.items = items;
  return { document: doc, freeze };
}

// The rule write, through the SAME producer the runtime reads with (enablementRules.ts's
// ruleHomeFor) — never a "" literal and never a second spelling of where a rule lives.
function writeRule(items: Doc, { list, elementId, sharing }: RuleWrite): void {
  const home = ruleHomeFor(list);
  const section: Doc = isPlainObject(items[home.section]) ? { ...(items[home.section] as Doc) } : {};
  const carrier: Doc = isPlainObject(section[home.id]) ? { ...(section[home.id] as Doc) } : {};
  const sf: Doc = { mode: "plain", rules: {}, ...(isPlainObject(carrier.settingsFile) ? carrier.settingsFile : {}) };
  const perElement: Doc = { ...(isPlainObject(sf.perElement) ? sf.perElement : {}) };
  const forKey: Doc = { ...(isPlainObject(perElement[home.key]) ? (perElement[home.key] as Doc) : {}) };
  forKey[elementId] = sharing;
  perElement[home.key] = forKey;
  sf.perElement = perElement;
  carrier.settingsFile = sf;
  section[home.id] = carrier;
  items[home.section] = section;
}

// `device: "all"` writes NOTHING: the default is what an absent rule already means, and
// storing it would be residue the first round trip has to clean up. `force` is read and discarded —
// it claimed "here" and behaved "everywhere".
function deviceAxisOf(runsOn: unknown): "desktop" | "mobile" | null {
  if (!isPlainObject(runsOn)) return null;
  const device = runsOn.device;
  return device === "desktop" || device === "mobile" ? device : null;
}

// A CUSTOM item's device axis has a home of its own — the file rule its compiled group's `devices`
// already comes from (registry.ts's customGroup) — so the axis moves there rather than to a carrier
// no custom item has.
//
// Only when that home is EMPTY, though. A `runsOn` on a custom item was dead config in v3 (nothing
// but core/community elements ever reached the enablement derivation), while `fileRule.sharing` is
// live and decides the group's `devices` today; overwriting the live value with the dead one would
// be the migration changing what a rule does. `mode` is set for the same reason in the other
// direction: a file rule is Plain-mode only (manifest.ts refuses it beside "fields"/"encrypted"), so
// a non-plain item keeps its mode and drops the axis instead of being downgraded into validity.
function setCustomDeviceSharing(item: Doc, device: "desktop" | "mobile"): void {
  const sf: Doc = isPlainObject(item.settingsFile) ? { ...item.settingsFile } : { mode: "plain", rules: {}, perElement: {} };
  const mode = sf.mode ?? "plain";
  const existing = isPlainObject(sf.fileRule) ? sf.fileRule : undefined;
  if (mode !== "plain" || existing?.sharing !== undefined) return;
  sf.mode = "plain";
  sf.fileRule = { ...existing, sharing: perClass(device), encrypted: existing?.encrypted === true };
  item.settingsFile = sf;
}

function listFor(section: "core" | "community"): EnablementList {
  return section === "core" ? "core-plugins" : "community-plugins";
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// The readable half of a `bratIndex`: id -> "owner/repo". A value that is not text named no
// repository, and folding it onto a plugin would only move an unreadable value to a second home.
function stringMap(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [id, repo] of Object.entries(v)) if (typeof repo === "string") out[id] = repo;
  return out;
}
