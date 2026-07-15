import { ensureSelfPresets } from "../core/catalog";
import { SyncGroup } from "../core/types";

export interface CommitResult {
  ok: boolean;
  groups: SyncGroup[]; // on success: the mutated draft; on failure: the original reference
  error: string;
}

// Applies mutator to a deep clone of `groups`, persists via write, and returns the draft only
// when the write succeeds. On failure the original array reference is returned unchanged so the
// caller's state and the disk stay in agreement. ensureSelfPresets runs last so no UI edit path
// can ever drop the self item's locked strip rules.
export async function commitDraft(
  groups: SyncGroup[],
  mutator: (draft: SyncGroup[]) => void,
  write: (groups: SyncGroup[]) => Promise<void>
): Promise<CommitResult> {
  const draft = structuredClone(groups);
  mutator(draft);
  const withPresets = ensureSelfPresets(draft);
  try {
    await write(withPresets);
  } catch (e) {
    return { ok: false, groups, error: (e as Error).message };
  }
  return { ok: true, groups: withPresets, error: "" };
}
