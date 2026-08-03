# Partial clone + remote-form polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix git compare/pull/push timeouts on large host repos via blobless+shallow partial clone, and polish the git remote form (required-field marking, token-row alignment).

**Architecture:** `src/external/gitSource.ts` gains a pure `buildCloneArgs` helper and switches the reader fetch and writer clone to partial+shallow transfers so only the store subdir's data moves. `src/ui/SettingTab.ts` gains a `markRequired` label helper and wraps the SecretComponent in a single-line control div; `styles.css` re-lays the token row as a 2-column grid.

**Tech Stack:** TypeScript, esbuild, Vitest, Obsidian plugin API, git CLI (partial clone: `--depth=1 --filter=blob:none --sparse`).

## Global Constraints

- **NO-COMMITS mode.** Leave every change uncommitted — the working tree is the reviewer's state. Do NOT run `git commit` in any task. The single release commit happens later, at cut, by the controller.
- **No Claude/AI attribution** in any file, comment, or (eventual) commit text.
- **Target 2.13.1 (patch).** Do NOT touch `manifest.json`, `versions.json`, or `package.json` — version bump happens at cut. `minAppVersion` stays `1.11.4`.
- **Token hard rule.** A token value must never reach process arguments, logs, error messages, `data.json`, or the store — only the NAME of a keychain secret persists. The #4 git-arg changes MUST keep the existing `TOKEN_CREDENTIAL_ARGS` + `gitEnv` plumbing; never place a token on a command line.
- **Copy is final** from the mockup (artifact "Remote form — 2.13.1 定稿"). Do not reword labels beyond what this plan specifies.
- **Functional style, no flag parameters that switch logic.** `buildCloneArgs` takes data (subdir string), not a mode flag.
- **Gates green before hand-off:** `npm run build`, `npm test`, `npm run lint` (zero-warning baseline).

---

### Task 1: Partial-clone transport (#4)

**Files:**
- Modify: `src/external/gitSource.ts` (add `buildCloneArgs`; reader fetch at `:109`; writer clone at `:141`)
- Test: `tests/gitSource.test.ts` (append a `buildCloneArgs` describe block)

**Interfaces:**
- Consumes: existing `git(cwd, args, auth)` runner, `REMOTE_NAME` constant, `TOKEN_CREDENTIAL_ARGS`/`gitEnv` (unchanged).
- Produces: `export function buildCloneArgs(branch: string, remoteUrl: string, subdir: string): string[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/gitSource.test.ts`:

```ts
import { buildCloneArgs } from "../src/external/gitSource";

describe("buildCloneArgs", () => {
  it("omits --sparse when the store is at repo root (subdir empty)", () => {
    expect(buildCloneArgs("main", "git@h:me/c.git", "")).toEqual([
      "clone", "--depth=1", "--filter=blob:none", "--branch", "main", "git@h:me/c.git", ".",
    ]);
  });
  it("adds --sparse when a subdir is given", () => {
    expect(buildCloneArgs("main", "git@h:me/c.git", "0-Extra/config-sync")).toEqual([
      "clone", "--depth=1", "--filter=blob:none", "--sparse", "--branch", "main", "git@h:me/c.git", ".",
    ]);
  });
});
```

