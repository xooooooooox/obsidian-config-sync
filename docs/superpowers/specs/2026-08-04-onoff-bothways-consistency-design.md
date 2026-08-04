# ② on/off both-ways consistency — design

> Part 2 of 3 for one release. Siblings: ① leftover core-plugin scope safety,
> ③ on/off visual reorder. Implement all three, deploy to main/kickstart/llm, live
> test, then cut **once**. See Global Constraints (identical across the three specs).

## Problem

The Sync Center's switch-list on/off items (`community-plugins`, `core-plugins`) got
the 2.15.0 summary + per-plugin-rule treatment only for **one-sided** divergence.
When a device diverges **both ways** — some plugins on in the store but off here
(`captureRemoves`) *and* some on here but off in the store (`applyDisables`) — the
item falls back to the pre-2.15.0 presentation: a red "diverge both ways" box, a full
`core-plugins.json` diff, and a "Keep N extras on this device…" modal
(`src/ui/SyncCenterView.ts:1787-1808`). On a bootstrap device the community list
(one-way) reads cleanly while the core list (both-ways) looks like a different, older
product. Same render path, different state — the both-ways branch was never migrated.

## Root cause

`switchSummaryLine` returns `null` for both-ways (`src/ui/panelModel.ts:291`) and
`pendingScopeMembers` returns `[]` (`:275`), by the 2.15.0 design comment "both-sided
divergence is owned by the red both-ways box." So `renderSwitchDivergence` renders no
summary and no per-plugin rules for both-ways, and the red box + `KeepOnDeviceModal`
carry the whole interaction.

## The change (Approach A — two directional lines)

Bring both-ways into the same summary + per-plugin-rule system; delete the red box and
the modal.

**Summary — two directional lines.** Replace `switchSummaryLine` (string | null) with a
pure `switchSummaryLines(d, device): SummaryLine[]`, where
`SummaryLine = { dir: "apply" | "capture"; text: string }`:

- one-way apply (`captureRemoves` only) → `[{dir:"apply", "N plugins are on for your
  other devices but off <here> — Apply turns them on."}]`
- one-way capture (`applyDisables` only) → `[{dir:"capture", "N plugins are on <here>
  but off on your other devices — Capture shares them."}]`
- both-ways → **both** lines, **apply line first** then capture line (matches the
  mockup and keeps Apply — the primary action on a never-synced item — on top)
- neither → `[]`

`<here>` stays device-aware ("this computer" / "this phone"). Singular/plural wording
unchanged. The renderer draws each line with its direction glyph (↓ apply / ↑ capture).

**Both-ways caption.** A single quiet line rendered **only** when both sides > 0:
`switchBothWaysCaption` = *"Bulk Apply or Capture resolves every plugin one way. Pin
the ones that differ on purpose below."* Preserves the old red box's honesty (bulk
either-direction is not a no-op) in the clean layout.

**Per-plugin rules — direction groups, no per-row tags (live-test 定稿 2026-08-05).**
A pure `ruleGroups(d, device): RuleGroup[]` (`RuleGroup = { dir: Direction; label:
string | null; ids: string[] }`) feeds the rule list: one-sided → a single unlabeled
group (the summary line above already states the direction); both-ways → two labeled
groups, store side first (matching the summary's apply-first order), headers
`"Off this computer · N"` (dir apply) / `"On this computer only · N"` (dir capture),
device-aware (`this phone` on mobile), each header led by its direction glyph. Rows
carry no per-row direction tag — an earlier per-row *"in store only"*/*"on here only"*
tag repeated identical text down each side (first live-test round) and was replaced by
the group headers. A search-filtered-empty group hides its header. Every row keeps the
shared `renderScopeCycle` control.

**Snippets keep their warning (user-adjudicated 2026-08-04).** The old red box was NOT
gated on the member-guide groups: `enabled-css-snippets` also rendered it on both-ways
divergence, and deleting the box silently dropped that warning. Decision (option 1 of the
annotated mockup): the two-line summary + both-ways caption render for **all** switch-list
groups, with the noun switched by group kind — `switchSummaryLines(d, device, noun)` takes
`noun: "plugin" | "snippet"` (explicit, no default) and pluralizes `${noun}s`; the caption
becomes `switchBothWaysCaption(noun)`: for `"plugin"` the existing sentence, for
`"snippet"` *"Bulk Apply or Capture resolves every snippet one way. Pin per-snippet
devices on the Appearance card in Settings."* The per-plugin rule list stays gated on
`MEMBER_GUIDE_GROUPS` (a snippet's per-item scope already lives on the Appearance card in
Settings — no per-snippet rule list). Capability note: the old "Keep N extras" bulk
multi-select is replaced by per-item scope writes (same `addSwitchExceptions`); if live
testing shows large sets miss the bulk affordance, a bulk action can return later — not
in this round.

**Delete the red box and `KeepOnDeviceModal`.** "Keep N extras on this device" is
exactly `addSwitchExceptions` — which the scope-cycle already performs when a member is
set to **this device** (`memberScopeWrite` → `{kind:"local"}` → `addSwitchExceptions`,
`src/ui/panelModel.ts:266`, `src/ui/SyncCenterView.ts:1897`). So the per-plugin scope
control replaces the modal one-for-one; the bulk modal and the `config-sync-divergence`
box are removed. (If live test shows bulk-keep is missed for large sets, a bulk action
can return later — not in this round.)

## Invariant

Host writes and capture/apply/status semantics are unchanged: the per-plugin `onChange`
still composes the same `setMemberEnabledOn` / `addSwitchExceptions` / `clearMemberLocal`
calls. Only the summary/rule **presentation** for the both-ways state changes.

## Non-goals

- The full `core-plugins.json` diff view still exists for users who expand it via the
  item's normal change view; ② removes only the *auto-rendered* both-ways diff/box, not
  the diff feature.
- Scope-axis behavior (① territory) and ordering/de-dup (③ territory) are separate specs.

## Testing

Pure-function tests (`tests/panelModel.test.ts`), matching the repo's DOM-free strategy:

- `switchSummaryLines`: one-way apply → 1 line `dir:"apply"`; one-way capture → 1 line
  `dir:"capture"`; both-ways → 2 lines, apply first; neither → `[]`; device wording
  (`this computer` vs `this phone`); singular vs plural.
- `pendingScopeMembers`: both-ways → union of both sets (order stable); one-way
  unchanged; neither → `[]`.
- `memberDivergenceSide`: an `applyDisables` id → `"here"`; a `captureRemoves` id →
  `"store"`.
- Caption gating: present only when both sides > 0 (a constant + a render guard — assert
  the guard predicate, not the DOM).

Update the existing `switchSummaryLine` tests to the new `switchSummaryLines` shape;
remove assertions that both-ways → null / `[]`.

## Global Constraints

- **Privacy in artifacts:** `~`/`$HOME`/`$USER`, `<vault>`/`<host>` placeholders; never
  embed secrets. User-facing replies in Chinese; code/comments/identifiers/docs English.
- **No commits until the cut.** Changes stay uncommitted (the user's review state).
- **Test before cut:** implement ①+②+③, deploy built `main.js`/`manifest.json`/
  `styles.css` to `main`, `kickstart`, `llm` vaults' `.obsidian/plugins/config-sync/`,
  live-test, then cut **one** version. Cut hand-writes release notes; publish is the
  user's manual step. No Claude attribution in any commit / PR / issue text.
- **Product-voice copy:** device/consequence language, no implementation-term leakage;
  the mockup copy is the final copy.
- **Mockup 定稿** done (companion, dark single-theme): two-line summary + caption +
  unified per-plugin rules; red box and modal removed.
