/**
 * Load-shape concerns for the v2 settings schema. Three distinct things live here:
 *
 * - The default fill every load starts from (`withDefaults`, spec
 *   2026-08-11-data-model-hardening.md §5.1) — the stored document merged onto DEFAULT_SETTINGS,
 *   nested defaults included, unknown fields kept.
 * - The schema classifier (`classifySettings`) and the two version gates it feeds. Backwards
 *   (spec 2026-07-25-unified-card-design.md §6, D13): the unified-card settings shape
 *   (`schemaVersion: 2`, `items`) has no migration path from any earlier shape — a v1 (or
 *   unversioned) data.json is never rewritten field-by-field; the plugin just starts fresh with
 *   defaults and asks the user to reconfigure. The old per-field migrations this module used to
 *   hold (switchExceptions → memberLocal, snippetScopes → memberScopes) are gone: schema v1 has no
 *   such fields at all, so there is nothing left to migrate from it. Forwards (spec
 *   2026-08-11-data-model-hardening.md §4.1/§4.2, invariant II.3): a document from a NEWER build is
 *   refused, at load and again before an incoming one is written over the local file — never
 *   downgraded, never reset, never overwritten.
 * - A v2-internal shape revision (spec 2026-07-26-ui-feedback-round2-design.md §2.3):
 *   `mergeLegacyAppSliceItems` below, which still runs on data.json that already passed the gate.
 */
import { ItemConfig, ItemFieldRule } from "./registry";
import { PerItemScopes } from "./types";

// The settings schema THIS build reads and writes. Named once, here: the classifier below, the
// pre-write guard the apply path runs on an incoming document, and DEFAULT_SETTINGS' own
// schemaVersion all mean the same number, and a future bump must move exactly one literal.
export const CURRENT_SCHEMA = 2;

export const SCHEMA_UPGRADE_NOTICE = "Config Sync: this update reset your sync setup — open Settings to choose what to sync again.";

// §4.1 copy (spec 2026-08-11-data-model-hardening.md), shown wherever a write is refused while the
// stop state holds — the Sync Center's banner and every mutating entry point's notice.
export const SCHEMA_FUTURE_NOTICE =
  "These settings were written by a newer Config Sync. Update Config Sync on this device to open them. Nothing has been changed.";

// §4.2 copy: the run-result message the self item fails with when the document about to be applied
// onto this device declares a newer schema. Reported through the existing run-result path.
export const SCHEMA_FUTURE_APPLY_MESSAGE =
  "The store's Config Sync settings were written by a newer version. Update Config Sync on this device before applying them.";

// What a data.json turned out to be (spec 2026-08-11-data-model-hardening.md §4.1, invariant
// II.3). `fresh` = no data.json yet, which is NOT legacy: there is nothing to reconfigure, just a
// brand-new default settings object.
export type SettingsLoad =
  | { kind: "fresh" }
  | { kind: "ok" }
  | { kind: "legacy" }
  | { kind: "future"; found: number };

// The classifier that replaced `isLegacySettings` (schemaVersion !== 2). That test sent a document
// from a NEWER build down the legacy branch — notice, defaults in memory, and the user's whole
// setup overwritten at the next save — so a staged upgrade could wipe a not-yet-updated device
// through whole-document propagation. `future` is now its own answer and never resets anything.
// A schemaVersion that isn't a number (a hand edit, a truncated write) is not evidence of a newer
// build and keeps today's verdict exactly: legacy, reset, reconfigure.
export function classifySettings(data: Record<string, unknown> | null): SettingsLoad {
  if (data === null) return { kind: "fresh" };
  const found = data.schemaVersion;
  if (found === CURRENT_SCHEMA) return { kind: "ok" };
  if (typeof found === "number" && found > CURRENT_SCHEMA) return { kind: "future", found };
  return { kind: "legacy" };
}

// The pre-write half of the same gate (§4.2): does this settings DOCUMENT — a store copy about to
// be written onto this device — come from a newer build? Routed through classifySettings so the
// two gates cannot drift apart. Text that isn't a JSON object answers false: it is not evidence of
// a newer build, and the apply path's existing behaviour for unreadable store content stands.
export function isFutureSchemaDocument(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return classifySettings(parsed).kind === "future";
}

