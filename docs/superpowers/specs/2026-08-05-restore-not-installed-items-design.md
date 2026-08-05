# Restore not-installed sync items (install-on-apply regression) — design

Date: 2026-08-05 · Scope: C of the 2026-08-05 round · Status: approved (brainstorm 定稿)

## Problem

Since the schema-v2 refactor (07d303a, 2.0.0), the local registry builds community/beta
item defs **only from installed plugins** (`buildItemDefs`'s `env.plugins`), and
`compileItems` iterates defs — so a selected `community:X` whose plugin is not installed on
this device compiles into nothing. The whole entry point disappears: no row, no
"Not installed on this device" section entry, no install-on-apply. A fresh v2 device
(llm-wiki: 60+ selected community plugins, only Config Sync installed) shows 28 groups
instead of ~100 and can never install its fleet.

`defsForForeignItems` (registry.ts:182) already synthesizes exactly these defs — but it is
wired only into leftover attribution (leftover.ts:15), not the local compile. The install
machinery itself (spec C4: BRAT index → community catalog, `installViaBrat`) is intact and
needs no change.

Two v1-era conveniences were also gutted by v2 and must be re-homed, not re-invented:

- **Display labels**: v1's `backfillLabels` persisted pretty names into the stored group
  list, which synced. Under v2 `groupsIO.write` is in-memory only ("no durable home"), so
  the backfill still runs but evaporates — a device without the plugin would show raw ids.
- **Beta classification**: synthesized defs must not degrade BRAT plugins to plain
  community items; `settings.bratPluginIndex` (id → owner/repo) is synced and available
  locally.

## Design

### 1. Compile synthesized defs locally

`recompile()` (main.ts:267) builds the def list as:

```ts
this.registryDefs = defsForForeignItems(buildItemDefs(env), Object.keys(this.settings.items), betaIds)
```

`defsForForeignItems` gains a `betaIds: Set<string>` parameter; a synthesized def whose
plugin id is in the set gets `section: "beta"` (installed defs already do this). The
leftover.ts call site passes the same set (host already exposes `betaIds()`; core reaches
it via the existing hook or a new context field — plan decides the plumbing).

Consequences that need no new code: compileItems emits the groups (selection `enabled` is
already true), availability classifies them `not-installed`, the existing section +
install-on-apply + enablement carrier handling all reconnect. `desktopOnly` stays unset for
synthesized defs (unknown until installed) — same as today's foreign defs.

### 2. Labels ride the store lock

The lock (`store.lock.json`) is the established channel for "what the source device knew
about a plugin" (`sourcePluginVersion`, `desktopOnly`). Add `label?: string` to
`StoreLock.groups[name]`:

- **Write**: capture fills `label` from the runtime name (`getInstalledPluginName` /
  `getCorePluginName` / the def's label) — the capturing device always knows it.
- **Read**: the display resolver chain gains one link: runtime name → compiled/stored group
  label → **lock label** → id. Plumbing: main.ts keeps the last loaded lock (it already
  loads it in `computeStatuses`) and `displayName`/`displayParts` consult it.
- **Retire `backfillLabels`** (main.ts:357) and the in-memory `groupsIO.write` path it
  feeds — the mechanism v2 orphaned. `groupsIO.write`'s only other caller (stopSyncing
  fallback) is untouched.

Transitional window: until a source device runs the new version and captures once, an
uninstalled plugin shows its id. One sync later the name is durable fleet-wide.

### 3. Install ordering: catalog before BRAT

A cold bootstrap batch can contain BRAT itself plus BRAT-managed plugins. Sequential
install runs order staged install actions so catalog-installable ids run before
BRAT-index ids — then `installViaBrat` finds BRAT installed+enabled in the same apply.
(One-line sort at the point the apply run iterates staged state actions.)

## Tests

- registry: selected-but-uninstalled `community:X` compiles a group with
  `{configDir}/plugins/X/data.json`; beta id gets `section: "beta"`; installed defs are
  never duplicated (known-set dedupe).
- lock: capture writes `label`; parseStoreLock round-trips it; resolver falls back
  runtime → stored → lock → id in that order.
- ordering: staged mix of catalog + BRAT ids sorts catalog-first.

## Out of scope

- Direct GitHub downloader for beta installs without BRAT (parked backlog "方案C").
- Fetching catalog names over the network for labels.
