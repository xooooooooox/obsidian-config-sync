/**
 * Device-local sync baselines.
 * Each entry records the canonical hash of an item's store and local content as of the last
 * moment THIS device saw the item in sync. Direction for a differing item is then a
 * three-way comparison against this baseline instead of an mtime guess.
 * Persistence lives in main.ts (app.saveLocalStorage — per-vault, per-device, invisible to
 * vault-wide file sync); this module is pure except for crypto.subtle.
 */
import { parseSwitchList, readLocalSwitchList, isSwitchListGroup, SwitchList } from "./switchList";
import { SyncGroup } from "./types";

export interface BaselineEntry {
  store: string;
  local: string;
  at: string;
}

// v1 keyed every baseline by the compiled group name; v2 keys them by the item's ref, the
// same key the store lock uses — one key space, moved in one change, or every baseline becomes
// unresolvable, which reads as never-synced, which defaults to APPLY.
export const LEDGER_VERSION = 2;

export interface Ledger {
  // The version AS READ, not a claim about the shape: `rekeyLedger` needs to know whether the keys
  // it is looking at have moved yet, and a load that finds v1 is the normal state exactly once.
  version: number;
  items: Record<string, BaselineEntry>;
}

/** null = drop the entry (the item left the config or lost its settings). */
export type LedgerUpdates = Record<string, BaselineEntry | null>;

/** Hash sentinel for a side that has no content at all (file missing). */
export const ABSENT_HASH = "absent";

export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, items: {} };
}

function validEntry(v: unknown): v is BaselineEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.store === "string" && typeof e.local === "string" && typeof e.at === "string";
}

/**
 * Accepts the raw localStorage value (JSON string or anything else); malformed → empty.
 *
 * Both versions are read: v1's `groups` (keyed by compiled group name) and v2's `items` (keyed by
 * item ref). A v1 ledger is answered with `version: 1` and its keys UNCHANGED — re-keying needs the
 * compiled sync list, which does not exist yet at parse time, so it is `rekeyLedger`'s job and runs
 * once the compile has happened (main.ts). A version from the future reads as empty, exactly as an
 * unknown version always did here: this is a device-local scratch store, and the store it would
 * misread belongs to a build that will read it correctly again.
 */
export function parseLedger(raw: unknown): Ledger {
  if (typeof raw !== "string") return emptyLedger();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLedger();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyLedger();
  const obj = parsed as Record<string, unknown>;
  const version = obj.version === 1 ? 1 : obj.version === LEDGER_VERSION ? LEDGER_VERSION : null;
  if (version === null) return emptyLedger();
  const stored: unknown = version === 1 ? obj.groups : obj.items;
  if (typeof stored !== "object" || stored === null) return emptyLedger();
  const items: Record<string, BaselineEntry> = {};
  for (const [key, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (validEntry(entry)) items[key] = entry;
  }
  return { version, items };
}

/**
 * The v1 → v2 re-key, run once: every baseline moves from its group name to its item ref.
 *
 * NEVER DROPS. A missing baseline reads as never-synced, which defaults to APPLY — so
 * dropping one would offer to overwrite this device's live config with the store's. An entry whose
 * name nothing on this device claims keeps its content under itemKeys.ts's `legacy/` section, where
 * no reader can resolve it: inert, but preserved and self-describing. Whether such an entry should
 * still exist is `pruneLedger`'s question, not the migration's — the prune knows what this device
 * currently syncs, and a migration that guessed would be guessing about the user's data with no
 * undo.
 *
 * `toRef` is the single producer (itemKeys.ts's lockRefFor), the same one that re-keys the lock:
 * two sites deriving this key for two purposes is precisely how drift happens.
 */
export function rekeyLedger(ledger: Ledger, toRef: (name: string) => string): Ledger {
  if (ledger.version === LEDGER_VERSION) return ledger;
  const items: Record<string, BaselineEntry> = {};
  for (const [name, entry] of Object.entries(ledger.items)) items[toRef(name)] = entry;
  return { version: LEDGER_VERSION, items };
}

export function applyUpdates(ledger: Ledger, updates: LedgerUpdates): Ledger {
  const items = { ...ledger.items };
  for (const [ref, entry] of Object.entries(updates)) {
    if (entry === null) delete items[ref];
    else items[ref] = entry;
  }
  return { version: ledger.version, items };
}

// The keep-set every prune is called with: the refs of the groups this device currently syncs. A
// group with no ref holds no baseline (see statusForGroups), so it contributes nothing here — and
// an entry under a ref nothing compiles, including a `legacy/` one the re-key preserved, is what
// this prune exists to clear: the re-key never deletes, and the prune answers the question it
// cannot ("is this still synced HERE?").
export function baselineRefs(groups: readonly SyncGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => (g.ref === undefined ? [] : [g.ref as string])));
}

export function pruneLedger(ledger: Ledger, keep: ReadonlySet<string>): Ledger {
  const items: Record<string, BaselineEntry> = {};
  for (const [ref, entry] of Object.entries(ledger.items)) {
    if (keep.has(ref)) items[ref] = entry;
  }
  return { version: ledger.version, items };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalSwitchList(list: SwitchList): string {
  if (Array.isArray(list)) return JSON.stringify([...list].sort());
  const sorted: Record<string, boolean> = {};
  for (const k of Object.keys(list).sort()) sorted[k] = list[k] ?? false;
  return JSON.stringify(sorted);
}

/**
 * Canonical hash of one side of a file group. Switch lists hash their SET form (enable-order
 * churn must not read as movement); everything else hashes raw bytes. `null` content = the
 * file does not exist on that side.
 */
export async function hashFileSide(groupName: string, content: string | null, side: "local" | "store"): Promise<string> {
  if (content === null) return ABSENT_HASH;
  if (isSwitchListGroup(groupName)) {
    const parsed = side === "local" ? readLocalSwitchList(groupName, content) : parseSwitchList(content);
    if (parsed !== null) return sha256Hex(canonicalSwitchList(parsed));
  }
  return sha256Hex(content);
}

/** Canonical hash of one side of a dir group: sorted `rel\n sha256(content)` manifest. */
export async function hashDirSide(files: { rel: string; content: string }[]): Promise<string> {
  const lines = await Promise.all(files.map(async (f) => `${f.rel}\n${await sha256Hex(f.content)}`));
  return sha256Hex([...lines].sort().join("\n"));
}
