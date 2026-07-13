# Keyboard-Stable Settings Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing in the settings search box no longer destroys the input per keystroke, so the mobile keyboard stays open.

**Architecture:** `SettingTab.render()` splits into a persistent search box and a `bodyEl` container; `search.onChange` re-renders only `bodyEl`. The `searchInputEl` focus-restore hack is deleted.

**Tech Stack:** TypeScript, Obsidian API, obsidian-cli (`emulateMobile`).

**Spec:** `docs/superpowers/specs/2026-07-13-settings-search-keyboard-design.md`. No visual change — no mockup (behavior-only fix).

## Global Constraints

- Gate: `npm test && npm run build && npm run lint` — 0 lint errors (69-warning baseline).
- Full `rerender()` behavior (tab switches, structural edits, `display()`, scrollTop restore) unchanged.
- `renderGen` guard must still protect the async body renders.
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Partial-render search

**Files:**
- Modify: `src/ui/SettingTab.ts` (fields ~line 106, `render` ~lines 142-170, `renderSearchBox` ~lines 172-182)

**Interfaces:** none external; internal shape below is binding.

- [ ] **Step 1: Restructure `render`**

Replace the body-rendering portion of `render(containerEl, gen, scrollTop)`:

```ts
    this.renderSearchBox(containerEl);
    const bodyEl = containerEl.createDiv({ cls: "config-sync-settings-body" });
    await this.renderBody(bodyEl, gen);
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
```

Add the new method (the moved former body logic):

```ts
  private async renderBody(bodyEl: HTMLElement, gen: number): Promise<void> {
    if (gen !== this.renderGen) return;
    bodyEl.empty();
    if (this.search.trim() !== "") {
      await this.renderSearchResults(bodyEl, gen);
    } else {
      this.renderTabNav(bodyEl);
      await this.renderActiveTab(bodyEl, gen);
    }
  }
```

Delete: the `private searchInputEl: HTMLInputElement | null = null;` field, its assignment in `renderSearchBox`, and the trailing focus-restore block (`if (this.search.trim() !== "" && this.searchInputEl !== null) { ... }`).

- [ ] **Step 2: Rewire `onChange`**

`renderSearchBox(containerEl)` gains the body hook — change its signature to `renderSearchBox(containerEl: HTMLElement, getBody: () => HTMLElement)` OR (simpler, do this): store the container as a field `private bodyEl: HTMLElement | null = null;`, set it in `render` when creating the div, and change the handler to:

```ts
    search.onChange((v) => {
      this.search = v;
      const body = this.bodyEl;
      if (body === null) return;
      void this.renderBody(body, this.renderGen);
    });
```

(`this.renderGen` unchanged: search typing is not a new generation — a concurrent full rerender bumps the gen and the in-flight body render aborts via the guard. Set `this.bodyEl = null` at the top of `rerender()` before `containerEl.empty()` so a stale handler can't write into a detached div, and assign the new one in `render`.)

- [ ] **Step 3: Verify hierarchy** — `renderSearchResults`/`renderTabNav`/`renderActiveTab` take a container param already (they receive `containerEl` today); passing `bodyEl` needs no signature change. Confirm no other code assumes tab nav is a direct child of `containerEl` (grep `config-sync-tabs` usages).

- [ ] **Step 4: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/ui/SettingTab.ts
git commit -m "fix: settings search re-renders only the body, keeping the input alive"
```

---

### Task 2: Live smoke (controller)

1. Guard (standalone); `npm run smoke:install`; reload.
2. Desktop: open settings, focus search, type 4+ chars one by one — verify via eval that the input ELEMENT IDENTITY persists (tag a `dataset.marker` before typing, confirm after) and results update per keystroke; clear search → tabs return.
3. `emulateMobile(true)`: repeat the identity check (keyboard itself can't be observed via CLI — element identity is the proxy; the destroy→refocus cycle is what bounced it).
4. Tab switch + a structural edit (enable toggle) still full-refresh correctly.
5. Cleanup; `dev:errors` clean; final review (opus, small diff) → merge --no-ff → cut **0.18.1** (pre-authorized).
