# Remotes Tab UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: Task 3 (UI + CSS) must be executed INLINE by the controller — it requires rendered two-theme verification a subagent cannot see. Tasks 1–2 are subagent-eligible.

**Goal:** Give git remotes an in-form connectivity check, make the remote name update the row header live, and unify the "where the store lives" wording under the root word "Store".

**Architecture:** A pure `gitLsRemote`/`classifyLsRemote` in `gitSource.ts` (desktop git backend); UI changes in `SettingTab.ts` (labels, Test-connection line, header live update); result-strip styling in `styles.css` (theme-native). No remote data-model change.

**Tech Stack:** TypeScript (Obsidian plugin), vitest, Obsidian UI components (`ButtonComponent`, `TextComponent`).

## Global Constraints

- **Zero hardcoded color** in `styles.css` — only `rgba(var(--…-rgb), opacity)`; semantic mapping: success=`--color-green`, error=`--color-red`, caution=`--color-orange`. Enforced by `./scripts/check-no-hardcoded-color.sh`.
- Never override native `.setting-item` surfaces; reuse existing form classes.
- Git is desktop-only: the Test-connection button renders only under `Platform.isDesktop`; `gitSource` is dynamically imported (no `child_process` in the mobile bundle).
- No change to the remote data model, `validateRemotes`, or `toCandidate`.
- Gate: `npm test` green (adds tests), `npm run build`/`lint` clean (0 errors / 65 warnings baseline), `check-no-hardcoded-color.sh` passes.
- No Claude/AI attribution in commits.

---

### Task 1: `gitLsRemote` connectivity check (backend + pure classification)

**Files:**
- Modify: `src/external/gitSource.ts`
- Create: `tests/gitSource.test.ts`

**Interfaces:**
- Produces: `type LsRemoteResult = { kind: "ok"; branchFound: boolean } | { kind: "error"; message: string }`; `classifyLsRemote(outcome: { stdout: string } | { error: Error }): LsRemoteResult`; `gitLsRemote(remoteUrl: string, branch: string): Promise<LsRemoteResult>`.

- [ ] **Step 1: Write the failing test.** Create `tests/gitSource.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyLsRemote } from "../src/external/gitSource";

describe("classifyLsRemote", () => {
  it("reports branchFound=true when ls-remote prints a ref line", () => {
    const out = "a1b2c3\trefs/heads/main\n";
    expect(classifyLsRemote({ stdout: out })).toEqual({ kind: "ok", branchFound: true });
  });
  it("reports branchFound=false when the repo is reachable but the branch is absent (empty stdout)", () => {
    expect(classifyLsRemote({ stdout: "  \n" })).toEqual({ kind: "ok", branchFound: false });
  });
  it("reports an error with the git message when the call throws", () => {
    expect(classifyLsRemote({ error: new Error("Permission denied (publickey).") })).toEqual({
      kind: "error",
      message: "Permission denied (publickey).",
    });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `npm test -- gitSource 2>&1 | tail -15`
Expected: FAIL — `classifyLsRemote` is not exported.

- [ ] **Step 3: Implement in `gitSource.ts`.** Add after the `git()` helper (after line 18):

```ts
export type LsRemoteResult = { kind: "ok"; branchFound: boolean } | { kind: "error"; message: string };

// Pure classification of an ls-remote outcome. Empty stdout = repo reachable but branch absent.
export function classifyLsRemote(outcome: { stdout: string } | { error: Error }): LsRemoteResult {
  if ("error" in outcome) return { kind: "error", message: outcome.error.message };
  return { kind: "ok", branchFound: outcome.stdout.trim() !== "" };
}