// The settings fields whose DEFAULT has fields of its own (spec 2026-08-11 §5.1). Everything else
// in DEFAULT_SETTINGS is either a scalar or a user-owned map/array whose default is empty — there
// is nothing a recursion could contribute to those, and merging into a user's map would resurrect
// entries they removed.
const NESTED_DEFAULT_KEYS = ["runHistory", "ribbonButtons"] as const;

// The load-time default fill (spec 2026-08-11-data-model-hardening.md §5.1). The shallow
// `Object.assign({}, DEFAULT_SETTINGS, data)` this replaces reached only the top level, so a field
// added INSIDE runHistory/ribbonButtons in a later version read back as `undefined` on any older
// document — including one adopted from a device still on that build (S8). Unknown keys, top-level
// and nested, are carried through untouched (invariant II.1): the stored value always wins, the
// default only fills what the document does not mention. A nested value that isn't an object at
// all is left exactly as stored, same as before — this is a default fill, not a validator.
export function withDefaults<T extends object>(defaults: T, data: Record<string, unknown> | null): T {
  const merged: Record<string, unknown> = { ...defaults, ...(data ?? {}) };
  for (const key of NESTED_DEFAULT_KEYS) {
    const base = (defaults as Record<string, unknown>)[key];
    if (!isPlainObject(base)) continue;
    const stored = merged[key];
    // A fresh object even when the document said nothing: these are edited IN PLACE by the
    // settings tab (`settings.runHistory.enabled = v`), and handing out DEFAULT_SETTINGS' own
    // object would let the next toggle rewrite the defaults for the rest of the session.
    merged[key] = isPlainObject(stored) ? { ...base, ...stored } : stored === base ? { ...base } : stored;
  }
  return merged as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── The carried `deviceOptOuts` map (spec 2026-08-11-data-model-hardening.md §2 ruling) ────────
// The pre-C-#52 fleet-shared shape: group name -> the device ids that opted that group out. This
// build reads its own opt-out from localStorage instead, but the FIELD stays in the document,
// because removing a field is two-phase (the same argument §5.2 makes for `companions`): a
// document written without it, adopted by a device still on 2.20.0, takes that device's own
// opt-out with it — C-#52's failure, inflicted by C-#52's fix. So the map is carried, other
// devices' entries are never touched, and this device's own entry is kept truthful.

// This device's groups inside a carried map — the migration's input. Anything that isn't the old
// shape (a hand edit, a future build's replacement) contributes nothing and is left alone.
export function deviceOptOutsFor(map: unknown, deviceId: string): string[] {
  if (!isPlainObject(map)) return [];
  return Object.entries(map)
    .filter(([, ids]) => Array.isArray(ids) && ids.includes(deviceId))
    .map(([name]) => name);
}

// This device's entry in a carried map, updated to match what localStorage now says. Pure: the
// input map and every array inside it are left untouched, and only THIS device's id is ever added
// or removed — another device's entry survives a round trip through us byte-for-byte, including
// one whose device id we have no evidence still exists. Removing the last id drops the group's
// key, the same prune discipline the pre-C-#52 writer had (C-#26).
//
// `unknown` in, `unknown` values out, narrowed here the way asMemberRule narrows a stored rule
// (§3.2): `Record<string, string[]>` is a compile-time claim about a runtime document written by
// builds we don't know. A group value that is NOT an array is left exactly as found — spreading a
// string would explode it into characters and `.filter` on a number would throw, and a throw here
// would land between the two stores this write updates. Total by construction: no input shape can
// make it fail, so the caller can order its writes for safety rather than around exceptions.
export function withDeviceOptOut(map: unknown, deviceId: string, groupName: string, on: boolean): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(map) ? { ...map } : {};
  const current = next[groupName];
  // Absent is the one non-array we may replace: there is nothing there to preserve.
  if (current !== undefined && !Array.isArray(current)) return next;
  const ids: unknown[] = current ?? [];
  if (on) {
    if (!ids.includes(deviceId)) next[groupName] = [...ids, deviceId];
    return next;
  }
  const remaining = ids.filter((id) => id !== deviceId);
  if (remaining.length > 0) next[groupName] = remaining;
  else delete next[groupName];
  return next;
}

