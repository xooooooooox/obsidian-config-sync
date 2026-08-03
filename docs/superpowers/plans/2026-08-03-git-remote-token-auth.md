# Git Remote Access Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-remote access token for https git remotes, stored in Obsidian's keychain, injected into git via environment — independent of the machine's git credential chain.

**Architecture:** `Remote` gains a `tokenId` pointer (synced in data.json); the secret lives in `app.secretStorage` per device. `gitSource.ts` entry points take an explicit `token: string | null`; with a token, git runs with the system helper list cleared and an inline env-reading helper. New `src/external/gitToken.ts` resolves pointer → secret with an actionable error. Settings UI adds a three-state token field. Bundled: `GCM_INTERACTIVE=never` always.

**Tech Stack:** TypeScript, Obsidian API (`SecretStorage`, `SecretComponent`), vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-git-remote-token-auth-design.md` (UI copy is final — mockup 定稿).

## Global Constraints

- **NO-COMMITS mode:** never run `git commit`. The working tree is the review state; one commit happens at cut, by the controller. Task steps end at test/build gates, not commits.
- Gates after every task: `npm run build` (clean), `npm test` (all pass; suite is 824 before this plan), `npm run lint` (baseline 0 errors / 57 warnings — no new findings of either kind).
- No default parameter values — every new parameter is explicit at every call site.
- All user-facing copy verbatim from this plan (it matches the approved mockup). Do not rephrase.
- Error style: `ManifestValidationError` messages state what is wrong and show an example, matching neighbors in `parseRemote`.
- CSS: colors only via Obsidian variables (`var(--color-green)` etc.) — `scripts/check-no-hardcoded-color.sh` enforces this.
- The token value must never appear in process arguments, log strings, or error messages — it travels only via the `CONFIG_SYNC_GIT_TOKEN` environment variable.

---

### Task 1: gitSource token plumbing + GCM_INTERACTIVE=never

**Files:**
- Modify: `src/external/gitSource.ts`
- Modify: `tests/gitEnv.test.ts`
- Modify: `src/main.ts:1187`, `src/main.ts:1198`, `src/ui/SettingTab.ts:2704` (pass explicit `null` so every gate stays green; Tasks 3–4 replace the literals with real resolution)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact signatures):
  - `gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, token: string | null): NodeJS.ProcessEnv`
  - `TOKEN_CREDENTIAL_ARGS: readonly string[]` (exported const)
  - `gitLsRemote(remoteUrl: string, branch: string, token: string | null): Promise<LsRemoteResult>`
  - `createGitReader(vaultBasePath: string, remoteUrl: string, branch: string, subdir: string, token: string | null): Promise<ExternalStoreReader>`
  - `createGitWriter(remoteUrl: string, branch: string, subdir: string, token: string | null): Promise<ExternalStoreWriter>`

- [ ] **Step 1: Update the five existing gitEnv tests to the three-arg signature and add the new failing tests**

In `tests/gitEnv.test.ts`, add `, null` as the third argument to every existing `gitEnv(...)` call (five tests), change the import line to also pull `TOKEN_CREDENTIAL_ARGS`, and append inside `describe("gitEnv", ...)`:

```ts
  it("always tells git-credential-manager to never prompt", () => {
    expect(gitEnv({}, "darwin", null).GCM_INTERACTIVE).toBe("never");
    expect(gitEnv({}, "win32", null).GCM_INTERACTIVE).toBe("never");
  });

  it("exposes the token to the inline helper via the environment only", () => {
    expect(gitEnv({}, "darwin", "glpat-abc").CONFIG_SYNC_GIT_TOKEN).toBe("glpat-abc");
    expect(gitEnv({}, "darwin", null).CONFIG_SYNC_GIT_TOKEN).toBeUndefined();
  });
```

And a sibling describe block below it:

```ts
describe("TOKEN_CREDENTIAL_ARGS", () => {
  it("clears the configured helper list, then injects the env-reading helper", () => {
    expect(TOKEN_CREDENTIAL_ARGS).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      'credential.helper=!f() { echo "username=token"; echo "password=$CONFIG_SYNC_GIT_TOKEN"; }; f',
    ]);
  });
});
```

- [ ] **Step 2: Run the test file — expect FAIL** (`npx vitest run tests/gitEnv.test.ts`): compile errors on the missing third parameter and missing export.

- [ ] **Step 3: Implement in `src/external/gitSource.ts`**

Replace `gitEnv` (keep the existing comment above it, extend it with the two new lines shown):

```ts
// GUI apps on macOS (and some Linux desktops) inherit a bare launchd PATH that misses the
// dirs where git credential helpers usually live; git then can't run the configured helper
// and every authenticated https call dies on "terminal prompts disabled". Windows GUI
// processes inherit the user PATH (";"-separated) — leave it untouched there.
// GCM_INTERACTIVE=never: a background process must never trigger a credential GUI — a
// misconfigured helper fails fast into the error card instead of an invisible prompt.
export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  if (token !== null) env.CONFIG_SYNC_GIT_TOKEN = token;
  if (platform === "win32") return env;
  const parts = (base.PATH ?? "").split(":").filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(":");
  return env;
}

