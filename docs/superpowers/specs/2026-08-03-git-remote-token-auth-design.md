# Git Remote Access Token — Design

Date: 2026-08-03 · Target release: 2.13.0

## Problem

Git remotes authenticate through whatever credential chain the host machine's git happens to have. A real incident showed how fragile that is: on macOS with `credential.helper = manager`, git-credential-manager has no OAuth support for self-hosted GitLab hosts and cannot see credentials stored by other helpers, so it pops an interactive GUI window. From a background plugin process that window is either invisible or gets wrong input, ending in `HTTP Basic: Access denied` — or a blind wait until the 60s timeout. Fixing it requires per-host gitconfig surgery on every device.

The plugin should be able to authenticate https git remotes **by itself**, with a token the user pastes once per device, independent of the machine's git credential configuration.

## Decisions (user-approved)

- Optional username alongside the token. This reverses the brainstorm's "token only" call: measured against the owner's self-hosted GitLab with one credential, `username=token` and `username=oauth2` are both denied while the account's own name succeeds — that host validates the username, so a fixed constant would make the feature useless exactly where it was needed. The field stays optional and defaults to the literal `token`, which PAT-only hosts (GitHub, GitLab.com) ignore.
- Secrets live in Obsidian's keychain (`app.secretStorage`), never in `data.json`. Config Sync syncs `data.json` itself — a token there would be pushed to remotes and synced across devices.
- Bundled fix: background git always runs with `GCM_INTERACTIVE=never` so a misconfigured credential helper fails fast instead of prompting.
- `minAppVersion` bumps 1.8.7 → **1.11.4** (first version with `SecretStorage`). No runtime feature detection, no legacy fallback.
- UI mockup 定稿 (three states + error copy): artifact `token-field-v2-no-legacy`; the copy in the mockup is final.

## Data model

`src/core/types.ts:88` — the git variant of `Remote` gains an optional pointer:

```ts
| { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean; tokenId?: string; username?: string };
```