// v2 shape revision (spec 2026-07-26-ui-feedback-round2-design.md §2.3): the three app.json
// slice cards (editor/files-links/other) plus the top-level `appJson` mode merge into a single
// "app" item (registry.ts's OBSIDIAN_CARD_DEFS). Appearance's only-ever borrowed app.json key was
// showInlineTitle; that snapshot is hardcoded here rather than derived, since the appTabFor
// lookup it used to come from is gone. Same-pattern rules/perItem entries are first-seen-wins,
// in encounter order editor → files-links → other → appearance.
const LEGACY_APP_SLICE_IDS = ["editor", "files-links", "other"] as const;
const APPEARANCE_BORROWED_KEYS = ["showInlineTitle"] as const;

export function mergeLegacyAppSliceItems(settings: {
  items: Record<string, ItemConfig>;
  appJson?: { mode: "plain" | "fields" };
}): boolean {
  const legacy = LEGACY_APP_SLICE_IDS.filter((id) => settings.items[id] !== undefined);
  if (legacy.length === 0 && settings.appJson === undefined) return false;

  const rules: Record<string, ItemFieldRule> = {};
  const perItem: Record<string, PerItemScopes> = {};
  let enabled = false;
  for (const id of LEGACY_APP_SLICE_IDS) {
    const cfg = settings.items[id];
    if (cfg === undefined) continue;
    enabled = enabled || cfg.enabled;
    for (const [k, r] of Object.entries(cfg.settingsFile?.rules ?? {})) if (!(k in rules)) rules[k] = r;
    for (const [k, p] of Object.entries(cfg.settingsFile?.perItem ?? {})) if (!(k in perItem)) perItem[k] = p;
    delete settings.items[id];
  }
  const appearance = settings.items["appearance"];
  for (const key of APPEARANCE_BORROWED_KEYS) {
    const r = appearance?.settingsFile?.rules[key];
    if (r !== undefined && !(key in rules)) rules[key] = r;
    if (appearance?.settingsFile !== undefined) {
      delete appearance.settingsFile.rules[key];
      delete appearance.settingsFile.perItem[key];
    }
  }
  settings.items["app"] = {
    enabled,
    // Still written even though the field is optional now: §5.2 is a two-phase change and this is
    // phase one — a document without the key makes an un-updated device throw where it reads
    // companions unguarded, so writing stops only once a tolerant build is the fleet's floor.
    companions: [],
    settingsFile: { mode: settings.appJson?.mode ?? "fields", rules, perItem },
  };
  delete settings.appJson;
  return true;
}

// Task-2 retarget (spec 2026-08-04-per-device-scope-local-containment-design.md): "this device"
// now lives in settings.localMembers, never in ItemConfig.enabledOn — a stored enabledOn:"local"
// is a pre-retarget artifact that enablementScopes already ignores. This drains every such id into
// localMembers and deletes the dead key, so the old form stops being re-published. Idempotent and
// runs on every load: during staggered rollout, other devices still on the old build keep pushing
// enabledOn:"local" back into the shared contract, so a one-shot migration wouldn't stay clean.
export function drainEnabledOnLocal(settings: { items: Record<string, ItemConfig>; localMembers: string[] }): boolean {
  const members = new Set(settings.localMembers);
  let changed = false;
  for (const [id, cfg] of Object.entries(settings.items)) {
    if (cfg.enabledOn !== "local") continue;
    members.add(id);
    delete cfg.enabledOn;
    changed = true;
  }
  if (changed) settings.localMembers = [...members];
  return changed;
}

// memberRules has no sanitizer any more (spec 2026-08-11-data-model-hardening.md §3.2, invariant
// II.2). Dropping every value this build doesn't recognise — which is precisely what a newer build
// writes — and saving immediately made the load path destroy the future's data and publish the
// deletion to the fleet on the next capture. An unrecognised value is now ignored at the point of
// use (availability.ts's asMemberRule, read by main.ts's memberRuleFor/memberRulesFor) and storage
// is never rewritten for it.
