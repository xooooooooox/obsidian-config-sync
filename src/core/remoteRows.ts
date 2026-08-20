import { GroupState, GroupStatus, OTHER_STORE_FILES_GROUP, RemoteDiffEntry, RemoteState } from "./status";
import { FileChanges } from "./types";

// Which way this whole comparison points. ONE direction for the whole list: diffRemote only answers
// "are the two sides byte-equal", so there is no per-item evidence to point rows in different
// directions yet.
export type RemoteFlow = "pull" | "push";

// Everything that is not "the remote is behind us" reads as pull, because pull is the additive
// operation: it never removes a local file, while push mirror-deletes whatever the remote has and we
// do not. An undecidable state must land on the side that cannot destroy anything.
export function remoteFlowFor(state: RemoteState): RemoteFlow {
  return state === "remote-older" ? "push" : "pull";
}

function changesOf(entry: RemoteDiffEntry): FileChanges {
  const out: FileChanges = { added: [], updated: [], deleted: [] };
  for (const f of entry.files) out[f.kind].push(f.itemRel);
  return out;
}

// The remote relation's rows, in the SAME shape the device relation produces, so one renderer can
// draw both. An item the comparison never mentioned is in sync with this remote — that is what
// "the comparison found no difference" means, and it is why the local list is the row set's floor
// rather than the diff being it.
export function remoteRowStatuses(input: {
  entries: readonly RemoteDiffEntry[];
  flow: RemoteFlow;
  localGroupNames: readonly string[];
}): GroupStatus[] {
  const { entries, flow, localGroupNames } = input;
  const changedState: GroupState = flow === "pull" ? "store-newer" : "local-changed";
  const out: GroupStatus[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    // "" is diffRemote's store-metadata pseudo-entry and OTHER_STORE_FILES_GROUP its unattributable
    // one. Neither is an item, so neither is ever a row.
    if (e.group === "" || e.group === OTHER_STORE_FILES_GROUP) continue;
    if (e.files.length === 0) continue;
    seen.add(e.group);
    out.push({ group: e.group, state: changedState, changes: changesOf(e) });
  }
  for (const name of localGroupNames) {
    if (seen.has(name)) continue;
    out.push({ group: name, state: "in-sync" });
  }
  return out;
}
