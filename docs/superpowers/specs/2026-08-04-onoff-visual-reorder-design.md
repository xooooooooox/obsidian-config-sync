# ③ on/off visual reorder — design

> Part 3 of 3 for one release. Siblings: ① leftover core-plugin scope safety, ②
> on/off both-ways consistency. Implement all three, deploy to main/kickstart/llm, live
> test, then cut **once**. See Global Constraints (identical across the three specs).

## Problem

In a switch-list item's expanded body the eye doesn't know where to land. Two causes:

1. **Order.** `renderSwitchDivergence` (`src/ui/SyncCenterView.ts:1773`) renders the
   `renderScopedDisclosure` ("N scoped to specific devices") **first**, synchronously,
   above the summary and the per-plugin rules (which render later in the async
   `switchDivergenceFor().then(...)` block). So a secondary, already-resolved detail
   sits on top of the primary decision ("N plugins … Apply turns them on").
2. **Duplication.** The group header row also prints "· N device-scoped"
   (`config-sync-ldnote`, `:1577-1580`) — the same N that the scoped disclosure shows —
   so the count appears twice.

## The change

**Final order (top → bottom):** directional summary line(s) → both-ways caption (when
present) → "Set a per-plugin rule" disclosure → publish note (when in a capture/both
self-state) → "N scoped to specific devices" disclosure **last**.

**De-dup the header.** Remove the `config-sync-ldnote` "· N device-scoped" span from the
group header row (`:1577-1580`). The scoped count now lives only in the bottom
disclosure's title.

**Preserve the store-absent safety (2.15.0 fix).** The scoped disclosure and the publish
note must still render when `switchDivergenceFor(...)` resolves `null` (store not yet
captured) — they only need `switchMemberDecisions` / self-state, not the divergence.
To keep order independent of async timing, `renderSwitchDivergence` creates its child
holders **synchronously in final order** (summary holder, rules holder, then scoped
holder), and the async block fills the summary/rules holders when the divergence
resolves; the scoped holder is filled synchronously and, being created last, stays at
the bottom. This replaces today's "scoped rendered first for safety" arrangement while
keeping the same null-safety guarantee.

## Non-goals

- No copy or control changes — those are ①/②. ③ is ordering + the header de-dup only.
- The scoped disclosure stays a collapsible (amber) disclosure; only its position moves.

## Testing

This is a DOM render-order change; per the repo's DOM-free unit strategy it has no new
pure-function test. It is verified at the live-test step on all three vaults:

- summary/caption appear above "Set a per-plugin rule", which appears above "N scoped to
  specific devices";
- the group header no longer shows "· N device-scoped";
- with an un-captured store (a fresh device that has scoped plugins in Settings), the
  scoped disclosure and the publish note still render (the 2.15.0 null-safety holds).

If a small pure helper is introduced to order the holders, add a focused test for it;
otherwise none.

## Global Constraints

- **Privacy in artifacts:** `~`/`$HOME`/`$USER`, `<vault>`/`<host>` placeholders; never
  embed secrets. User-facing replies in Chinese; code/comments/identifiers/docs English.
- **No commits until the cut.** Changes stay uncommitted (the user's review state).
- **Test before cut:** implement ①+②+③, deploy built `main.js`/`manifest.json`/
  `styles.css` to `main`, `kickstart`, `llm` vaults' `.obsidian/plugins/config-sync/`,
  live-test, then cut **one** version. Cut hand-writes release notes; publish is the
  user's manual step. No Claude attribution in any commit / PR / issue text.
- **Mockup 定稿** done (companion, dark single-theme): summary → rules → scoped-bottom;
  header "· N device-scoped" removed.
