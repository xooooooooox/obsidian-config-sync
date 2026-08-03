# Settings polish + git compare hardening — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three reported issues — git-row input misalignment in the Remotes tab, desktop tab bar collapsing to icon-only, and git remote compares that can hang forever on "comparing…" with unreadable errors.

**Architecture:** Two CSS/one-liner UI fixes (Tasks 1), then process-level git hardening plus a pure failure classifier (Task 2), then the Sync Center error card that consumes the classifier (Task 3).

**Tech Stack:** Obsidian plugin, TypeScript, esbuild, Vitest.

**Spec:** docs/superpowers/specs/2026-08-03-settings-polish-git-compare-design.md

## Global Constraints

- **NO COMMITS.** Working tree is the review state; one commit happens at cut. Every "commit" step in the usual template is replaced by "leave uncommitted".
- Copy is final (from the approved mockup) — use the exact strings in this plan verbatim; do not rephrase.
- Gates: `npm run build` clean, `npm test` green, `npm run lint` silent (zero-warning baseline).
- Match existing file style; comments in English; no Claude/AI attribution anywhere.
- Timeout constant: 60 000 ms. Env: `GIT_TERMINAL_PROMPT=0`. Timeout marker string: `timed out after 60s` (classifier matches on `timed out after`).

---

### Task 1: Remotes-row alignment + desktop icon-only tabs

**Files:**
- Modify: `styles.css` (git-row grid block near line 276; phone block near line 345; tab base styles near line 11-30)
- Modify: `src/ui/SettingTab.ts` (`renderTabNav`, ~line 483)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Pin git-row inputs to a shared bottom baseline**

In `styles.css`, directly after the existing `.config-sync-remote-git` rule (`display: grid; grid-template-columns: 1fr 8em 1fr; gap: var(--size-4-3);`), add:

```css
/* Labels may wrap to two lines; inputs stay on one shared baseline. */
.config-sync-remote-git > div {
  display: flex;
  flex-direction: column;
}
.config-sync-remote-git > div input {
  margin-top: auto;
}
```

- [ ] **Step 2: Make the icon-only tab collapse universal**

