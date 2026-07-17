# Capture-side enable policy, panel freshness, failure visibility, blob seeding

Real-vault findings on device B (0.26.0), 2026-07-17. One branch (fix/blob-seed-encrypt),
release 0.26.1. Includes the two fixes already on the branch.

## A. Capture-side enable policy (user picked b over an instant "Enable now")

**Gap.** The Disabled section promises "settings sync either way — choose whether applying also
turns the plugin on", but the ⏻ Enable / Keep disabled ladder only renders when the row's
direction is apply. A disabled plugin whose settings exist locally but not in the store
(not-captured / local-changed → direction capture, e.g. Markmind) shows no enable control at
all, and staging it reads "Capture 1 item" with no way to turn the plugin on.

**Decision criterion (established in review):** actions ride the batch when their ORDER
relative to the transfer matters (install/update before the settings write, enable after it).
A capture-direction enable has no ordering constraint — it joins the batch purely for
interaction consistency (stage → choose policy → run), which the user chose over introducing a
second "instant action" pattern.

**Design.**
- Core: `CaptureItem { name; action: "enable" | "none" }` and
  `captureWithActions(ctx, items, onProgress)` — captures as today, then runs the enable for
  flagged items (community + core plugins, shared `enableForGroup` helper also used by the
  apply-side finish). Result notes mirror apply: `⏻ enabled` / `⚠ enable failed` (+ message),
  a failed enable turns the result to warning. Enable runs AFTER the capture (no ordering
  constraint either way; after keeps the report sequence natural).
- UI: the Disabled section renders the policy ladder for BOTH directions. Label follows the
  direction ("On capture" / "On apply"). For capture direction the ladder offers only
  ⏻ Enable / Keep disabled (install/update actions are apply-ordered and stay apply-only);
  the staged default for a capture-direction disabled row is ⏻ Enable. Collapsed-row pill
  unchanged.
- `SyncCenterHost.captureItems` takes `CaptureItem[]`; the payload maps a disabled-section
  row's chosen policy ("enable") and everything else to "none".

## B. Panel freshness (ZotLit stuck in "Disabled")

**Diagnosis (confirmed on B, 0.26.0):** enabling/disabling a plugin in Obsidian's settings
modal doesn't reload the Sync Center (it reloads on leaf change and its own runs only), so the
row keeps its stale section until the panel reopens.

**Fix:** a light interval (10s, only while the window is focused and a Sync Center leaf is
open) snapshots the enabled sets (community ids + enabled core ids, joined string). On change
it runs `refreshLocalStatus()`, which already notifies open panels. No public Obsidian event
exists for plugin enable/disable; polling a Set is O(plugins) and effectively free.

## C. Already on the branch (recorded for the release)

- **Blob seeding**: enable-time seeding defaults opaque-blob items (e.g. remotely-save) to
  Encrypt — Fields cannot express a blob; previously they silently stayed Plain.
- **Failure visibility**: result-strip pills add `✗ N` / `⚠ N`; a failed run no longer looks
  like "nothing happened" behind a collapsed details link.
- **Manual-update guidance**: update failures now read "settings not applied (they were
  captured on a newer plugin version); update the plugin manually, then apply again" — generic
  wording, no tool names (plugins distributed outside the community catalog, e.g. via Gitee
  updaters, can't be updated by us).

## Testing

- core: captureWithActions enables after capture (note ⏻ enabled, plugin enabled, capture
  content correct); failed enable → warning + no false note; core-plugin enable path;
  action "none" behaves exactly like today's capture.
- UI live (dev vault): disabled+local-changed row shows "On capture" ladder defaulting to
  ⏻ Enable; Capture 1 item captures AND enables; row leaves Disabled. Freshness: manual
  enable in the settings modal refreshes the open panel within ~10s.
- Gates: full suite, build, lint 67 baseline, no hardcoded colors.
