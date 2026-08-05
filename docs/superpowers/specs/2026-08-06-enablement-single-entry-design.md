# Enablement single entry + bootstrap remote state — design

Date: 2026-08-06 · Scope: live-test batch 1 (issues #3, #5-B, #5b) · Status: approved
(#5 decided via mockups `dual-surface.html` / `staged-flow.html`, user chose B; copy therein
is final)

## #3 · Bootstrap device must not show "remote state unknown"

`checkRemote` (status.ts) returns `"unknown"` when `localLock === null`, conflating "this
device has no store yet" with "couldn't reach/parse the remote". On a fresh device with a
reachable remote that has data, the truthful state is **`"remote-newer"`** — pull would
update the (empty) store, the sidebar shows the pull arrow instead of "?", and
`remoteDirectionCounts` counts it as pull. `"unknown"` remains for its honest cases: no
lock file at the remote, unparseable locks, unreadable timestamps, check failures.

Change: `if (localLock === null) return { state: "remote-newer", remoteCapturedAt: remote.capturedAt };`
Tests: flip/extend the null-local-lock case; unknown cases unchanged.

## #5-B · Enablement has one entry: the on/off card

**Model**: when a plugin's enablement carrier is a synced item (the `core-plugins` /
`community-plugins` group compiles), the plugin's own card **never changes the switch** —
the on/off card is the single write path (its apply now switches at runtime, spec
2026-08-05-onoff-apply-runtime). The per-card ⏻ Enable / Keep disabled policy remains only
as a fallback when the carrier is NOT synced.

### Disabled-section rows (core AND community), carrier synced

- Collapsed row gains a **fate pill** (copy final):
  - member the on/off apply will turn on (element in the carrier's apply-side delta):
    `⏻ turns on with Core plugins on/off` (community: `…with Community plugins on/off`)
  - member off in the store too: no pill (quiet row).
- Expanded card: the On-apply policy row is replaced by a **static fate line** (copy final):
  - turn-on member: `enablement follows Core plugins on/off` (community wording alike)
  - off-everywhere member: `stays off — off on your other devices too`
  - member masked by a per-plugin rule or This-device pin: `follows its per-plugin rule`
- Staging: these rows stage as settings-only (`action: "none"`); the footer's "N to
  enable" counts only real policy enables. Section select-all therefore seeds no enable —
  the bootstrap mass-mis-enable trap (last round's parked Important-2) dies here.
- Fallback: carrier item not enabled for sync → policy UI and behavior exactly as today.
- "Not installed" section is untouched this round (Install & enable stays).
- Section note (Disabled) becomes: `Settings sync either way — whether a plugin turns on
  follows the on/off card.` (fallback contexts keep the old note).

### on/off card member rows

- Members whose own card currently has store settings pending (↓) get a faint pill
  `has settings below` (copy final, from mockup).

### Data plumbing

Fate derives from the carrier's existing divergence data (`switchDivergenceFor`:
apply-side list membership) plus the exception mask for the "follows its per-plugin rule"
case — pure derivation in panelModel (`memberFate(element, divergence, masked): "turns-on"
| "stays-off" | "rule"`), tested; the view maps it to pill/line copy.

## #5b · One plugin, one name on both surfaces

The on/off card's member rows (rule groups, scoped disclosure) render raw element ids
(`zk-prefixer`) while sections render display names (`Unique note creator`) — users can't
join the lists (reported twice as "missing" members). Member rows now resolve display
names through the existing chain: core → `getCorePluginName`; community → installed name →
lock label → id. History/pull report delta lines (`turns on: …`) keep raw ids — they are
the technical record of file content.

## Tests

- checkRemote bootstrap case → remote-newer (+ unknown cases still covered).
- `memberFate` truth table: apply-side member → turns-on; absent both sides → stays-off;
  masked → rule; carrier-unsynced context → policy fallback path unchanged (existing
  policyOptions tests keep passing).
- Staging: disabled row with synced carrier stages `action:"none"`; with unsynced carrier
  stages policy default as today.

## Out of scope

- Plan C (dissolving the on/off card into per-plugin rows) — recorded direction, later
  round.
- Install & enable flow, snippets switch list, history line naming.