In `styles.css`, delete this rule from the phone block (keep the block's comment and every other `body.is-phone` rule, including the single-column `.config-sync-remote-git` override):

```css
body.is-phone .config-sync-tab:not(.is-active) .config-sync-tab-label {
  display: none;
}
```

and add the ungated equivalent next to the base `.config-sync-tab` rules (after the `.config-sync-tab.is-active` rule):

```css
/* All platforms: inactive tabs are icon-only; the active tab shows its label.
   Obsidian 1.13 opens Settings in its own, narrower window. */
.config-sync-tab:not(.is-active) .config-sync-tab-label {
  display: none;
}
```

- [ ] **Step 3: Tooltip + aria-label on every tab button**

In `src/ui/SettingTab.ts` `renderTabNav`, after the line
`el.createSpan({ cls: "config-sync-tab-label", text: tab.label });` add:

```ts
setTooltip(el, tab.label);
el.setAttr("aria-label", tab.label);
```

`setTooltip` is already imported from `obsidian` at line 1 — do not add an import.

- [ ] **Step 4: Gates**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, all tests pass, lint silent.

- [ ] **Step 5: Leave uncommitted** (NO-COMMITS mode)

---

### Task 2: Git runner hardening + failure classifier

**Files:**
- Modify: `src/external/gitSource.ts` (the `git()` runner, lines 11-18)
- Create: `src/core/remoteFailure.ts`
- Test: `tests/remoteFailure.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `classifyRemoteFailure(message: string): RemoteFailureKind` and
  `type RemoteFailureKind = "auth" | "timeout" | "other"` from `src/core/remoteFailure.ts` — Task 3 imports both. The runner's timeout failure message ends with `timed out after 60s`.

- [ ] **Step 1: Write the failing tests**

Create `tests/remoteFailure.test.ts` (repo style: explicit vitest imports, like `tests/gitSource.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { classifyRemoteFailure } from "../src/core/remoteFailure";

describe("classifyRemoteFailure", () => {
  it("classifies a credential prompt failure as auth", () => {
    expect(
      classifyRemoteFailure(
        "git fetch config-sync-import main failed in /v: fatal: could not read Username for 'https://git.example.com'"
      )
    ).toBe("auth");
  });
  it("classifies a broken credential helper as auth", () => {
    expect(classifyRemoteFailure("git: 'credential-manager' is not a git command. See 'git --help'.")).toBe("auth");
  });
  it("classifies ssh key rejection as auth", () => {
    expect(classifyRemoteFailure("Permission denied (publickey).")).toBe("auth");
  });
  it("classifies the runner's timeout marker as timeout", () => {
    expect(classifyRemoteFailure("git fetch config-sync-import main failed in /v: timed out after 60s")).toBe("timeout");
  });
  it("classifies anything else as other", () => {
    expect(classifyRemoteFailure("ENOENT: no such file or directory, scandir '/v/store'")).toBe("other");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/remoteFailure.test.ts`
Expected: FAIL — cannot resolve `../src/core/remoteFailure`.

- [ ] **Step 3: Implement the classifier**

Create `src/core/remoteFailure.ts`:

```ts
export type RemoteFailureKind = "auth" | "timeout" | "other";

const AUTH_PATTERNS = [/could not read username/i, /authentication failed/i, /permission denied/i, /credential/i];

// Pure classification of a remote-compare failure message. "timeout" keys on the marker the
// git runner appends when it kills a stalled child; "auth" on the common git/ssh phrasings.
export function classifyRemoteFailure(message: string): RemoteFailureKind {
  if (message.includes("timed out after")) return "timeout";
  if (AUTH_PATTERNS.some((p) => p.test(message))) return "auth";
  return "other";
}
```

- [ ] **Step 4: Harden the git runner**

In `src/external/gitSource.ts`, replace the `git()` function (and add the constant above it):

```ts
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      // Never let git block on an interactive credential prompt; fail fast instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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

Nothing else in the file changes; every caller (remote add/set-url, fetch, ls-tree, show, ls-remote) inherits the bounds.

- [ ] **Step 5: Run tests to verify they pass, then gates**

Run: `npx vitest run tests/remoteFailure.test.ts` → PASS (5/5).
Run: `npm run build && npm test && npm run lint`
Expected: build clean, whole suite green, lint silent.

- [ ] **Step 6: Leave uncommitted** (NO-COMMITS mode)

---

### Task 3: Sync Center error card

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (`renderRemoteDetail` catch block, ~line 2224-2228; imports ~line 5)
- Modify: `styles.css` (new card rules; put them next to `.config-sync-status-error`, ~line 387)

**Interfaces:**
- Consumes: `classifyRemoteFailure`, `RemoteFailureKind` from `src/core/remoteFailure.ts` (Task 2).
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Import the classifier**

In `src/ui/SyncCenterView.ts`, add:

```ts
import { classifyRemoteFailure } from "../core/remoteFailure";
```

next to the other `../core` imports.

- [ ] **Step 2: Replace the catch-block error line with the card**

Current code inside `renderRemoteDetail`'s `catch`:

```ts
      detail.empty();
      detail.createDiv({ cls: "config-sync-status-error", text: `Couldn't compare with this remote: ${(e as Error).message} — check the connection and try again.` });
      return;
```

Replace those three lines with (the stale-render guard line above them stays untouched):

```ts
      detail.empty();
      const raw = (e as Error).message;
      const kind = classifyRemoteFailure(raw);
      const card = detail.createDiv({ cls: "config-sync-remote-errcard" });
      card.createDiv({ cls: "config-sync-remote-errcard-head", text: `Couldn't compare with ${remote.name}` });
      const body =
        kind === "auth"
          ? "The Git host asked for a login, and there's no way to answer it here. Set up this remote's credentials on this device, then check again."
          : kind === "timeout"
            ? "The remote didn't answer within a minute. Check the connection, then check again."
            : "Couldn't reach this remote.";
      card.createDiv({ cls: "config-sync-remote-errcard-body", text: body });
      const det = card.createEl("details");
      det.createEl("summary", { text: remote.type === "git" ? "Show Git output" : "Show details" });
      det.createEl("pre", { text: raw });
      return;
```

Copy notes (binding): the three body strings above are verbatim-final. The `other` body is
`Couldn't reach this remote.` (no "Git" prefix — the card serves vault remotes too; this is
the one agreed deviation from the mockup footnote). The `<details>` summary is
`Show Git output` for git remotes, `Show details` for vault remotes. Do not remove the
`.config-sync-status-error` CSS class or its stylesheet rule — it has another user in this file.

- [ ] **Step 3: Card styles**

In `styles.css`, directly after the `.config-sync-status-error` rule, add:

```css
.config-sync-remote-errcard {
  border: 1px solid rgba(var(--color-red-rgb), 0.35);
  background: rgba(var(--color-red-rgb), 0.06);
  border-radius: var(--radius-m);
  padding: var(--size-4-3);
  max-width: 560px;
  margin: 0 0 var(--size-4-2) var(--size-4-3);
}
.config-sync-remote-errcard-head {
  color: var(--text-error);
  font-weight: var(--font-semibold);
}
.config-sync-remote-errcard-body {
  color: var(--text-muted);
  margin-top: var(--size-2-1);
}
.config-sync-remote-errcard details {
  margin-top: var(--size-4-2);
}
.config-sync-remote-errcard summary {
  cursor: pointer;
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
}
.config-sync-remote-errcard pre {
  margin: var(--size-4-1) 0 0;
  padding: var(--size-4-2);
  background: var(--background-primary);
  border-radius: var(--radius-s);
  font-size: var(--font-ui-smaller);
  white-space: pre-wrap;
  word-break: break-word;
}
```

- [ ] **Step 4: Gates**

Run: `npm run build && npm test && npm run lint`
Expected: build clean, all tests pass, lint silent.

- [ ] **Step 5: Leave uncommitted** (NO-COMMITS mode)

---

## Final verification (controller, after all tasks)

- Whole-branch review (fresh reviewer) over the full working-tree diff vs HEAD.
- Live verify in the dev vault: (1) Remotes tab git row — three inputs on one baseline with
  the long third label wrapping above; (2) desktop Settings — inactive tabs icon-only with
  hover tooltips, active tab expanded, Remotes tab still present on desktop; (3) Sync Center
  — a git remote with an auth-failing URL converges within 60 s to the card with the auth
  copy and expandable Git output; "comparing…" never persists past the timeout.