// With a plugin-managed token the machine's credential chain is deliberately out of the
// loop: the first -c clears the configured helper list, the second injects an inline
// helper that reads the token from the environment — the secret never appears in process
// arguments. `!`-helpers run through git's bundled sh (Git for Windows ships one too).
export const TOKEN_CREDENTIAL_ARGS: readonly string[] = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { echo "username=token"; echo "password=$CONFIG_SYNC_GIT_TOKEN"; }; f',
];
```

Replace the `git` funnel (error text keeps the caller's `args`, so the helper strings never show up in error cards):

```ts
async function git(cwd: string, args: string[], token: string | null): Promise<string> {
  const fullArgs = token === null ? args : [...TOKEN_CREDENTIAL_ARGS, ...args];
  try {
    const { stdout } = await execFileP("git", fullArgs, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      // Fail fast on credential prompts; make helpers outside the GUI PATH reachable.
      env: gitEnv(process.env, process.platform, token),
    });
    return stdout;
  } catch (e) {
    const err = e as Error & { killed?: boolean };
    // execFile kills the child on timeout (killed=true); maxBuffer kills too but says so.
    const detail =
      err.killed === true && !err.message.includes("maxBuffer")
        ? `timed out after ${GIT_TIMEOUT_MS / 1000}s`
        : err.message;
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}
```

Thread the parameter through the three entry points — signatures:

```ts
export async function gitLsRemote(remoteUrl: string, branch: string, token: string | null): Promise<LsRemoteResult>
export async function createGitReader(vaultBasePath: string, remoteUrl: string, branch: string, subdir: string, token: string | null): Promise<ExternalStoreReader>
export async function createGitWriter(remoteUrl: string, branch: string, subdir: string, token: string | null): Promise<ExternalStoreWriter>
```

Every internal `git(...)` call gains `, token` as its last argument — including the local-only ones (`remote`, `remote set-url`, `remote add`, `fetch`, `ls-tree`, `show` in the reader; `clone`, `add -A`, `status --porcelain`, `commit`, `push` in the writer, and the `readFile` closure's `show`). The helper is only consulted on authenticated http(s) transport, so passing it everywhere keeps the funnel single-shaped.

- [ ] **Step 4: Keep the three call sites compiling with an explicit temporary `null`**

- `src/main.ts:1187` → `return createGitReader(adapter.getBasePath(), remote.url, remote.branch, remote.subdir ?? "", null);`
- `src/main.ts:1198` → `return createGitWriter(remote.url, remote.branch, remote.subdir ?? "", null);`
- `src/ui/SettingTab.ts:2704` → `const res = await gitLsRemote(draft.url, draft.branch, null);`

- [ ] **Step 5: Run the test file — expect PASS**, then the gates: `npm run build`, `npm test`, `npm run lint`.

---

### Task 2: Data model — `tokenId` on Remote, validation, resolution module, draft plumbing

**Files:**
- Modify: `src/core/types.ts:88` (git variant of `Remote`)
- Modify: `src/core/manifest.ts` (`parseRemote`)
- Create: `src/external/gitToken.ts`
- Modify: `src/ui/SettingTab.ts` (`RemoteDraft`, `toDraft`, `toCandidate` — lines 201–234)
- Modify: `manifest.json` (`minAppVersion` 1.8.7 → 1.11.4 — moved here from Task 3: the lint rule gates API use against minAppVersion, so `SecretStorage` cannot be referenced until the floor rises)
- Create: `tests/gitToken.test.ts`
- Modify: `tests/manifest.test.ts` (inside `describe("validateRemotes", ...)`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `Remote` git variant: `{ name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean; tokenId?: string }`
  - `newTokenId(): string` — `config-sync-git-token-<8 lowercase hex>`
  - `resolveGitToken(storage: Pick<SecretStorage, "getSecret">, remote: Remote): string | null` — throws on a configured-but-missing token
  - `RemoteDraft.tokenId: string` (`""` = absent)

- [ ] **Step 1: Write the failing tests**

Create `tests/gitToken.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newTokenId, resolveGitToken } from "../src/external/gitToken";
import { Remote } from "../src/core/types";