- `tokenId` is the NAME of a keychain secret, chosen by the user through Obsidian's own secret picker (see "Settings UI"). The token itself sits in `app.secretStorage` under that name; `data.json` holds the name alone.
- Where the name does and does not travel: the remotes list is a **locked device-local field** in Config Sync's own self-sync preset (`selfPresetRules`, `scope: "local"`), so Config Sync never sends it to a store or a remote. It reaches another device only when the user's own vault sync copies the plugin's `data.json`. Either way the secret stays put, and a device without it reports an explicit, actionable error rather than falling back.
- Not derived from the remote's `name`, so renaming a remote never orphans the secret.
- `username` is optional and carries no secret. Absent means the literal `token` is sent, which PAT-only hosts ignore.
- Validation in `src/core/manifest.ts` `parseRemote`: `tokenId` must match `/^[a-z0-9-]+$/`, be at most 64 characters (Obsidian's own limit), and must not be Config Sync's vault-passphrase secret; `username` must be non-empty with no whitespace or control characters, since it is written into the line-based credential protocol. Errors follow the existing message style.

## Secret storage semantics

The plugin never writes the keychain. Obsidian's picker creates, edits and deletes secrets; unlinking clears only the remote's pointer, leaving the secret reusable under Settings → Keychain. Reads go through `resolveGitToken`, which treats an empty value as absent and refuses a value carrying a line break or surrounding whitespace — both would corrupt the credential protocol rather than fail cleanly.

## git injection — `src/external/gitSource.ts`

All three entry points take an explicit `auth: GitAuth | null` (no default parameters), where `GitAuth = { username: string; token: string }` lives in `src/core/types.ts` — deliberately not in `gitSource.ts`, so `gitToken.ts` (statically imported by `main.ts`) cannot drag Node built-ins into the mobile bundle:

```ts
gitLsRemote(remoteUrl: string, branch: string, auth: GitAuth | null)
createGitReader(vaultBasePath: string, remoteUrl: string, branch: string, subdir: string, auth: GitAuth | null)
createGitWriter(remoteUrl: string, branch: string, subdir: string, auth: GitAuth | null)
```

They thread it to the internal funnel `git(cwd, args, auth)`:

- `auth === null` → behavior identical to today (system credential chain).
- `auth` present → prepend to args:
  1. `-c credential.helper=` — clears the configured helper list; GCM, osxkeychain, gh are all out of the loop.
  2. `-c credential.helper=!f() { printf '%s\n' "username=$CONFIG_SYNC_GIT_USER" "password=$CONFIG_SYNC_GIT_TOKEN"; }; f` — an inline helper that reads both fields from the environment. Neither ever appears in process arguments (`ps` clean); `!`-helpers run through git's bundled `sh`, which Git for Windows also ships. `printf`, not `echo`: `sh`'s `echo` expands backslash escapes, which silently mangles a username like `CORP\alice` and truncates a token containing a backslash.

`gitEnv(base, platform, auth)` grows the third explicit parameter and two behaviors:

- always sets `GCM_INTERACTIVE: "never"` (bundled fix — a credential-manager consulted on the no-token path fails fast instead of opening a GUI window);
- sets `CONFIG_SYNC_GIT_USER` and `CONFIG_SYNC_GIT_TOKEN` when `auth` is non-null.

Local-only git calls inside reader/writer (ls-tree, show, add, commit…) receive the same auth; the helper is only consulted on authenticated http(s) transport, so this is harmless and keeps the funnel single-shaped.

## Token resolution — new `src/external/gitToken.ts`

Small module so `gitSource.ts` stays Obsidian-free:

```ts
export function resolveGitToken(storage: SecretStorage, remote: Remote): GitAuth | null;
```

`resolveGitToken`:
- remote is not git, or has no `tokenId` → `null` (system chain).
- `getSecret(tokenId)` is `null` or `""` → throw `Error` with the final copy: `No access token stored on this device for remote "<name>" — link it once in Settings → Remotes.`
- the secret carries a line break or surrounding whitespace → throw (it would forge credential-protocol lines or authenticate with invisible padding).
- otherwise `{ username: remote.username ?? "token", token: secret }`.

Callers pass `this.app.secretStorage`. Errors surface through the existing channels (compare error card, push/pull notices, Test connection error strip) — no new UI component.

## Call sites

- `src/main.ts:1187` reader factory and `:1198` writer factory: resolve via `resolveGitToken(this.app.secretStorage, remote)` and pass through.
- `src/ui/SettingTab.ts:2704` Test connection: resolve from the draft's `tokenId` the same way; a resolution error renders in the error strip as `✗ <message>` instead of contacting the remote. Because pasting stores immediately, Test connection always sees the freshest token.

## Settings UI — `renderRemoteForm` (git branch)

One new form line below URL/Branch/Store folder, for **every** git remote (the URL field is live-edited without re-render, so scheme-based show/hide would go stale; the copy scopes it to https instead). Mockup copy is final (artifact `token-field-v4-native-link`).

The control is Obsidian's own `SecretComponent`, and its actual contract — established by decompiling `obsidian.asar`, not by the `.d.ts`, which is misleading here — decides the design: it renders **no text input**. It renders a button that opens Obsidian's keychain modal (a searchable picker when secrets exist, otherwise the create-secret form), shows a linked secret masked with click-to-reveal plus its own ✕ to unlink, and flips its button between `Link` and `Change`. `setValue(name)` takes the secret's NAME, and `onChange(cb)` reports the name the user picked — or `null` on unlink. The plugin therefore never reads or writes a secret value in the settings UI at all.

- `tokenC.setValue(draft.tokenId)` at render; `onChange(name => { draft.tokenId = name ?? ""; saveRemotes(); repaint status; })`.
- A status line below it, keyed on `tokenId` + a live `getSecret` probe:
  - **State 1 — no `tokenId`** (button reads `Link`), neutral: `For https URLs. Without a token, this device's own git sign-in is used. Stored in Obsidian's keychain — link it once per device.`
  - **State 2 — name set and this device holds it** (masked value + ✕ + `Change`), ok: `✓ Token stored on this device.`
  - **State 3 — name set, nothing under it here** (button reads `Link`), warning: `⚠ This remote uses a token named "<tokenId>", which this device doesn't have yet — link it here once.` Naming the secret lets the user create it under the same name so every device's pointer agrees.
- Unlinking clears only the pointer; the secret stays in Obsidian's keychain, manageable and reusable under Settings → Keychain. Nothing in this plugin ever calls `setSecret`.

Draft plumbing: `RemoteDraft` gains `tokenId: string` (`""` = absent), mapped in `toDraft`/`toCandidate` following the `subdir` pattern.

## Bundled fix

`GCM_INTERACTIVE=never` in `gitEnv` unconditionally (see git injection). Closes the confirmed watch item: no-token devices hitting git-credential-manager get an immediate error card instead of a GUI prompt plus a 60-second blind wait.

## Manifest

`manifest.json` `minAppVersion`: `1.8.7` → `1.11.4`. `versions.json` picks the new floor up at the version bump (existing release script behavior).

## Testing

Unit (Node suite, currently 824):
- `gitEnv`: `GCM_INTERACTIVE` always set; `CONFIG_SYNC_GIT_TOKEN` present exactly when token non-null; existing five cases updated to the new signature.
- git arg construction: with token, args start with the two `-c credential.helper` entries (exact strings); without, args unchanged. Export the pure builder if needed for direct testing.
- `resolveGitToken`: null for vault remote / git without tokenId; throws the exact copy when the secret is missing or empty; returns the token when present (fake storage — a plain `{ getSecret }` stub, no framework mocks).
- `classifyRemoteFailure`: the resolve failure classifies as `"no-token"`, and the pre-existing auth/timeout/other cases still classify as before.
- `parseRemote`: accepts and round-trips `tokenId`; rejects malformed ids with `ManifestValidationError`.

UI three-state rendering and SecretComponent wiring are verified live, not unit-mocked.

Live verification (a vault with a real https git remote):
1. Press **Link**, create a keychain secret holding a GitLab PAT → status flips to `✓ Token stored on this device.` and Test connection turns `✓ Reachable — branch main found`, with the machine's GCM config untouched.
2. Compare/pull through Sync Center succeeds.
3. Unlink → Test connection fails fast with GCM's error text and no GUI popup, proving `GCM_INTERACTIVE=never`; the compare card shows the `no-token` copy rather than "Show Git output".

## Non-goals

- ssh authentication (keys/agent; unaffected by tokens).
- OAuth flows; host-scoping the injected helper (it answers for whatever host git asks about, which matters only for a URL the user configured that redirects elsewhere).
- Migrating existing system-chain credentials into the keychain.
- A settings knob for extra PATH dirs (unchanged 2.12.1 backlog item).