// Reachability + auth check without downloading objects. Never throws — a failed git call
// (unreachable host, auth failure, bad URL) becomes { kind: "error" }. cwd is irrelevant for
// ls-remote against a URL, so process.cwd() is fine.
export async function gitLsRemote(remoteUrl: string, branch: string): Promise<LsRemoteResult> {
  try {
    const stdout = await git(process.cwd(), ["ls-remote", "--heads", remoteUrl, branch]);
    return classifyLsRemote({ stdout });
  } catch (e) {
    return classifyLsRemote({ error: e as Error });
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `npm test -- gitSource 2>&1 | tail -10`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/external/gitSource.ts tests/gitSource.test.ts
git commit -m "feat: add git ls-remote connectivity check with pure result classification"
```

---

### Task 2: "Store" terminology + live remote-name header

**Files:**
- Modify: `src/ui/SettingTab.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft, nameSpan: HTMLElement): void` (added third param).

- [ ] **Step 1: Rename the three labels.**
  - `SettingTab.ts:114` — in `GENERAL_SETTINGS`, change `name: "Data folder",` to `name: "Store folder",` (leave `desc` and `anchorId: "general-data-folder"` unchanged).
  - In `renderRemoteForm`'s git branch, change `field(line2, "Folder in repo (optional)")` to `field(line2, "Store folder in repo (optional)")`.
  - Verify the vault-remote label is already `field(line2, "Store path")` — leave it unchanged.
  - Search where else "Data folder" appears: `grep -n "Data folder" src/` — if the General setting's rendered name is built from the `GENERAL_SETTINGS` entry only, no other change is needed; if a literal "Data folder" string exists elsewhere (e.g. a heading), rename it too for consistency.

- [ ] **Step 2: Capture the header span in `renderRemoteRow` and pass it down.** At `SettingTab.ts:1352`, change:

```ts
    row.createSpan({ cls: "config-sync-rule-name", text: draft.name === "" ? "(unnamed)" : draft.name });
```
to:
```ts
    const nameSpan = row.createSpan({ cls: "config-sync-rule-name", text: draft.name === "" ? "(unnamed)" : draft.name });
```

And at the end of `renderRemoteRow` (`SettingTab.ts:1374`), change:
```ts
    if (isOpen) this.renderRemoteForm(listEl, draft);
```
to:
```ts
    if (isOpen) this.renderRemoteForm(listEl, draft, nameSpan);
```

- [ ] **Step 3: Update the signature and live-repaint the header in the Name onChange.** Change `private renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft): void {` to `private renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft, nameSpan: HTMLElement): void {`. In the Name field's `onChange` (currently):

```ts
    nameC.setPlaceholder("name").setValue(draft.name).onChange((v) => {
      this.expanded.delete(`remote:${draft.name}`);
      draft.name = v.trim();
      this.expanded.add(`remote:${draft.name}`);
      void this.saveRemotes();
    });
```
add the header repaint as the last line inside the callback:
```ts
      nameSpan.setText(draft.name === "" ? "(unnamed)" : draft.name);
```

- [ ] **Step 4: Gate.**

Run: `npm run build && npm test 2>&1 | grep -E "Tests|error TS"`
Expected: build clean, `Tests <count> passed` (Task 1's +3, no failures).

Run: `npm run lint 2>&1 | grep -E "problem"`
Expected: `0 errors` (warnings at/near 65).

- [ ] **Step 5: Commit.**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat: unify Store terminology and live-update the remote name header"
```

---

### Task 3: Test-connection UI + result-strip styling  — **INLINE (visual verification required)**

**Files:**
- Modify: `src/ui/SettingTab.ts` (add `ButtonComponent` import; rewrite the git branch of `renderRemoteForm`)
- Modify: `styles.css` (result-strip states)

- [ ] **Step 1: Add `ButtonComponent` to the obsidian import** (`SettingTab.ts:1`): insert `ButtonComponent,` into the `import { … } from "obsidian";` list (alphabetical, before `DropdownComponent`).

- [ ] **Step 2: Rewrite the git branch of `renderRemoteForm`.** Replace the current `else { … }` block (the git branch, `SettingTab.ts:1410-1424`) with:

```ts
    } else {
      const line2 = panel.createDiv({ cls: "config-sync-remote-git" });
      let strip: HTMLElement | null = null;
      const clearStrip = (): void => {
        if (strip) {
          strip.setText("");
          strip.className = "config-sync-test-strip";
        }
      };
      new TextComponent(field(line2, "URL")).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
        draft.url = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      new TextComponent(field(line2, "Branch")).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
        draft.branch = v.trim();
        clearStrip();
        void this.saveRemotes();
      });
      new TextComponent(field(line2, "Store folder in repo (optional)")).setPlaceholder("empty = repo root").setValue(draft.subdir).onChange((v) => {
        draft.subdir = v.trim();
        void this.saveRemotes();
      });
      if (Platform.isDesktop) {
        const testLine = panel.createDiv({ cls: "config-sync-remote-test" });
        const btn = new ButtonComponent(testLine).setButtonText("Test connection");
        strip = panel.createDiv({ cls: "config-sync-test-strip" });
        btn.onClick(async () => {
          btn.setDisabled(true).setButtonText("Testing…");
          strip!.className = "config-sync-test-strip is-testing";
          strip!.setText("Contacting remote…");
          try {
            const { gitLsRemote } = await import("../external/gitSource");
            const res = await gitLsRemote(draft.url, draft.branch);
            if (res.kind === "error") {
              strip!.className = "config-sync-test-strip is-error";
              strip!.setText(`✗ Could not reach remote — ${res.message}`);
            } else if (res.branchFound) {
              strip!.className = "config-sync-test-strip is-ok";
              strip!.setText(`✓ Reachable — branch ${draft.branch} found`);
            } else {
              strip!.className = "config-sync-test-strip is-caution";
              strip!.setText(`Reachable, but branch "${draft.branch}" not found`);
            }
          } finally {
            btn.setDisabled(false).setButtonText("Test connection");
          }
        });
      }
    }
```

- [ ] **Step 3: Add result-strip styles to `styles.css`** (near the `.config-sync-remote-git` block, ~line 273). Theme-native, zero hardcoded color:

```css
.config-sync-remote-test {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: var(--size-4-2);
}

.config-sync-test-strip:empty {
  display: none;
}

.config-sync-test-strip {
  margin-top: var(--size-4-1);
  padding: var(--size-4-1) var(--size-4-2);
  border-radius: var(--radius-s);
  font-size: var(--font-ui-smaller);
  border: 1px solid transparent;
}

.config-sync-test-strip.is-testing {
  color: var(--text-muted);
}

.config-sync-test-strip.is-ok {
  color: var(--color-green);
  background: rgba(var(--color-green-rgb), 0.1);
  border-color: rgba(var(--color-green-rgb), 0.4);
}

.config-sync-test-strip.is-caution {
  color: var(--color-orange);
  background: rgba(var(--color-orange-rgb), 0.1);
  border-color: rgba(var(--color-orange-rgb), 0.4);
}

.config-sync-test-strip.is-error {
  color: var(--color-red);
  background: rgba(var(--color-red-rgb), 0.1);
  border-color: rgba(var(--color-red-rgb), 0.4);
}
```

- [ ] **Step 4: Gate.**

Run: `npm run build && npm run lint 2>&1 | grep -E "problem|error TS" ; ./scripts/check-no-hardcoded-color.sh ; npm test 2>&1 | grep Tests`
Expected: build clean; `0 errors`; color check OK; tests pass.

- [ ] **Step 5: Two-theme visual verification (controller, inline).** Deploy (`npm run smoke:install`), vault-name guard (`app.vault.getName()` must print `vault`). Open the config panel → Remotes tab → expand a git remote. Screenshot the git form in the **default theme** and in **AnuPpuccin** (`app.customCss.setTheme('AnuPpuccin')` / `setTheme('')`) for: idle, is-testing, is-ok, is-caution, is-error. Confirm the strip reads correctly in both themes, the button aligns under the fields (layout A), and the three renamed labels show ("Store folder" in General; "Store folder in repo" in the git form). Compare against the companion mockup.

- [ ] **Step 6: Commit.**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "feat: Test connection button and result strip for git remotes"
```

---

### Task 4: Controller smoke — live behavior

**Files:** none (controller-run verification, desktop dev vault).

- [ ] **Step 1: Guard + deploy** (guard must print `=> vault`; deploy already done in Task 3).
- [ ] **Step 2: Live name → header.** Expand a remote, type a name in the Name field → confirm the row header updates from "(unnamed)" to the typed name live, without collapsing the form, and input focus is retained.
- [ ] **Step 3: Test connection — reachable.** Configure a git remote with a real reachable repo URL + a valid branch → click Test connection → ✓ strip with the branch name; then a nonexistent branch → caution strip.
- [ ] **Step 4: Test connection — unreachable.** Use a bad URL (e.g. `git@github.com:nope/nope.git` or a garbage host) → click Test → ✗ strip with the git error surfaced. Confirm no unhandled console rejection (`dev:errors` shows no config-sync frame).
- [ ] **Step 5: Strip clears on edit.** After a result, edit the URL or Branch → the strip clears. Record results in the ledger.

---

## Self-Review Notes

- Spec coverage: (c) terminology → Task 2 Step 1; (a) backend → Task 1, (a) UI/strip/styling → Task 3; (b) header live update → Task 2 Steps 2-3; verification → Task 3 Step 5 + Task 4.
- Type consistency: `LsRemoteResult`/`classifyLsRemote`/`gitLsRemote` identical across Task 1 (produced) and Task 3 (consumed via dynamic import); `renderRemoteForm` third param `nameSpan: HTMLElement` matches the `nameSpan` captured in Task 2 Step 2.
- Behavior note: the caution vs error distinction depends on `git ls-remote --heads` exiting zero with empty output when the branch is absent — verified by Task 4 Step 3 (nonexistent branch → caution, not error).
- Execution mode: Tasks 1–2 subagent-eligible; **Task 3 inline** (two-theme rendered check); Task 4 inline controller smoke. Post-plan: hand to user for pre-merge acceptance; merge + cut only after the user verifies.