Keep the existing `import { classifyLsRemote } from "../src/external/gitSource";` line as-is; add `buildCloneArgs` to a separate import or merge into one import from the same module.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/gitSource.test.ts`
Expected: FAIL — `buildCloneArgs is not a function` / no matching export.

- [ ] **Step 3: Implement `buildCloneArgs`**

In `src/external/gitSource.ts`, add above `createGitWriter` (near the other exported helpers):

```ts
// A blobless, shallow clone moves only the commit + trees; blobs arrive lazily on checkout.
// With a subdir, --sparse limits the working tree to that folder (set via sparse-checkout);
// at repo root the whole tree is the store, so --sparse is omitted.
export function buildCloneArgs(branch: string, remoteUrl: string, subdir: string): string[] {
  const args = ["clone", "--depth=1", "--filter=blob:none"];
  if (subdir !== "") args.push("--sparse");
  args.push("--branch", branch, remoteUrl, ".");
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/gitSource.test.ts`
Expected: PASS (both new cases + the existing `classifyLsRemote` cases).

- [ ] **Step 5: Wire the reader fetch (blobless + shallow)**

In `createGitReader`, change the fetch line (`:109`):

```ts
// was: await git(vaultBasePath, ["fetch", REMOTE_NAME, branch], auth);
await git(vaultBasePath, ["fetch", "--depth=1", "--filter=blob:none", REMOTE_NAME, branch], auth);
```

Leave the `ls-tree` and `git show FETCH_HEAD:${prefix}${relPath}` lines unchanged — the filtered fetch auto-marks the remote a promisor and `show` lazily fetches each blob (those `git` calls already pass `auth`).

- [ ] **Step 6: Wire the writer clone (partial + shallow + sparse)**

In `createGitWriter`, replace the clone line (`:141`):

```ts
// was: await git(dir, ["clone", "--branch", branch, remoteUrl, "."], auth);
await git(dir, buildCloneArgs(branch, remoteUrl, subdir), auth);
if (subdir !== "") await git(dir, ["sparse-checkout", "set", subdir], auth);
```

Leave `base`, `walkFs`, read/write/delete, `add -A`, commit, and `push origin branch` unchanged.

- [ ] **Step 7: Run the full gate**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, all tests pass, lint silent (zero warnings). Do NOT commit.

---

### Task 2: Required marking + drop "(optional)" (#1)

**Files:**
- Modify: `src/ui/SettingTab.ts` (add `markRequired`; `renderRemoteForm` call sites for Name `:2658`, Store path `:2670`, URL `:2688`, Branch `:2693`; label text at `:2698/:2708/:2710`)
- Modify: `styles.css` (add `.config-sync-required`)

**Interfaces:**
- Consumes: the existing `private formField(parent, label)` (`:2457-2461`) and its `field` binding inside `renderRemoteForm`.
- Produces: `private markRequired(field: HTMLElement): void`.

No unit test: these are static labels and DOM wiring. The repo's test strategy does not unit-test static text or DOM label content; verification is build + lint + live check. Do not add a mock-based test.

- [ ] **Step 1: Add the `markRequired` helper**

In `src/ui/SettingTab.ts`, next to `formField`:

```ts
private markRequired(field: HTMLElement): void {
  field.querySelector<HTMLElement>("label")?.createSpan({ cls: "config-sync-required", text: "*" });
}
```

- [ ] **Step 2: Mark the four required fields**

Name (`:2658`) — capture the field, mark it, then build the component:

```ts
const nameField = field(line1, "Name");
this.markRequired(nameField);
const nameC = new TextComponent(nameField);
```

Store path (vault, `:2670-2671`) — the field is already captured as `pathField`; add after it:

```ts
const pathField = field(line2, "Store path");
this.markRequired(pathField);
const pathC = new TextComponent(pathField);
```

URL (`:2688`) — capture, mark, then build:

```ts
const urlField = field(line2, "URL");
this.markRequired(urlField);
new TextComponent(urlField).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
  draft.url = v.trim();
  clearStrip();
  void this.saveRemotes();
});
```

Branch (`:2693`) — capture, mark, then build:

```ts
const branchField = field(line2, "Branch");
this.markRequired(branchField);
new TextComponent(branchField).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
  draft.branch = v.trim();
  clearStrip();
  void this.saveRemotes();
});
```

- [ ] **Step 3: Drop the "(optional)" text from three labels**

- `:2698` — `field(line2, "Store folder in repo (optional)")` → `field(line2, "Store folder in repo")`
- `:2708` — `field(tokenLine, "Access token (optional)")` → `field(tokenLine, "Access token")`
- `:2710` — `field(tokenLine, "Username (optional)")` → `field(tokenLine, "Username")`

- [ ] **Step 4: Add the required-marker CSS**

Append to `styles.css`:

```css
.config-sync-required {
  color: var(--color-red);
  margin-left: 2px;
}
```

- [ ] **Step 5: Build + lint**

Run: `npm run build && npm run lint`
Expected: build clean, lint silent. Do NOT commit.

---

### Task 3: Token-row alignment (#3)

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderRemoteForm` token field, `:2708-2709`)
- Modify: `styles.css` (replace `.config-sync-remote-token` block `:338-342`; add `.config-sync-secret-control`; add phone override near `:387`)

**Interfaces:**
- Consumes: the `tokenLine` div, the `field` binding, `SecretComponent` from `obsidian`. Label at `:2708` is already `"Access token"` after Task 2.
- Produces: DOM class `config-sync-secret-control` wrapping the SecretComponent.

No unit test: CSS + DOM layout. Verification is build + live check against the mockup. Do not add a mock-based test.

- [ ] **Step 1: Wrap the SecretComponent in a single-line control div**

In `renderRemoteForm` (`:2708-2709`), change:

```ts
const tokenField = field(tokenLine, "Access token");
const tokenControl = tokenField.createDiv({ cls: "config-sync-secret-control" });
const tokenC = new SecretComponent(this.app, tokenControl);
```

Leave the rest of the token block (`paintTokenStatus`, `tokenC.setValue`, `tokenC.onChange`) unchanged.

- [ ] **Step 2: Replace the token-row CSS with the grid layout**

In `styles.css`, replace the `.config-sync-remote-token` block (`:338-342`) with:

```css
.config-sync-remote-token {
  display: grid;
  grid-template-columns: 1fr 12em;
  gap: var(--size-4-3);
  margin-top: var(--size-4-3);
}

.config-sync-remote-token > div {
  display: flex;
  flex-direction: column;
}

/* token control and username input share a bottom baseline even if a label wraps */
.config-sync-secret-control,
.config-sync-remote-token > div input {
  margin-top: auto;
}

.config-sync-secret-control {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
```

- [ ] **Step 3: Add the phone override**

In `styles.css`, beside the existing `body.is-phone .config-sync-remote-git` rule (`:387`), add:

```css
body.is-phone .config-sync-remote-token {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 4: Build + lint**

Run: `npm run build && npm run lint`
Expected: build clean, lint silent. Do NOT commit.

- [ ] **Step 5: Live verify against the mockup**

In the dev vault, open Settings → Config Sync → Remotes, expand a git remote:
- token control is one line (masked value + Change button inline), baseline-aligned with the Username input;
- the token row is spaced away from the URL/Branch row (not glued);
- required `*` shows on Name, URL, Branch (and Store path for a vault remote); no "(optional)" text anywhere.
Matches the mockup. (Live verification is the user's step; note it in the report if not run here.)

---

## Post-implementation (not a task — for the cut)

Live-verify #4 against the real ~1 GB homelab remote: compare and Pull complete within 60 s, Push succeeds, subdir and repo-root store paths both work, and obsidian-git still commits/pushes the vault after a compare (no `.git/shallow` fallout). This is a live check owed before cut, not code.
