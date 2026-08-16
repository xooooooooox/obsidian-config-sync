import { GroupState } from "./status";
import { VersionDrift } from "./availability";

export type SelfPaneState = "coldstart" | "adopt" | "capture" | "both" | "insync";

// Decides the Config Sync pane's direction from the self item's content status (GroupState) AND
// its version drift. A plugin update usually leaves data.json content unchanged but bumps the
// version — content stays "in-sync" while drift goes "ahead"; that is still a capture (capturing
// refreshes the store's recorded version), which the pane
// must surface. `contentChanged` tells the pane to show a data.json diff; `versionRefresh` tells it to
// show the version line. `flagsRefresh` (desktop-only flags not yet recorded in the store) is
// another reason the pane nudges a capture. `versionBehind` (this device's plugin older than the
// store's captured version) is an orthogonal advisory — it never changes `state`, because updating
// config-sync from inside a run would unload the running code; the pane can only point at Obsidian's updater.
export function selfPaneState(args: { isColdStart: boolean; groupState: GroupState | undefined; drift: VersionDrift; flagsDrift: boolean }): {
  state: SelfPaneState;
  versionRefresh: boolean;
  versionBehind: boolean;
  contentChanged: boolean;
  flagsRefresh: boolean;
} {
  if (args.isColdStart) return { state: "coldstart", versionRefresh: false, versionBehind: false, contentChanged: false, flagsRefresh: false };
  const s = args.groupState;
  const versionRefresh = s === "in-sync" && args.drift === "ahead";
  const versionBehind = args.drift === "behind";
  const flagsRefresh = args.flagsDrift;
  const contentChanged = s === "local-changed" || s === "store-newer" || s === "differs" || s === "not-captured" || s === "never-synced";
  let state: SelfPaneState;
  if (s === "store-newer" || s === "never-synced") state = "adopt";
  else if (s === "differs") state = "both";
  else if (s === "local-changed" || s === "not-captured" || versionRefresh || flagsRefresh) state = "capture";
  else state = "insync";
  return { state, versionRefresh, versionBehind, contentChanged, flagsRefresh };
}