const store = (secrets: Record<string, string>) => ({
  getSecret: (id: string): string | null => (id in secrets ? secrets[id]! : null),
});

const gitRemote = (tokenId?: string): Remote => {
  const r: Remote = { name: "kickstart", type: "git", url: "https://h/r.git", branch: "main" };
  if (tokenId !== undefined) r.tokenId = tokenId;
  return r;
};

describe("newTokenId", () => {
  it("generates keychain-safe ids", () => {
    expect(newTokenId()).toMatch(/^config-sync-git-token-[0-9a-f]{8}$/);
  });

  it("generates distinct ids", () => {
    expect(newTokenId()).not.toBe(newTokenId());
  });
});

describe("resolveGitToken", () => {
  it("returns null for a vault remote", () => {
    expect(resolveGitToken(store({}), { name: "v", type: "vault", storePath: "/s" })).toBeNull();
  });

  it("returns null for a git remote without a token", () => {
    expect(resolveGitToken(store({}), gitRemote())).toBeNull();
  });

  it("returns the stored token", () => {
    expect(resolveGitToken(store({ "config-sync-git-token-aa11bb22": "glpat-x" }), gitRemote("config-sync-git-token-aa11bb22"))).toBe("glpat-x");
  });

  it("throws the actionable copy when this device has no token", () => {
    expect(() => resolveGitToken(store({}), gitRemote("config-sync-git-token-aa11bb22"))).toThrow(
      'No access token stored on this device for remote "kickstart" — paste it once in Settings → Remotes.'
    );
  });

  it("treats an emptied secret as absent (the keychain has no delete)", () => {
    expect(() => resolveGitToken(store({ "config-sync-git-token-aa11bb22": "" }), gitRemote("config-sync-git-token-aa11bb22"))).toThrow(
      "No access token stored on this device"
    );
  });
});
```

Append inside `describe("validateRemotes", ...)` in `tests/manifest.test.ts`:

```ts
  it("round-trips tokenId on git remotes", () => {
    const remotes = validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "config-sync-git-token-3f9a2c1b" }]);
    expect(remotes[0]).toEqual({ name: "b", type: "git", url: "u", branch: "main", tokenId: "config-sync-git-token-3f9a2c1b" });
  });

  it("rejects a malformed tokenId", () => {
    expect(() => validateRemotes([{ name: "b", type: "git", url: "u", branch: "main", tokenId: "Bad_Id!" }])).toThrow(
      "lowercase letters, digits, and dashes"
    );
  });
```

- [ ] **Step 2: Run both test files — expect FAIL** (`npx vitest run tests/gitToken.test.ts tests/manifest.test.ts`).

- [ ] **Step 3: Implement**

`src/core/types.ts:88` — replace the git variant line:

```ts
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; excludeSelf?: boolean; tokenId?: string }; // subdir: store folder inside the repo; absent = repo root. tokenId: pointer into app.secretStorage; the token itself never enters data.json
```

`src/core/manifest.ts` `parseRemote` — add `tokenId` to the destructuring line, then in the `type === "git"` branch, after the `subdir` validation and before `const remote: Remote = ...`:

```ts
    if (tokenId !== undefined && (typeof tokenId !== "string" || !/^[a-z0-9-]+$/.test(tokenId))) {
      throw new ManifestValidationError(`remote "${name}" has a "tokenId" that must be lowercase letters, digits, and dashes, e.g. "config-sync-git-token-3f9a2c1b"`);
    }
```

and after the `subdir` assignment line:

```ts
    if (typeof tokenId === "string") remote.tokenId = tokenId;
```

Create `src/external/gitToken.ts`:

```ts
import type { SecretStorage } from "obsidian";
import { Remote } from "../core/types";

// data.json carries only the tokenId pointer; the token itself lives in Obsidian's
// keychain (app.secretStorage) on each device. The id is random, not derived from the
// remote's name, so renaming a remote never orphans the secret.
export function newTokenId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `config-sync-git-token-${hex}`;
}

