# Version Chain Completion + Polish (0.23.x)

Five acceptance findings from the real-vault version-refresh flow (A updates a plugin → captures
→ B pulls), confirmed 2026-07-16.

## 1. Pull adopts remote lock entries for content-identical groups (core chain fix)

A's version-refresh capture updates only `store.lock.json`. B's pull today keeps LOCAL lock
entries for every group it didn't take files from — so a content-identical pull carries **no
lock update**, B's availability never sees the new `sourcePluginVersion`, and the Outdated flow
never fires. The chain fixed at the source in 0.23.4 was still broken at the pull hop.

**Fix (`applyImport` lock merge):** a group whose post-merge store content equals the remote's
adopts the REMOTE lock entry; only groups kept from the local side (local-only groups, conflicts
resolved "local") keep local entries. Concretely: remote-won names (existing rule) ∪ groups
classified `identical` by the merge plan adopt remote entries. `capturedAt` adopts the remote
value when any entry was adopted (the newer capture lineage). Unit tests cover the
identical-only pull carrying a lock version bump.

## 2. Remote hint reconciliation (content vs lock)

`checkRemote` is timestamp-based; the deep diff is store-content-based; a lock-only update makes
them contradict ("Pull would update your store" + "remote matches the local store"). With a
loaded deep diff:
- diff empty + remote lock differs from local lock → detail line becomes "contents match —
  remote has newer version info; Pull refreshes it" (↓ retained; pull is genuinely useful).
- diff empty + locks equal → "remote matches the local store" (and nothing to pull).
`deepDiff`'s host result gains a `lockDiffers: boolean` (compare raw store.lock.json both sides).

## 3. Trailing status refresh must not block the run UI

The post-capture/apply `refreshLocalStatus()` runs inside the awaited host call, so the panel's
progress bar sits at 0/N through a full scan (seconds on large vaults pre-cache) and the view
then rescans anyway on reload. Capture host: fire the refresh in the background (`void`). Apply
host: keep the self-item `loadSettings()` await (correctness), then background-refresh.
Closing the panel mid-run never cancels the operation; a reopened panel computes fresh state —
already truthful, now also not double-scanned.

## 4. Ribbon dot uses presented states

`updateRibbonDot` buckets raw states, so version-ahead items light nothing while the panel shows
To capture — same class as the 0.23.5 counts fix, one level up. `refreshLocalStatus` now also
loads the lock and computes per-group drift (availabilityForGroup — no crypto cost), stores
presented-bucket counts, and the dot logic consumes them.

## 5. Passphrase badge layout

The 0.23.4 badge overlaps the wrapped description text (ddd.png). Fix by layout, keeping the
定稿 look: badge stays in the control cluster, `white-space: nowrap`, proper flex participation
(no absolute overlap); verify at narrow widths.

## Testing
#1 unit (lock adoption matrix incl. identical-only pull); #2 host flag unit-light + smoke; #3–#5
smoke in dev vault (progress completes at N/N; dot lights on forged ahead; badge at multiple
widths). Gates: 326+ tests, 0 errors/65 warnings, color scan.
