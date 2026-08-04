# Switch-list on/off — summary-first block + Settings-panel scope cycle

**Status:** design approved (mockup 定稿 2026-08-04, Approach A)
**Target version:** 2.15.0 (confirm exact number at cut)
**Groups affected:** `community-plugins`, `core-plugins` (the `MEMBER_GUIDE_GROUPS` set). `enabled-css-snippets` is out of scope.

## Problem

When a switch-list on/off group diverges, the expanded item detail renders **one row per divergent member** (`renderMemberBlock` → `memberChangeRows`), each carrying the *identical* sentence — `on for your other devices, off on this computer — Apply would turn it on here too` — plus its own `where it runs ▾` button that opens a `Menu` popover.

On a freshly-bootstrapped device this floods: ~73 community plugins are simply "on elsewhere, off here" because the device has not applied yet, so the block prints ~73 identical decision rows. The repetition reads as 73 decisions the user must make, when the real intent is a single **Apply**. The `where it runs` control is also a *third* scope vocabulary — a popup menu — distinct from the Settings panel's click-to-cycle scope icon, so the same concept is taught two different ways.

The per-member `where it runs` scoping is a genuine power feature (pin a plugin to desktop / mobile / this-device). The defect is presentation: it is shown eagerly and at full length for the common bulk case, and with a control that does not match the rest of the plugin.

## Design (Approach A — summary-first, scope on demand)

The expanded detail for a diverging switch-list group becomes three stacked, collapsible parts. The bulk case is calm; per-plugin detail appears only when asked.

### 1. Summary line (replaces the member flood)

One line stating the bulk consequence, in device language, sized to the count:

- Apply direction (`captureRemoves > 0 && applyDisables === 0`):
  `{N} plugin(s) are on for your other devices but off here — Apply turns them on.`
- Capture direction (`applyDisables > 0 && captureRemoves === 0`):
  `{N} plugin(s) are on here but off on your other devices — Capture shares them.`
- Both directions (`captureRemoves > 0 && applyDisables > 0`): the existing **both-ways red divergence box** (`config-sync-divergence`, with the `⌂ Keep N extras on this device…` action) stays and is authoritative; the summary line is omitted in this case.

`N` counts the members the pending direction would flip, excluding masked exceptions — the same `switchDivergence` output already computed.

### 2. "Set a per-plugin rule" disclosure (collapsed by default)

A disclosure row (`▸ Set a per-plugin rule`). Expanded, it reveals:

- A plain client-side **search input** (`Search a plugin to give it a rule…`) that filters the member list by substring. Justified by list length (up to ~73); no fuzzy matching, no async.
- A scrollable, capped-height list of the divergent members (the `switchDivergence` members for the pending direction). Each row is: **member id** + the **scope-cycle icon** (see §4). No per-row "why" sentence — the summary above states it once.

Removing a rule is not a separate affordance: cycle the icon back to `all`.

### 3. "N scoped to specific devices" disclosure (collapsed by default)

Replaces today's always-on device-scoped decision rows (`switchMemberDecisions` → `memberDecisionText`, rendered at the top of `renderItemDetail`). A disclosure row (`▸ {N} scoped to specific devices`, amber). Expanded, it lists each already-scoped member with the **same scope-cycle icon** showing its current scope, click-to-change in place. Rendered only when `switchMemberDecisions(group).length > 0`.

The existing publish reminder (`MEMBER_PUBLISH_NOTE` — "capture Settings so your other devices pick them up") renders once beneath these disclosures when the self group's state is `capture` or `both`.

### 4. The scope control — reuse the Settings panel's `renderScopeCycle`

Both §2 and §3 rows use the **exact control from the Settings panel** (`SettingTab.renderScopeCycle`): a single Commander-style clickable icon whose glyph *is* the state (`SCOPE_ICONS`: `monitor-smartphone` / `monitor` / `smartphone` / `airplay`), `all` rendered dim (idle), any narrower scope accented (`is-set`) — mirroring the ghost-rail idle/active language. A click advances through the option list (`nextScope`); the caller owns the write and re-render of that cell. Obsidian's own `aria-label` tooltip reports the current scope (`scopeCycleTooltip`). Desktop-only plugins use `DESKTOP_ONLY_ENABLED_OPTIONS` (`all → desktop → local`), skipping the meaningless mobile stop, exactly as the Settings "Enabled on" chip does.

**`renderScopeCycle` is extracted** from `SettingTab` (currently a private method) into a shared UI module so both call sites use one implementation. This is the one structural refactor the feature requires; it removes, rather than adds, a divergent control.

The Sync Center supplies a carrier-based `onChange(scope)` that composes the **existing** host writes (unchanged semantics from `openWhereItRunsMenu`):

| target scope | write |
|---|---|
| `desktop` / `mobile` | `host.setMemberEnabledOn(carrier, id, scope)` (and ensure not a this-device exception) |
| `local` (this device) | `host.addSwitchExceptions(carrier, [id])` (and clear any `enabledOn`) |
| `all` (no rule) | `host.clearMemberLocal(carrier, id)` **and** clear any prior `enabledOn` |

