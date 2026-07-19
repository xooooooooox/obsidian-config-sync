import { GroupState } from "./status";
import { VersionDrift } from "./availability";

export type SelfPaneState = "coldstart" | "adopt" | "capture" | "both" | "insync";

// Decides the Config Sync pane's direction from the self item's content status (GroupState) AND
// its version drift. A plugin update usually leaves data.json content unchanged but bumps the
// version — content stays "in-sync" while drift goes "ahead"; that is still a capture (capturing
// refreshes the store's recorded version), which the item-list view used to surface and the pane
// must too. `contentChanged` tells the pane to show a data.json diff; `versionRefresh` tells it to
// show the version line.
export function selfPaneState(args: { isColdStart: boolean; groupState: GroupState | undefined; drift: VersionDrift }): {
  state: SelfPaneState;
  versionRefresh: boolean;
  contentChanged: boolean;
} {
  if (args.isColdStart) return { state: "coldstart", versionRefresh: false, contentChanged: false };
  const s = args.groupState;
  const versionRefresh = s === "in-sync" && args.drift === "ahead";
  const contentChanged = s === "local-changed" || s === "store-newer" || s === "differs" || s === "not-captured";
  let state: SelfPaneState;
  if (s === "store-newer") state = "adopt";
  else if (s === "differs") state = "both";
  else if (s === "local-changed" || s === "not-captured" || versionRefresh) state = "capture";
  else state = "insync";
  return { state, versionRefresh, contentChanged };
}
