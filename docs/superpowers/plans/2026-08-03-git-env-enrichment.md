# Git subprocess environment enrichment — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Git credential helpers installed under `/usr/local/bin` or `/opt/homebrew/bin` become reachable from the git subprocess Config Sync spawns, so authenticated https remotes work from Obsidian the way they do from a terminal.

**Architecture:** One exported pure function `gitEnv(base, platform)` in `src/external/gitSource.ts`; the existing `git()` funnel passes its result as `env`, so all call sites inherit. One new pure test file.

**Tech Stack:** Obsidian plugin, TypeScript, esbuild, Vitest.

**Spec:** docs/superpowers/specs/2026-08-03-git-env-enrichment-design.md

## Global Constraints

- **NO COMMITS.** Working tree is the review state; one commit at cut.
- Do NOT set `GIT_SSH_COMMAND` or any ssh-related variable (spec Non-goal: it would override a user's `core.sshCommand`).
- No settings knob, no PAT auth, no `GCM_INTERACTIVE` (spec Non-goals / watch items).
- PATH is only modified when `platform !== "win32"`; the two appended dirs are exactly `/usr/local/bin` and `/opt/homebrew/bin`, in that order, deduplicated against the existing PATH.
- Gates: `npm run build` clean, `npm test` green (819 baseline + 5 new = 824), `npm run lint` 0 errors and no new warnings vs the 57-warning baseline.
- Match existing file style; comments in English; no Claude/AI attribution anywhere.

---

### Task 1: `gitEnv` + wiring + tests

**Files:**
- Modify: `src/external/gitSource.ts` (~lines 10-21: constants + `git()`)
- Create: `tests/gitEnv.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (single-task plan).
- Produces: `export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv`.

- [ ] **Step 1: Write the failing test**

Create `tests/gitEnv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gitEnv } from "../src/external/gitSource";

describe("gitEnv", () => {
  it("appends the helper dirs to PATH on darwin", () => {
    const env = gitEnv({ PATH: "/usr/bin:/bin" }, "darwin");
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
  });

  it("does not duplicate a dir already on PATH", () => {
    const env = gitEnv({ PATH: "/opt/homebrew/bin:/usr/bin" }, "darwin");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
  });

  it("leaves PATH untouched on win32", () => {
    const env = gitEnv({ PATH: "C:\\Windows;C:\\Git\\bin" }, "win32");
    expect(env.PATH).toBe("C:\\Windows;C:\\Git\\bin");
  });

  it("builds PATH from the helper dirs alone when the base has none", () => {
    const env = gitEnv({}, "linux");
    expect(env.PATH).toBe("/usr/local/bin:/opt/homebrew/bin");
  });

  it("always disables terminal prompts and never mutates the base", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    expect(gitEnv(base, "darwin").GIT_TERMINAL_PROMPT).toBe("0");
    expect(gitEnv(base, "win32").GIT_TERMINAL_PROMPT).toBe("0");
    expect(base.PATH).toBe("/usr/bin");
    expect(base.GIT_TERMINAL_PROMPT).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — expected to FAIL**

Run: `npx vitest run tests/gitEnv.test.ts`
Expected: FAIL — `gitEnv` is not exported.

- [ ] **Step 3: Implement `gitEnv` and wire it into `git()`**

In `src/external/gitSource.ts`, directly below the line `const GIT_TIMEOUT_MS = 60_000;`, add:

```ts
const EXTRA_PATH_DIRS = ["/usr/local/bin", "/opt/homebrew/bin"];

// GUI apps on macOS (and some Linux desktops) inherit a bare launchd PATH that misses the
// dirs where git credential helpers usually live; git then can't run the configured helper
// and every authenticated https call dies on "terminal prompts disabled". Windows GUI
// processes inherit the user PATH (";"-separated) — leave it untouched there.
export function gitEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: "0" };
  if (platform === "win32") return env;
  const parts = (base.PATH ?? "").split(":").filter(Boolean);
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(":");
  return env;
}
```

Then in `git()`, replace:

```ts
      // Never let git block on an interactive credential prompt; fail fast instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
```

with:

```ts
      // Fail fast on credential prompts; make helpers outside the GUI PATH reachable.
      env: gitEnv(process.env, process.platform),
```

Nothing else in `git()` changes (timeout, maxBuffer, error shaping stay as they are).

- [ ] **Step 4: Run the new test — expected to PASS**

Run: `npx vitest run tests/gitEnv.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: Gates**

Run: `npm run build && npm test && npm run lint`
Expected: build clean; 824 tests pass; lint 0 errors, warning count unchanged (57).

- [ ] **Step 6: Leave uncommitted** (NO-COMMITS mode)

---

## Final verification (controller, after the task)

- Task review (single task, whole-change lens: spec coverage, Non-goals untouched — grep the diff for `GIT_SSH` must find nothing).
- Live verify in the dev vault on this machine (gitconfig has `credential.helper = manager`, helper at `/usr/local/bin/git-credential-manager`): Test connection against an authenticated https remote succeeds (or hands off to the helper's own auth flow) instead of failing with `'credential-manager' is not a git command`; an ssh URL fails fast into the auth card, no 60s hang.
