/**
 * Load-shape concerns for the v4 settings schema. Two distinct things live here:
 *
 * - The default fill every load starts from (`withDefaults`, spec
 *   2026-08-11-data-model-hardening.md §5.1) — the stored document merged onto DEFAULT_SETTINGS,
 *   nested defaults included, unknown fields kept.
 * - The schema classifier (`classifySettings`) and the three version gates it feeds. Backwards: a
 *   `schemaVersion: 2` or `3` document is MIGRATED (v2Migration.ts, then v4Migration.ts) — once, on
 *   the load that finds it, saved once, behaving afterwards exactly as it did before, with v2
 *   chaining through v3 in memory. A v1 or unversioned
 *   document keeps the legacy branch: the plugin starts fresh with defaults and asks the user to
 *   reconfigure, because schema v1 has no field a later shape could be reconstructed from.
 *   Forwards (spec 2026-08-11-data-model-hardening.md §4.1/§4.2, invariant II.3): a document from a
 *   NEWER build is refused, at load and again before an incoming one is written over the local file
 *   — never downgraded, never reset, never overwritten. That gate is precisely what makes this
 *   breaking change survivable.
 */

// The settings schema THIS build reads and writes. Named once, here: the classifier below, the
// pre-write guard the apply path runs on an incoming document, and DEFAULT_SETTINGS' own
// schemaVersion all mean the same number, and a future bump must move exactly one literal.
export const CURRENT_SCHEMA = 4;

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
  // A v2 or v3 document: migrated field by field (v2Migration.ts, then v4Migration.ts), saved once,
  // and never reset. `from` says which one, because a v2 document takes BOTH steps and a v3 one only
  // the second. v1 and unversioned documents keep the legacy branch below, because schema v1 has no
  // field a later shape could be reconstructed from.
  | { kind: "migrate"; from: number }
  | { kind: "legacy" }
  | { kind: "future"; found: number };

// The versions this build can bring forward, oldest first (spec §4). v2 chains through v3 on its way
// here — migrateV2Settings produces a v3 document, which migrateV4Settings then takes the rest of
// the way, so a 2.20.0 device that skipped every release in between still lands on v4 in one load.
// Named next to CURRENT_SCHEMA so the pair reads as the range this build accepts.
export const MIGRATABLE_SCHEMAS: readonly number[] = [2, 3];

// The classifier that replaced `isLegacySettings` (schemaVersion !== CURRENT). That test sent a document
// from a NEWER build down the legacy branch — notice, defaults in memory, and the user's whole
// setup overwritten at the next save — so a staged upgrade could wipe a not-yet-updated device
// through whole-document propagation. `future` is now its own answer and never resets anything.
// A schemaVersion that isn't a number (a hand edit, a truncated write) is not evidence of a newer
// build and keeps today's verdict exactly: legacy, reset, reconfigure.
export function classifySettings(data: Record<string, unknown> | null): SettingsLoad {
  if (data === null) return { kind: "fresh" };
  const found = data.schemaVersion;
  if (found === CURRENT_SCHEMA) return { kind: "ok" };
  if (typeof found === "number" && MIGRATABLE_SCHEMAS.includes(found)) return { kind: "migrate", from: found };
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
//
// `items` belongs here for BOTH reasons the list exists: a document that never had a section (a
// hand edit, or a build that wrote fewer of them) must come back with it, and the map must never
// be handed out as DEFAULT_SETTINGS' own object — every section of it is written through
// registry.ts's withItem/withoutItem, and a shared mutable default is a bug waiting for its first
// in-place write. Its second level is empty by construction, so the one-level fill below is the
// whole of it; a section a NEWER build added rides through in the spread like any unknown key.
const NESTED_DEFAULT_KEYS = ["runHistory", "ribbonButtons", "items"] as const;

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
    // object would let the next toggle rewrite the defaults for the rest of the session. The
    // default's OWN nested objects are cloned too (`items`' four section maps), so no level of a
    // default is ever shared with the live settings object.
    const fresh: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(fresh)) if (isPlainObject(v)) fresh[k] = { ...v };
    // `stored === base` FIRST: with no document at all, `merged[key]` still IS the default object,
    // and spreading it back over the clone would hand the original's nested maps straight out again.
    merged[key] = stored === base ? fresh : isPlainObject(stored) ? { ...fresh, ...stored } : stored;
  }
  return merged as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Retired in v3 (spec 2026-08-11-v3-one-vocabulary-design.md §2/§5) ─────────────────────────
//
// `withDeviceOptOut` is gone with the carried `deviceOptOuts` map itself (C-#54 phase 2): this
// device's opt-out list has lived in localStorage since 2.21.0, and the field only stayed in the
// document so a device still on the old build would not lose its own entry when it adopted ours.
// v3 documents are refused outright by every build that reads that field, so the carry has nothing
// left to protect — the gate replaces it. Its READ half (`deviceOptOutsFor`) moved to
// v2Migration.ts, which still meets documents carrying the map and absorbs this device's own
// entries into localStorage before the field disappears.
//
// `mergeLegacyAppSliceItems` and `drainEnabledOnLocal` moved to v2Migration.ts for the same
// structural reason: both operate on v2 SHAPES (a flat `items` map keyed by prefixed ids,
// `enabledOn`), which no longer exist in a document this build can read, so the v2 → v3 migration
// is the only code that will ever run them again.
//
// v2's `memberRules` had no sanitizer and its v3 successor (`Item.runsOn`) needed none either
// (spec 2026-08-11-data-model-hardening.md §3.2, invariant II.2). Dropping every value this build
// doesn't recognise — which is precisely what a newer build writes — and saving immediately made
// the load path destroy the future's data and publish the deletion to the fleet on the next
// capture. `runsOn` itself retired outright in 2026-08-12-enablement-two-layers (a rule now lives
// on the carrier, not the plugin); the discipline lives on for every field this build still
// doesn't recognise, ignored at the point of use (enablementRules.ts's asSharing is today's
// example) and never rewritten out from under it.
