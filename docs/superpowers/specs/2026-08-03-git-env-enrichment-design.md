# Git remotes: subprocess environment enrichment — design

Date: 2026-08-03
Baseline: 2.12.0 (unpublished draft; this change layers on its `git()` hardening).

## Context

On macOS, GUI apps launched from the Dock inherit the bare launchd `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`). A git credential helper installed under
`/usr/local/bin` or `/opt/homebrew/bin` — e.g. `credential.helper = manager`
(git-credential-manager) — is then not found by the git subprocess Config Sync spawns:

```
git: 'credential-manager' is not a git command.
fatal: could not read Username for 'https://<host>': terminal prompts disabled
```

git falls back to a terminal prompt, which `GIT_TERMINAL_PROMPT=0` (2.12.0) correctly
refuses — so every https operation against an authenticated remote fails, even though the
same URL works in a terminal. This makes git remotes effectively unusable on macOS for
anyone whose credentials live behind a helper outside the bare PATH.

Decision (user): fix the environment automatically (option A). No settings knob, no
in-plugin PAT auth for now.

## Scope

### 1. `gitEnv` — pure environment builder, `src/external/gitSource.ts`

New exported pure function:

```ts
gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv
```

- Returns a copy of `base` with `GIT_TERMINAL_PROMPT: "0"` (moved here from the inline
  object in `git()`).
- On every platform except `win32`: splits `base.PATH` on `":"` (missing/empty PATH is
  treated as no entries), appends each of `/usr/local/bin` and `/opt/homebrew/bin` unless
  already present, and joins back with `":"`. Windows GUI processes inherit the user PATH
  already and use `";"` separators — leave PATH untouched there.
- Never mutates `base`.

`git()` passes `env: gitEnv(process.env, process.platform)`. All 12 call sites (compare,
Test connection, clone, push, …) inherit through the single funnel.

### 2. When the helper becomes reachable

With the helper on PATH, stored credentials resolve silently. A helper with **no** stored
credential for the host may open its own GUI/browser auth flow — that is the user's
configured helper working as designed; completing it once caches the credential. The 60s
timeout from 2.12.0 still bounds the call. Live verify observes this; if helper popups
prove disruptive during batch compares, a follow-up may add `GCM_INTERACTIVE=never`
(recorded as a watch item, not built now).

## Non-goals

- **No `GIT_SSH_COMMAND`.** Setting it would override a user's `core.sshCommand`
  (custom identity files). Without a TTY, ssh password/host-key prompts already fail
  immediately rather than hang, and the existing classifier maps "permission denied" to
  the auth card. Live verify exercises an ssh URL; revisit only if a hang is observed.
- No "extra PATH" / "git binary path" setting (option B — add only if a real environment
  needs it).
- No in-plugin PAT authentication (option C — backlog: token in the OS keystore via
  Obsidian, BRAT precedent).
- No change to timeout, classifier, or error-card copy (all 2.12.0).

## Testing

- New `tests/gitEnv.test.ts` (pure, no subprocess):
  - darwin: appends both dirs to an existing PATH;
  - dedup: a dir already on PATH is not appended twice;
  - win32: PATH byte-identical to input;
  - missing PATH: result PATH is exactly the two dirs;
  - `GIT_TERMINAL_PROMPT === "0"` in every case; `base` not mutated.
- Existing suite stays green. Gates: `npm run build`, `npm test`, `npm run lint`
  (0 errors, no new warnings vs the 57-warning baseline).
- Live verify (dev vault, this machine — global gitconfig has `credential.helper =
  manager` with the helper at `/usr/local/bin/git-credential-manager`): Test connection
  against an authenticated https remote goes from the screenshot's
  `'credential-manager' is not a git command` failure to success (or to the helper's own
  auth flow); an ssh URL is exercised to confirm fail-fast + auth classification.

## Versioning

Cut as **2.12.1** (patch). Devices only benefit once the 2.12.0 → 2.12.1 chain is
published (2.11.0/2.12.0 are still drafts).
