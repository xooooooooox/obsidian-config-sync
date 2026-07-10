# Sync status awareness, panel UX, junk-file fix — design

**Status:** approved for planning
**Date:** 2026-07-10
**Scope:** the drift-awareness feature (#2 from post-0.10.0 feedback) with its UI entry points (plan 3 + feature toggles), the report/picker UX pass (#3), and the `.DS_Store` capture fix (#1.1). Answered-as-designed, no code: lock `groups` records plugin groups only; the store's `configdir/` segment is deliberate (device-independent store, configDir varies per device); staged apply for uninstalled plugins is intended.

## 1. Diff engine — `src/core/status.ts` (new)

`export type GroupState = "in-sync" | "local-changed" | "store-newer" | "differs" | "not-captured";`
`export interface GroupStatus { group: string; state: GroupState; }`
`export async function statusForGroups(ctx: CoreContext, groups: SyncGroup[]): Promise<GroupStatus[]>`

Per group:

- Compare the live side (real paths under configDir/vault root) against the store side (same derivation capture uses): file **sets** (relative names) and file **contents**. For groups with `sanitize`, sanitize the live JSON before comparing (capture stores sanitized content — comparing raw would always differ). Junk files are excluded on both sides (§6's shared filter).
- Store side absent (file group: store file missing; dir group: store dir missing/empty) → `not-captured`.
- Sets + contents equal → `in-sync`.
- Different → direction heuristic from mtimes: `maxLiveMtime = max(io.mtime(f))` over the group's live files; lock loaded defensively (unreadable → null).
  - `maxLiveMtime > capturedAt` → `local-changed` (edited here since last capture);
  - `maxLiveMtime <= capturedAt` → `store-newer` (typically: pulled but not applied);
  - no mtime available (all null) or no lock → `differs` (no direction).
- Direction is a labeled guess (cross-device wall clocks); UI copy must present it as such ("likely").
- Only ever computed for this device's groups (`groupsForDevice`), which callers pass in.

**`FileIO` gains `stat(path: string): Promise<{ mtime: number } | null>`** (epoch ms; null when unavailable) — shaped as `stat` rather than a bespoke `mtime()` so Obsidian's `DataAdapter` keeps satisfying `FileIO` structurally (`ctx.io = app.vault.adapter` unchanged). `tests/memfs.ts` gets settable mtimes (`io.touch(path, epochMs)` helper; seeded files default to a fixed base time).

## 2. Remote check — on demand, lock-only

`checkRemote(reader) → { state: "no-store" | "same" | "remote-newer" | "remote-older" | "unknown"; remoteCapturedAt: string | null }`, implemented by reading exactly two remote files via the existing `ExternalStoreReader`: `config-sync.json` presence (absent → `no-store`) and `store.lock.json` (`capturedAt` compared with the local lock's; either side missing/unparseable → `unknown`). No full file diff (deliberate: answers "did the remote move?" at one file's cost). Desktop-only by construction (readers are).

## 3. Entry points (plan 3)

- **Status command + sync-menu item** ("Status…", icon `activity`): opens a report modal listing each of this device's groups with a state badge — `✓ in sync` / `↑ changed on this device (likely)` / `↓ store is newer (likely)` / `≠ differs` / `— not captured yet` — name in mono, resolved path dimmed. Below, one row per configured remote with a "Check" button; result renders inline ("remote captured 2 h later — consider Pull" / "…earlier — consider Push" / "same" / "no store yet" / "cannot compare").
- **Sync-menu badges**: when enabled, `openSyncMenu` computes local status first and renders counts into item titles: `Capture (N changed here)` where N = local-changed+differs, `Apply (N store-newer)`; zero → plain titles. Menu opens after the computation (the toggle exists precisely because large dir groups make this cost real).
- **Apply picker**: each row gains the state badge; default toggle ON only for `store-newer`; `local-changed`/`differs` default OFF with the hint "applying overwrites local changes"; `in-sync` OFF and visually dimmed (still toggleable); `not-captured` disabled. CTA reads `Apply N groups` (count live-updates). When the pickers toggle (§4) is off, the picker renders exactly as today.

## 4. Feature toggles (General tab, both default ON)

- `statusInMenu: boolean` — "Sync menu shows change counts". Off → menu opens instantly, plain titles.
- `statusInPickers: boolean` — "Apply picker shows group status". Off → today's plain picker.
- Stored in settings with defaults `true` (Object.assign merge — no migration). The Status command/menu item is always available (explicit invocation, no passive cost).

## 5. Report/picker copy pass

- Everywhere a group path reaches the user (Apply picker rows, Status modal, report modals), render the **resolved** path (`{configDir}` replaced with the actual config folder of this device); the raw variable form remains a config-file-only notation.
- The Apply picker's metadata line `{configDir}/themes · dir · all` becomes: group `description` when present, else `folder`/`file` + `all devices`/`desktop only`/`mobile only` (e.g. `Installed theme files.` or `folder · all devices`).
- Pull/Push report titles become verb phrases with the remote name — `Pulled from kickstart` / `Pushed to backup` (modal title); the pseudo-group line inside drops the internal `import`/`push` label and shows just the counts line.

## 6. Junk-file filter (capture + status)

`export const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);` in core. Dir-group capture skips junk basenames while walking the live side; the existing deletion-propagation then removes previously captured junk from the store on the next Capture (junk is excluded from the wanted set). The diff engine (§1) applies the same filter on both sides so residual store junk never reports `differs`. Apply is untouched (once the store is clean, nothing to special-case).

## Error handling

- Status computation failures per group (unreadable file mid-scan) degrade that group to `differs` with the error in the Status modal row — never abort the whole listing.
- Remote check failures render inline in the Status modal row (`cannot compare: <reason>`), never a thrown modal.
- Menu badge computation failure → open the menu with plain titles (log via console.error); the menu must never fail to open.

## Testing

- Gate per task: `npm test` + `npm run build` + `npm run lint` (0 errors).
- Unit (MemFS + controlled mtimes): full state matrix — in-sync, content diff, set diff (extra/missing file), sanitize group in-sync on raw-vs-sanitized, local-changed vs store-newer via mtime relative to capturedAt, differs on no lock, not-captured; junk filter (capture skips, deletion propagation cleans, status ignores both sides); `checkRemote` all five states through a fake reader.
- Smoke: Status modal renders states; menu badges appear and toggle off via settings; Apply picker defaults follow states; resolved paths in copy; zero console errors.

## Non-goals

Background/scheduled checks; remote full-file diff; a Capture picker; recording non-plugin groups in the lock; conflict resolution/merge.
