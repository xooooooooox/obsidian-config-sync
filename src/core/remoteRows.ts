import { GroupState, GroupStatus, ItemVerdict, OTHER_STORE_FILES_GROUP, RemoteDiffEntry } from "./status";
import { FileChanges, ItemRef } from "./types";

function changesOf(entry: RemoteDiffEntry): FileChanges {
  const out: FileChanges = { added: [], updated: [], deleted: [] };
  for (const f of entry.files) out[f.kind].push(f.itemRel);
  return out;
}

// The remote relation's rows, in the SAME shape the device relation produces, so one renderer draws
// both. Two inputs, two jobs, kept apart on purpose:
//
//   `verdicts` says what each item still NEEDS (core/status.ts's remoteItemVerdicts, already
//   intersected with this remote's four-stop rules) — that is the row's STATE.
//   `entries` says which files differ — that is the card's EVIDENCE, and it no longer decides the
//   state. An item whose bytes differ but whose difference runs in a closed direction is in sync
//   (spec 3.3), and the card is where it still answers what changed over there.
//
// An item the table names but the diff never mentioned still gets its row: the remote can be ahead
// on bookkeeping alone (a newer recorded version, same bytes), which is a real pull.
export function remoteRowStatuses(input: {
  entries: readonly RemoteDiffEntry[];
  verdicts: Record<string, ItemVerdict>;
  // The items whose copies could not be read here (spec 3.8). Outranks both other inputs: a verdict
  // is a claim about a comparison, and for these there was none.
  uncomparable: readonly string[];
  refOf: (group: string) => string | undefined;
  localGroupNames: readonly string[];
}): GroupStatus[] {
  const { entries, verdicts, refOf, localGroupNames } = input;
  const unreadable = new Set<string>(input.uncomparable);
  const changesByGroup = new Map<string, FileChanges>();
  for (const e of entries) {
    // "" is diffRemote's store-metadata pseudo-entry and OTHER_STORE_FILES_GROUP its unattributable
    // one. Neither is an item, so neither is ever a row.
    if (e.group === "" || e.group === OTHER_STORE_FILES_GROUP) continue;
    if (e.files.length === 0) continue;
    changesByGroup.set(e.group, changesOf(e));
  }
  const stateOf = (group: string): GroupState => {
    const ref = refOf(group);
    // A row with no ref carries no rule and no lock entry to judge by, so the file diff is all
    // there is and a difference reads as an incoming one. (Plan 3b gives those items a ref.)
    if (ref === undefined) return changesByGroup.has(group) ? "store-newer" : "in-sync";
    // The same state the device relation gives an encrypted item it cannot open — one word for one
    // thing, and the relation's own copy table is what makes it read as `Can't compare` here.
    if (unreadable.has(ref)) return "locked";
    const verdict = verdicts[ref];
    return verdict === "pull" ? "store-newer" : verdict === "push" ? "local-changed" : "in-sync";
  };
  const names = [...new Set([...localGroupNames, ...changesByGroup.keys()])];
  return names.map((group) => {
    const changes = changesByGroup.get(group);
    const status: GroupStatus = { group, state: stateOf(group) };
    return changes === undefined ? status : { ...status, changes };
  });
}

// The rows the user did NOT tick, as the skip list the transport already speaks. The checkbox means
// the same thing under both relations — "does this run include this row" — and under the remote
// relation that is exactly `skipRefs`, which planImport/pushExternal have taken since schema v5.
export function skipRefsForSelection(input: { allRefs: readonly ItemRef[]; selectedRefs: readonly ItemRef[] }): ItemRef[] {
  const keep = new Set<string>(input.selectedRefs);
  return input.allRefs.filter((r) => !keep.has(r));
}
