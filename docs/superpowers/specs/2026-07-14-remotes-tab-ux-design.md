# Remotes Tab UX (0.22.x)

Three related fixes to the config panel's Remotes tab and the General tab: a git connectivity
check, a live-updating remote name, and unified "where the store lives" terminology. Design
定稿 via the visual companion (terminology option A; Test-connection layout A).

## Problem

1. **No git connectivity feedback while configuring.** `saveRemotes` only runs `validateRemotes`
   (format checks). A git remote's reachability is exercised only by the background
   `refreshRemoteChecks` (a `git fetch` inside `createGitReader`), which runs on the auto-check
   timer, collapses any failure to `state: "unknown"`, and logs the real git error to the
   console. So while filling in a URL/branch the user gets no immediate "is this reachable /
   correct" answer, and no error detail.
2. **"(unnamed)" row header desync.** In `renderRemoteForm`, the Name field's `onChange`
   (`SettingTab.ts:1391`) saves live and updates `this.expanded`, but never updates the row
   header span (`config-sync-rule-name`, created at `SettingTab.ts:1352`), which keeps showing
   "(unnamed)" until an unrelated `refresh()` (expand/collapse) repaints. Pure display desync.
3. **Three unrelated words for one concept.** "Data folder" (General), "Store path" (vault
   remote), "Folder in repo (optional)" (git remote) all mean "where the store lives," creating
   needless cognitive load.

## Design

### (c) Terminology — one root word: "Store" (定稿 option A)

| Location | Field label today | New label |
|---|---|---|
| General tab | Data folder | **Store folder** |
| Remote · Another vault | Store path | **Store path** (unchanged — already "Store") |
| Remote · Git repository | Folder in repo (optional) | **Store folder in repo (optional)** |

