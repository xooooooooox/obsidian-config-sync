# Cold-start robustness (0.33.0)

Real-vault test 2026-07-19: on `main.vault`, the config dir was switched
`.obsidian_apple` → `.obsidian`, then Config Sync was freshly installed. Adopting the store
left the device broken. Root cause traced through a chain of findings; the fixes below close
them.

## Findings (from the test)

- **F3 (root cause) — after Adopt the device points at the wrong, empty store.** The store
  lives at `0-Extra/config-sync` (IOTO placement). A fresh install auto-detects PKM = default
  (the `ioto-update` plugin isn't enabled yet — it's in the store, not applied), so
  `resolvedRootPath()` resolves to `config-sync` (empty). Adopt then applied the store's
  config-sync data.json, overwriting the user's manual PKM override with `pkm: auto`, so the
  device reverted to the empty store. Every item read "not captured yet — nothing in the
  store"; the panel was entirely wrong.
- **F2** — the Adopt banner only appeared after the user manually set the Store folder / PKM,
  because bootstrap detection only looks at `resolvedRootPath()`.
- **F6** — a symptom of F3: the 5 device config files showed as "to capture" because they were
  compared against the empty store. Fixing F3 makes the comparison correct.
- **F1 (data risk)** — before Adopt the device has no groups, so the Leftover feature counted
  the ENTIRE store (90 files) as leftover, complete with "Delete all" — one click from wiping
  the just-captured config.
- **F4** — Adopt is recorded in History but showed no inline result strip (the strip's state
  is per-view-instance and is lost when the view reloads).
- **F5** — Adopt only sets up the manifest ("1 item adopted"); the banner "set up this device"
  over-promises. The user must then apply the store, but there is no guidance.

## ① Robust store discovery (fixes F2, F3, F6)

`resolvedRootPath()` today = `resolveRootPath(settings.rootPath, pkmMode, probe)`:
- explicit `settings.rootPath` → used verbatim (respected; a user who set it knows where it is);
- else the PKM-mode default (`config-sync` or `0-Extra/config-sync` or `{extraFolder}/config-sync`).

Add a discovery step for the **auto/empty** case (`settings.rootPath === ""`): among the
candidate roots — the mode default, `DEFAULT_ROOT` (`config-sync`), `IOTO_FALLBACK_ROOT`
(`0-Extra/config-sync`), and `{extraFolder}/config-sync` when ioto-settings is readable —
return the first that **has a store** (`store.lock.json` exists). If none has a store, return
the mode default (a truly fresh vault; the first capture creates the store there).

This makes the store findable regardless of PKM auto-detection, so:
- the Adopt banner appears without manual setup (F2);
- after Adopt, capture/apply keep pointing at the real store even though the adopted settings
  carry `pkm: auto` (F3);
- the config files compare against the real store, so the spurious "to capture" clears (F6).

Explicit `settings.rootPath` still wins (no discovery override) — the user's deliberate choice
is honored.

New pure helper `discoverStoreRoot(candidates: string[], hasStore: (root) => Promise<boolean>): Promise<string | null>`
(returns the first candidate with a store), unit-tested; `resolveRootPath` composes it.

## ② Suppress Leftover when the device has no groups (fixes F1)

"Leftover" means "store files that belong to no current group". A device with no groups
(fresh / pre-adopt) has no baseline, so the whole store looks leftover — dangerous with
"Delete all". Fix in the view: load/show leftovers only when `this.groups.length > 0`
(`this.leftovers = this.groups.length > 0 ? await host.listLeftoverStoreFiles() : []`). After
Adopt populates the manifest, the leftover view works normally.

## ③ Adopt result strip survives reload (fixes F4)

The last-run strip (`lastRun` + its `expanded` flag) moves from a per-view-instance field to
module-level session state (the pattern already used for staging in 0.27.8), so it survives a
view reload/recreation — Adopt's "✓ Adopted · 1 item" strip now shows.

## ④ Post-adopt guidance (F5, and covers F6 by wording)

After a successful Adopt, a one-time guidance banner (variant A, mockup-approved) renders at
the top of the item view until dismissed or the device reaches sync (To apply == 0):

- Title: "Configuration adopted — now set up this device".
- Body: "Config Sync learned your {N} synced items. Apply the store to bring your settings and
  plugins onto this device."
- Caution (amber): "This device is new — its blank defaults differ from the store. Choose
  **Apply store** (store → device), not **Capture**, or you'll overwrite the store with this
  device's empty defaults. A few items differ both ways (e.g. app settings) — pick a direction
  per item; on a new device that's usually Apply store, except keep your own for Config Sync's
  settings."
- Actions: `↓ Review what to apply` (sets the filter to "To apply" and focuses the list — no
  auto-select, no auto-run) · `Not now` (dismiss).
- Dismissed via the ✕ / "Not now", or auto-hidden once To apply reaches 0.

A session flag (`adoptGuidancePending`) is set when Adopt runs and cleared on dismiss / when
To apply hits 0. The to-capture divergent items are intentionally NOT auto-flipped: the set
mixes "fresh defaults to apply over" with Config Sync's own data.json (which must stay local —
flipping it re-breaks the store pointer, i.e. F3). The caution wording carries this.

## Testing

- Core/pure: `discoverStoreRoot` returns the first candidate with a store; none → null;
  `resolveRootPath` returns the discovered store for the auto case, the mode default when no
  store exists anywhere, and the explicit path verbatim when set.
- View: leftover pill/section hidden when groups is empty, shown when groups exist; last-run
  strip persists across reload; guidance banner shows after adopt with the caution, hides on
  dismiss / To-apply-0; "Review what to apply" switches the filter.
- Live dev-vault: fabricate the scenario — store at `0-Extra/config-sync`, PKM auto/default —
  and confirm the Adopt banner appears without manual store-folder setup; adopt → guidance
  banner + result strip; leftover pill absent pre-adopt; post-adopt the config files compare
  against the real store (no phantom "nothing in the store").
- Gates: npm test, lint 67-warning baseline, no hardcoded colors.

## Non-goals

Auto-deciding the direction of bidirectionally-divergent items on a fresh device (unreliable;
Config Sync's own settings must stay local). Auto-applying the whole store on adopt (adopt
stays manifest-only; the user applies deliberately). Full-vault scanning for stray stores
(only the known candidate roots are probed).
