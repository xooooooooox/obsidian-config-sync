/**
 * Load-shape concerns for the v2 settings schema. Two distinct things live here:
 *
 * - The schema v2 blocking gate (spec 2026-07-25-unified-card-design.md §6, D13): the
 *   unified-card settings shape (`schemaVersion: 2`, `items`) has no migration path from any
 *   earlier shape — a v1 (or unversioned) data.json is never rewritten field-by-field; the plugin
 *   just starts fresh with defaults and asks the user to reconfigure. The old per-field
 *   migrations this module used to hold (switchExceptions → memberLocal, snippetScopes →
 *   memberScopes) are gone: schema v1 has no such fields at all, so there is nothing left to
 *   migrate from it.
 * - A v2-internal shape revision (spec 2026-07-26-ui-feedback-round2-design.md §2.3):
 *   `mergeLegacyAppSliceItems` below, which still runs on data.json that already passed the gate.
 */
import { ItemConfig, ItemFieldRule } from "./registry";
import { PerItemScopes } from "./types";

export const SCHEMA_UPGRADE_NOTICE = "Config Sync: settings schema changed — please reconfigure your sync items.";

// `null` (no data.json yet — a fresh install) is NOT legacy: there is nothing to reconfigure,
// just a brand-new default settings object.
export function isLegacySettings(data: Record<string, unknown> | null): boolean {
  if (data === null) return false;
  return data.schemaVersion !== 2;
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
    companions: [],
    settingsFile: { mode: settings.appJson?.mode ?? "fields", rules, perItem },
  };
  delete settings.appJson;
  return true;
}