Reaching `all` must clear **both** a prior device-class `enabledOn` and a prior this-device exception, so the cycle round-trips cleanly through all four stops. After each write the view reloads (as today), which rebuilds the icon from the freshly-saved config.

`openWhereItRunsMenu` and the `Menu`-popover path are removed. `memberChangeRows`'s `why`/`recommended` fields and `MEMBER_BLOCK_TITLE` become unused and are deleted; the member id list it produced is still needed and stays (as a plain id list, or folded into the divergence model).

## Core invariant

The write paths and their persisted effects are **unchanged** — the same `enabledOn` / `localMembers` / switch-exception state the old menu produced. Only the **presentation** (flood → summary + disclosures) and the **control** (menu popover → cycle icon) change. The capture/apply/status semantics for switch-list groups are untouched.

## Components & data flow

- `src/ui/scopeCycle.ts` (new): `renderScopeCycle(cell, opts)` moved verbatim from `SettingTab`, plus its direct deps if not already exported (`SCOPE_ICONS`, `nextScope`, `scopeCycleTooltip` already live in `itemCard.ts`).
- `src/ui/SettingTab.ts`: `renderEnabledOnZone` and other callers import the shared `renderScopeCycle` instead of the private method.
- `src/ui/panelModel.ts`: add a pure `switchSummaryLine(d, device)` returning the §1 text (or `null` for the both-ways case). Remove `MEMBER_BLOCK_TITLE`; remove `memberChangeRows`'s now-unused fields (keep only the member id lists, or expose them straight from `switchDivergence`).
- `src/ui/SyncCenterView.ts`: `renderSwitchDivergence` keeps the both-ways red box; `renderMemberBlock` is replaced by `renderMemberSummary` (§1) + `renderPerPluginRules` disclosure (§2) + a scoped-members disclosure (§3), each row using the shared `renderScopeCycle`. `renderItemDetail` no longer renders the device-scoped decision rows at the top (they move into §3). Disclosure open/closed state is view-local, keyed by `group.name + section`, persisted across detail rebuilds like `expandedItems`.

## Copy

Exact strings (device-aware where noted; `here` = "this computer" on desktop, "this phone" on mobile):

- Summary, apply: `{N} plugins are on for your other devices but off {here} — Apply turns them on.` (singular `plugin` / `is` when `N === 1`)
- Summary, capture: `{N} plugins are on {here} but off on your other devices — Capture shares them.`
- Disclosure titles: `Set a per-plugin rule` · `{N} scoped to specific devices`
- Search placeholder: `Search a plugin to give it a rule…`
- Publish note: unchanged `MEMBER_PUBLISH_NOTE`.
- Scope tooltip: unchanged `scopeCycleTooltip` output (`Where it syncs (currently: …)`), inherited from the shared control.

Copy is product-voice: device/consequence language, no implementation terms. Icons follow DESIGN (`SCOPE_ICONS`); the mockup's emoji are illustrative only.

## Testing

- `panelModel` unit: `switchSummaryLine` — apply case, capture case, both-ways returns `null`, singular vs plural.
- Scope-cycle onChange composition (core/host-level, against a fake host): `all → desktop → mobile → local → all` produces the expected `enabledOn` / `localMembers` / exception state at each stop, and `all` clears both a prior `enabledOn` and a prior exception.
- Existing switch-list status/capture/apply tests must stay green (behavior unchanged).
- Reuse existing test scaffolding; add only the minimum new tests for the summary model and the cycle composition.

## Scope / non-goals

- No threshold logic (small divergences still use the same summary-first block) — uniform behavior, per the chosen design. A default-open disclosure for tiny counts is a possible later refinement, not in this spec.
- No change to `enabled-css-snippets` or any non-switch-list group.
- No change to capture/apply/status semantics, the both-ways red divergence box, or the `⌂ Keep N extras on this device…` flow.
- The old menu's "· matches where it's used today" recommendation hint is dropped (the cycle has no menu to host it); acceptable — the user still reaches any scope by cycling.

## Global constraints (verbatim)

- No git commits unless the user explicitly asks; leave changes uncommitted as the review state.
- No Claude/AI attribution trailer in commits, PR, or issue text; state "no Claude attribution" when dispatching subagents that commit.
- Docs-currency gate before cut: update README + README.zh + ARCHITECTURE + DESIGN + GUIDE in the same branch for any user-facing change.
- Every cut hand-writes release notes (`## headline`, intro, `### Fixed`/`### Changed`, closing `Node suite at N tests.`); release title = bare `x.y.z`. Publishing drafts is the user's manual step.
- Privacy in artifacts: `~`/`$HOME`/`$USER`, `<vault>`/`<host>` placeholders; never embed secrets.
- UI copy follows the product-voice rule (device/consequence language, no implementation terms); icons follow DESIGN.
