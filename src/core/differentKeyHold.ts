import { groupHasCiphertext } from "./modes";
import { RemoteKey } from "./remotePassphrase";
import { GroupResult, ItemRef, SyncGroup } from "./types";

// TEMPORARY BY DESIGN — Plan 4c deletes this whole module. Until pull and push can transcode
// (decrypt under one side's key, re-encrypt under the other's), exchanging ciphertext with a
// remote that keeps its own passphrase is wrong BY CONSTRUCTION, no decryption needed to know it:
// a pull writes bytes this vault can never open into its own store, a push does the same to the
// other side, and either only detonates at the next apply — far from the scene. Not exchanging is
// the only honest behaviour, and it is per-item: everything without ciphertext still travels.
export function differentKeyHold(input: {
  key: RemoteKey;
  remoteName: string;
  groups: readonly SyncGroup[];
}): { skipRefs: ItemRef[]; results: GroupResult[] } {
  if (input.key.kind === "same-as-local") return { skipRefs: [], results: [] };
  const held = input.groups.filter((g) => g.ref !== undefined && groupHasCiphertext(g));
  return {
    skipRefs: held.map((g) => g.ref as ItemRef),
    results: held.map((g) => ({
      group: g.name,
      status: "warning",
      filesWritten: [],
      filesDeleted: [],
      messages: [
        `Skipped — ${input.remoteName} keeps its own passphrase, so this item's encrypted contents can't travel between the two. Nothing was written.`,
      ],
      needsAppReload: false,
      changes: { added: [], updated: [], deleted: [] },
    })),
  };
}