// The keychain has no delete — a removed token is stored as "", which reads as absent.
export function resolveGitToken(storage: Pick<SecretStorage, "getSecret">, remote: Remote): string | null {
  if (remote.type !== "git" || remote.tokenId === undefined) return null;
  const secret = storage.getSecret(remote.tokenId);
  if (secret === null || secret === "") {
    throw new Error(`No access token stored on this device for remote "${remote.name}" — paste it once in Settings → Remotes.`);
  }
  return secret;
}
```

`src/ui/SettingTab.ts` — `RemoteDraft` gains `tokenId: string;` after `subdir`; `toDraft` gains `tokenId: r.type === "git" ? (r.tokenId ?? "") : "",` after the `subdir` line; `toCandidate`'s git branch gains `if (d.tokenId !== "") c.tokenId = d.tokenId;` after the `subdir` line. Also add `tokenId: ""` to the `+ Add remote` object literal at `renderSources` (`this.sources.push({ name: "", type: "vault", storePath: "", url: "", branch: "", subdir: "", excludeSelf: false, tokenId: "" });`).

- [ ] **Step 4: Run both test files — expect PASS**, then the gates: `npm run build`, `npm test`, `npm run lint`.

---

### Task 3: Wire resolution into pull/push factories

**Files:**
- Modify: `src/main.ts` (imports; `createReader` :1187; `createWriter` :1198)

**Interfaces:**
- Consumes: `resolveGitToken` (Task 2), five-arg `createGitReader` / four-arg `createGitWriter` (Task 1).
- Produces: nothing new — behavior wiring only. A resolution error thrown here propagates through the existing compare error card / push-pull notice channels; do not add new handling.

- [ ] **Step 1: Implement**

`src/main.ts` — add to the top-of-file imports (gitToken has no Node dependencies, so a static import is mobile-safe, unlike gitSource):

```ts
import { resolveGitToken } from "./external/gitToken";
```

Replace the two temporary `null` literals from Task 1:

```ts
    return createGitReader(adapter.getBasePath(), remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
```

```ts
    return createGitWriter(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
```

(The `minAppVersion` bump moved to Task 2 — the lint rule gates `SecretStorage` use against it, so it had to land with the code that first calls the API. `version-bump.mjs` copies the floor into `versions.json` at cut; no manual edit there.)

- [ ] **Step 2: Gates** — `npm run build`, `npm test`, `npm run lint`. There is no unit test for this wiring (it is two argument substitutions verified by the compiler); live verification happens after the final task.

---

### Task 4: Settings UI — token field (three states) + Test connection resolution

**Files:**
- Modify: `src/ui/SettingTab.ts` (obsidian import line; `renderRemoteForm` git branch ~:2671–2719)
- Modify: `styles.css` (after the `.config-sync-test-strip.is-error` block, before `.config-sync-remote-selfline`)

**Interfaces:**
- Consumes: `newTokenId`, `resolveGitToken` (Task 2), three-arg `gitLsRemote` (Task 1), `RemoteDraft.tokenId` (Task 2).
- Produces: final UI. All copy below is 定稿 — verbatim.

- [ ] **Step 1: Implement the token field**

`src/ui/SettingTab.ts` — add `SecretComponent` to the `from "obsidian"` import list, and add:

```ts
import { newTokenId, resolveGitToken } from "../external/gitToken";
```

In `renderRemoteForm`'s git branch, directly after the `line2` block (the three `TextComponent`s) and before the `Platform.isDesktop` test-connection block, insert:

```ts
      // Token pointer lives in draft.tokenId (synced); the token itself sits in this
      // device's keychain. The input never echoes the stored secret back.
      const tokenLine = panel.createDiv({ cls: "config-sync-remote-token" });
      const tokenField = field(tokenLine, "Access token (optional)");
      const tokenC = new SecretComponent(this.app, tokenField);
      const storedSecret = draft.tokenId === "" ? null : this.app.secretStorage.getSecret(draft.tokenId);
      const stored = storedSecret !== null && storedSecret !== "";
      if (stored) {
        new ExtraButtonComponent(tokenLine)
          .setIcon("x")
          .setTooltip("Remove token")
          .onClick(async () => {
            // No delete in the keychain API: overwrite with "" and drop the pointer, so
            // every device reverts to its system git credentials once the config syncs.
            this.app.secretStorage.setSecret(draft.tokenId, "");
            draft.tokenId = "";
            await this.saveRemotes();
            this.refresh();
          });
      }
      const statusEl = panel.createDiv({
        cls: "config-sync-token-status" + (stored ? " is-ok" : draft.tokenId !== "" ? " is-warning" : ""),
      });
      statusEl.setText(
        stored
          ? "✓ Token stored on this device."
          : draft.tokenId !== ""
            ? "⚠ This remote uses a token, but this device doesn't have it yet — paste it here once."
            : "For https URLs. Without a token, this device's own git sign-in is used. Stored in Obsidian's keychain — paste once per device."
      );
      tokenC.onChange((v) => {
        const value = v.trim();
        if (value === "") return; // clearing typed characters never un-stores; removal is the ✕ button
        if (draft.tokenId === "") draft.tokenId = newTokenId();
        this.app.secretStorage.setSecret(draft.tokenId, value);
        void this.saveRemotes();
        statusEl.className = "config-sync-token-status is-ok";
        statusEl.setText("✓ Token stored on this device.");
      });
      const tokenInput = tokenField.querySelector("input");
      if (tokenInput !== null) {
        tokenInput.placeholder = stored ? "••••••••••••  (hidden — paste to replace)" : "Paste a personal access token…";
      }
```

- [ ] **Step 2: Wire Test connection to the stored token**

In the same method's test-connection click handler, replace the Task 1 line `const res = await gitLsRemote(draft.url, draft.branch, null);` and the import line above it with:

```ts
            const { gitLsRemote } = await import("../external/gitSource");
            let token: string | null;
            try {
              const candidate: Remote = { name: draft.name, type: "git", url: draft.url, branch: draft.branch };
              if (draft.tokenId !== "") candidate.tokenId = draft.tokenId;
              token = resolveGitToken(this.app.secretStorage, candidate);
            } catch (e) {
              strip!.className = "config-sync-test-strip is-error";
              strip!.setText(`✗ ${(e as Error).message}`);
              return;
            }
            const res = await gitLsRemote(draft.url, draft.branch, token);
```

(The `return` runs the existing `finally`, restoring the button. Pasting stores immediately, so Test connection always sees the freshest token.)

- [ ] **Step 3: styles.css** — insert after the `.config-sync-test-strip.is-error` rule:

```css
.config-sync-remote-token {
  display: flex;
  align-items: flex-end;
  gap: var(--size-4-2);
}

.config-sync-token-status {
  margin-top: var(--size-4-1);
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
}

.config-sync-token-status.is-ok {
  color: var(--color-green);
}

.config-sync-token-status.is-warning {
  color: var(--color-orange);
}
```

- [ ] **Step 4: Gates** — `npm run build`, `npm test`, `npm run lint`, `bash scripts/check-no-hardcoded-color.sh`. The three UI states and the `SecretComponent` DOM shape (the `querySelector("input")` placeholder hook) are verified live by the controller after this task, not unit-mocked. If `SecretComponent` renders no `<input>` element, report DONE_WITH_CONCERNS naming what it renders instead — do not invent a workaround.

---

### Task 5: Docs currency

**Files:**
- Modify: `docs/GUIDE.md` (Remotes section, line ~158)

**Interfaces:** none — prose only.

- [ ] **Step 1: Extend the Remotes paragraph**

In `docs/GUIDE.md`, the paragraph under `#### Remotes` currently ends with the excludeSelf sentence. Append one sentence to the same paragraph:

```
An https git remote can also hold an **access token** (a GitLab/GitHub personal access token): paste it once per device and Config Sync authenticates with it directly — no reliance on the machine's git sign-in; the token sits in Obsidian's keychain and never enters the synced settings.
```

- [ ] **Step 2: Check the other docs mention nothing stale**

Run `grep -rn "credential" README.md docs/GUIDE.md docs/ARCHITECTURE.md` — if any hit describes git auth as "uses your system git credentials" without qualification, extend it with "unless the remote holds an access token"; if there are no hits, done.

- [ ] **Step 3: Gates** — `npm test` (docs-only, but cheap insurance the tree is still green).

---

## Verification after all tasks (controller, live)

1. Build → copy `main.js`/`manifest.json`/`styles.css` into llm-wiki.vault's plugin dir (user's machine) → reload Obsidian.
2. Remotes settings: paste a gitlab.xozoz.com PAT into the kickstart remote → status flips to `✓ Token stored on this device.` → Test connection shows `✓ Reachable — branch main found` with the machine's GCM config untouched.
3. Sync Center compare/pull against the remote succeeds.
4. ✕ Remove token → Test connection now fails fast with GCM's own error text and no GUI popup (proves `GCM_INTERACTIVE=never`).
