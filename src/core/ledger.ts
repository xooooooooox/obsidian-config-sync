/**
 * Device-local sync baselines (spec 2026-07-27 direction-baseline).
 * Each entry records the canonical hash of a group's store and local content as of the last
 * moment THIS device saw the group in sync. Direction for a differing group is then a
 * three-way comparison against this baseline instead of an mtime guess.
 * Persistence lives in main.ts (app.saveLocalStorage — per-vault, per-device, invisible to
 * vault-wide file sync); this module is pure except for crypto.subtle.
 */
import { parseSwitchList, readLocalSwitchList, SWITCH_LIST_GROUPS, SwitchList } from "./switchList";

export interface BaselineEntry {
  store: string;
  local: string;
  at: string;
}

export interface Ledger {
  version: 1;
  groups: Record<string, BaselineEntry>;
}

/** null = drop the entry (group left the config or lost its settings). */
export type LedgerUpdates = Record<string, BaselineEntry | null>;

/** Hash sentinel for a side that has no content at all (file missing). */
export const ABSENT_HASH = "absent";

export function emptyLedger(): Ledger {
  return { version: 1, groups: {} };
}

function validEntry(v: unknown): v is BaselineEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.store === "string" && typeof e.local === "string" && typeof e.at === "string";
}

/** Accepts the raw localStorage value (JSON string or anything else); malformed → empty. */
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
  if (obj.version !== 1 || typeof obj.groups !== "object" || obj.groups === null) return emptyLedger();
  const groups: Record<string, BaselineEntry> = {};
  for (const [name, entry] of Object.entries(obj.groups as Record<string, unknown>)) {
    if (validEntry(entry)) groups[name] = entry;
  }
  return { version: 1, groups };
}

export function applyUpdates(ledger: Ledger, updates: LedgerUpdates): Ledger {
  const groups = { ...ledger.groups };
  for (const [name, entry] of Object.entries(updates)) {
    if (entry === null) delete groups[name];
    else groups[name] = entry;
  }
  return { version: 1, groups };
}

export function pruneLedger(ledger: Ledger, keep: ReadonlySet<string>): Ledger {
  const groups: Record<string, BaselineEntry> = {};
  for (const [name, entry] of Object.entries(ledger.groups)) {
    if (keep.has(name)) groups[name] = entry;
  }
  return { version: 1, groups };
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
  if (SWITCH_LIST_GROUPS.has(groupName)) {
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
