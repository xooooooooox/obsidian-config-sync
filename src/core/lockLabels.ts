/**
 * The stored-name chain: what the store lock knows a group is called (C-#14, and
 * 2026-08-09-c-livetest-batch15's carrier fallback).
 *
 * Its own module because it sits at a junction: it needs manifest.ts's lock accessors AND catalog.ts
 * is where its caller's other half (displayLabelForGroup) lives — and catalog.ts is below manifest.ts
 * (manifest → itemKeys → catalog), so the chain cannot live there without the two importing each
 * other. Keeping it whole matters more than keeping it adjacent: it is ONE priority order, and a
 * priority order split across two files is one that can be reordered in half.
 */
import { lockElementLabels, lockEntry, lockLabel } from "./manifest";
import { carrierRef, refItemId } from "./itemKeys";
import { StoreLock, SyncGroup } from "./types";

// The lock's own name for one item: its entry's label, then — for an on/off-list element that is
// never individually synced, and so has no entry of its own — the name its CARRIER recorded for it
// (spec §3's `display.elements`, v2's `memberLabels`). Both reads go through the item ref, which is
// what the lock is keyed by since v3.
export function lockStoredLabel(lock: StoreLock | null, ref: string): string | undefined {
  const own = lockLabel(lockEntry(lock, ref));
  if (own !== undefined) return own;
  const owner = refItemId(ref);
  if (owner === null || (owner.section !== "community" && owner.section !== "core")) return undefined;
  const carrier = carrierRef(owner.section === "community" ? "community-plugins" : "core-plugins");
  return lockElementLabels(lockEntry(lock, carrier))?.[owner.id];
}

/**
 * The Sync Center host wiring (main.ts syncCenterHost()) composes a caller's explicit override with
 * two snapshot fallbacks before calling catalog.ts's displayLabelForGroup — kept here, pure and
 * directly testable, after the host wrapper itself silently dropped every caller's explicit override
 * for months (it declared only the `(group)` parameter, so TypeScript never flagged the discarded
 * second argument; C-#14 live-verify).
 *
 * Priority: the caller's explicit override, then the last-computed live SyncGroup list, then the
 * last-loaded local lock — the group's own entry, then its carrier's name for it as an element. The
 * final bare-id fallback belongs to the caller (displayLabelForGroup), so this never returns the id.
 *
 * `refOf` is the caller's single ref producer (itemKeys.ts's lockRefFor, bound to the compiled sync
 * list): the lock is keyed by ref and this function is handed group NAMES, and deriving the bridge
 * here would make it a second producer of a key the compiler already mints.
 */
export function resolveHostStoredLabel(
  group: string,
  explicit: string | undefined,
  lastGroups: SyncGroup[] | null,
  lock: StoreLock | null,
  refOf: (group: string) => string
): string | undefined {
  return explicit ?? lastGroups?.find((g) => g.name === group)?.label ?? lockStoredLabel(lock, refOf(group));
}