Descriptions and placeholders are unchanged ("Where your synced settings live inside this
vault…", "empty = repo root"). The `GENERAL_SETTINGS` search-index entry (`SettingTab.ts:114`)
`name` changes from `"Data folder"` to `"Store folder"` so search still matches. `anchorId`
(`general-data-folder`) is unchanged to avoid breaking deep links.

Mental model: there is one thing — the *Store* — and each field says *where* it lives (a folder
in this vault, a path to another vault's store, a folder in the repo).

### (a) Test connection — git remotes only (定稿 layout A)

**Backend.** Add to `src/external/gitSource.ts`:

```ts
export type LsRemoteResult =
  | { kind: "ok"; branchFound: boolean }
  | { kind: "error"; message: string };

// Reachability + auth check without downloading objects. Never throws — a failed git call
// (unreachable host, auth failure, bad URL) is returned as { kind: "error" }.
export async function gitLsRemote(remoteUrl: string, branch: string): Promise<LsRemoteResult> {
  try {
    const stdout = await git(process.cwd(), ["ls-remote", "--heads", remoteUrl, branch]);
    return { kind: "ok", branchFound: stdout.trim() !== "" };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}
```

`git ls-remote --heads <url> <branch>` exits zero and prints the ref line when the branch
exists, exits zero with empty output when the repo is reachable but the branch is absent, and
exits non-zero (→ the existing `git()` helper throws) when the repo is unreachable or auth
fails. The `cwd` is irrelevant for `ls-remote` against a URL (it contacts the remote directly);
use `process.cwd()` to avoid needing the vault path. Import is dynamic (desktop-only), matching
how `SettingTab` already lazy-imports `pickFolder`/`localPath`.

**UI.** In `renderRemoteForm`'s git branch (after the three git fields), on **desktop only**
(`Platform.isDesktop`, mirroring the vault-remote Browse button), add a line holding a
**Test connection** button and a result-strip container. Behavior:

- Idle: strip empty (nothing shown).
- On click: disable the button, show "Testing…", call `gitLsRemote(draft.url, draft.branch)`.
- `{ kind: "ok", branchFound: true }` → success strip: `✓ Reachable — branch <branch> found`.
- `{ kind: "ok", branchFound: false }` → caution strip: `Reachable, but branch "<branch>" not found`.
- `{ kind: "error", message }` → error strip: `✗ Could not reach remote — <message>`.
- Re-enable the button after the result.
- Editing the URL or Branch field after a result **clears the strip** (the prior result is
  stale). Collapsing the form discards the strip (it is not persisted to settings).

The result strip is transient per open form — no new field in the remote data model, no change
to `validateRemotes` or `toCandidate`.

**Styling.** New `styles.css` rules for the strip and its three states, theme-native with **zero
hardcoded color**: success binds to `--color-green`, error to `--color-red`, caution to
`--color-orange` (the established semantic mapping), expressed as `rgba(var(--color-…-rgb),
opacity)` surfaces with the palette var as text/border. Enforced by `check-no-hardcoded-color.sh`.

### (b) "(unnamed)" header live update — behavior fix

Pass the header span into `renderRemoteForm` so the Name `onChange` can repaint just that span,
without a full `refresh()` (which would rebuild the DOM and drop input focus mid-keystroke):

- `renderRemoteRow` captures the header span: `const nameSpan = row.createSpan({ cls:
  "config-sync-rule-name", … })` and passes it: `this.renderRemoteForm(listEl, draft, nameSpan)`.
- `renderRemoteForm(listEl, draft, nameSpan)`'s Name `onChange` adds, after the existing
  `draft.name` / `this.expanded` updates and `saveRemotes()`:
  `nameSpan.setText(draft.name === "" ? "(unnamed)" : draft.name);`

No other caller of `renderRemoteForm` exists, so the signature change is contained.

## Edge cases

- **Mobile:** the Test connection button is not rendered (git is desktop-only); the git remote
  form is otherwise unchanged. No `child_process` reaches the mobile bundle (dynamic import).
- **Empty URL:** if `draft.url` is empty when Test is clicked, `git ls-remote` fails and the
  error strip shows the git message; acceptable (the button is only meaningful once a URL is
  typed). No special-casing.
- **Slow/hanging remote:** `ls-remote` is bounded by git's own network behavior; the button stays
  disabled with "Testing…" until it returns. No custom timeout in this iteration (YAGNI); if it
  hangs, the user can collapse the form. (Noted as a possible future refinement, not built now.)
- **Name collision with an existing remote key:** unchanged from today — `this.expanded` keying
  by `remote:${draft.name}` already handles the delete/add dance on rename; the header live
  update only changes the visible text.

## Testing

- **Unit (`tests/` new or existing gitSource/remotes test):** `gitLsRemote` result
  classification is pure logic over the `git()` result — test the three mappings by stubbing the
  `git` call: non-empty stdout → `{ ok, branchFound: true }`; empty stdout → `{ ok, branchFound:
  false }`; throw → `{ error, message }`. (If `git()` is not injectable, extract the
  classification into a tiny pure helper `classifyLsRemote(stdout | error)` and unit-test that;
  keep the `execFile` call thin.)
- **No new test for the label rename or the header live-update** (static copy / DOM-glue,
  covered by the controller smoke, per the repo's test strategy).
- **Controller smoke (desktop dev vault):** (1) rename a remote in the open form → row header
  updates live as you type, without collapse; (2) Test connection against a real reachable repo
  → ✓ strip with branch; against a bad URL → ✗ strip with the git error; against a reachable
  repo + nonexistent branch → caution strip; (3) two-theme screenshot (default + AnuPpuccin) of
  each strip state and the three renamed labels.
- Gate: `npm test` green, `npm run build`/`lint` clean (0 errors / 65 warnings baseline),
  `check-no-hardcoded-color.sh` passes.

## Scope

`src/ui/SettingTab.ts` (three labels; Test-connection line + result-strip logic; header live
update + `renderRemoteForm` signature), `src/external/gitSource.ts` (`gitLsRemote` +
classification), `styles.css` (result-strip states, theme-native), `tests/` (ls-remote
classification). No change to the remote data model, `validateRemotes`, or `toCandidate`. This
is item 3 of the post-0.21.0 backlog; the remaining items (Sync Center checkbox presentation,
capture/pull interruption robustness, and the deferred self-config-propagation model) are
separate specs.
