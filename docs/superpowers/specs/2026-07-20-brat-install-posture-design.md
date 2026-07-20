# BRAT install posture — use the install path, not the update path

## Problem

Installing a BRAT-managed plugin (e.g. IOTO Update) from the Sync Center **fails
on mobile** with `BRAT could not install … — see BRAT's log for the reason`. The
BRAT mobile log gives the real cause:

```
MOBILE  Error updating plugin shawndotty/ioto-update: JSON Parse error: Unexpected EOF
```

`installViaBrat` (`src/main.ts:802`) calls BRAT's `addPlugin` with
`updatePluginFiles = true` (2nd arg) — BRAT's **"update" path** ("Error *updating*
plugin"). On mobile a fetch inside that path returns an empty/truncated body, so
BRAT's `JSON.parse` throws "Unexpected EOF" and the install fails. On **desktop**
the same path succeeds (the network returns a complete response), which is why the
desktop cannot reproduce this — both BRAT paths work there.

The user's **manual** BRAT install succeeds on mobile. The manual UI uses BRAT's
**"install" path** — `updatePluginFiles = false`, `forceReinstall = true` (from
BRAT's own source: `addPlugin(repo, false, false, false, version, true, …)`). That
path does not hit the failing fetch on mobile.

So the two invocations differ only in those two flags, and config-sync is on the
one that breaks on mobile.

## Fix

Match config-sync's `addPlugin` call to the proven-working manual install path:
flip `updatePluginFiles` to `false` and `forceReinstall` to `true`.

`src/main.ts:802`, inside the `withTimeout(...)`:

```ts
// current
addPlugin(repo, true, false, false, "", false, false, "")
// →
addPlugin(repo, false, false, false, "", true, false, "")
```

Positionally: `addPlugin(repositoryPath, updatePluginFiles, seeIfUpdatedOnly,
reportIfNotUpdated, specifyVersion, forceReinstall, enableAfterInstall,
secretName)`. Only `updatePluginFiles` (`true → false`) and `forceReinstall`
(`false → true`) change. `specifyVersion` stays `""` (latest — matches the manual
"Latest version" install, and avoids a pinned-tag-missing failure), `enableAfterInstall`
stays `false` (config-sync's On-apply owns enabling), `secretName` stays `""`.

`forceReinstall = true` also preserves the idempotency the old `updatePluginFiles = true`
was reaching for: it re-downloads and overwrites even when the version matches, so
the existing `retry`/`withTimeout` wrapper stays correct.

Update the comment above the call to explain the install-vs-update-path reasoning
(replacing the "addPlugin re-downloads and rewrites files" note, which described the
old intent).

## Scope

- **This is a one-call change.** No new files, no data-model change.
- The failure is **mobile-only and cannot be validated on desktop** (both BRAT
  paths work on desktop). Confirmation is the user's phone.
- **Desktop regression guard:** on the dev vault, exercise BRAT's `addPlugin` with
  the new args on a fresh (uninstalled) BRAT plugin and confirm it still installs
  on desktop — the new args must not break the path that already works there. (The
  manual UI uses these same args on desktop, so this is expected to pass.)

## Non-goals / deferred

- **Direct downloader (plan C):** if the args fix still fails on mobile — e.g. the
  30s `withTimeout` also bites on a slow mobile connection, or the install path has
  its own mobile issue — fall back to a config-sync-owned downloader that fetches
  `releases/latest/download/{manifest.json,main.js,styles.css}` via `requestUrl`
  (the same mobile-proven primitives as the community-catalog installer), bypassing
  BRAT and `api.github.com` entirely. Verified reachable (200 following redirect).
  Not built this round — gated on the mobile result of this fix.
- Version pinning to the store lock's recorded version; private-repo `secretName`.
  Both deferred with the downloader.
