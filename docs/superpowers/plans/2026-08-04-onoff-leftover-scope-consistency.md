# On/off + leftover consistency (①②③) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make disabled core plugins' store configs safe (not "leftover"), bring the on/off both-ways state into the 2.15.0 summary+per-plugin-rule system, and reorder the on/off body so the primary decision leads.

**Architecture:** Three specs, one release. ① is a registry attribution change (core routes through the same shared compiler + device gate community already uses). ② replaces the both-ways red box/modal with a two-line directional summary + a unified per-plugin rule list (pure helpers in `panelModel.ts`, wired in `SyncCenterView.ts`). ③ reorders `renderSwitchDivergence` and de-dups the header. Implement all three, deploy to main/kickstart/llm, live-test, then cut once.

**Tech Stack:** TypeScript, Obsidian plugin API, Vitest (DOM-free pure-function tests), esbuild.

## Global Constraints

- **No git commits** until the cut. All changes stay uncommitted (the user's review state). This overrides subagent-driven-development's per-task commit steps: implementers **do not commit** — they leave the working tree dirty and report; per-task review runs against the **working-tree diff**, not a commit range.
- **Test before cut:** after ①②③ are implemented and reviewed, deploy the built `main.js`/`manifest.json`/`styles.css` to the `main`, `kickstart`, `llm` vaults' `.obsidian/plugins/config-sync/`, live-test, and only then cut **one** version. Cut hand-writes release notes; publish is the user's own manual step.
- **No Claude attribution** in any commit / PR / issue text (applies to the eventual cut).
- **Privacy:** `~`/`$HOME`/`$USER`, `<vault>`/`<host>` placeholders in any artifact; never embed secrets. User-facing replies Chinese; code/comments/identifiers/docs English.
- **Invariant:** host writes and capture/apply/status semantics are unchanged across all three tasks — only attribution (①) and presentation (②③) change.
- **Product-voice copy is final:** the strings in this plan are the 定稿 copy from the companion mockups. Do not reword them.

---

## File Structure

- `src/core/registry.ts` — ①: drop the `fileExists` gate on a core item's settings path (`:157`).
- `tests/registry.test.ts` — ①: two existing assertions flip (state-only core now compiles a group); add a leftover-attribution test.
- `src/ui/panelModel.ts` — ②: add `switchSummaryLines`, `SummaryLine`, `SWITCH_BOTHWAYS_CAPTION`, `memberDivergenceSide`; widen `pendingScopeMembers` to union on both-ways; remove `switchSummaryLine`.
- `tests/panelModel.test.ts` — ②: replace the `switchSummaryLine` block with `switchSummaryLines`; update `pendingScopeMembers` both-ways expectation; add `memberDivergenceSide`.
- `src/ui/SyncCenterView.ts` — ②③: restructure `renderSwitchDivergence` (order + both-ways), rewrite `renderMemberSummary`, add a direction tag in `renderPerPluginRules`, delete the both-ways box + `KeepOnDeviceModal`, remove the header `· N device-scoped` span; update imports.
- `styles.css` — ②③: add summary-line / caption / rule-side classes; remove the dead `config-sync-divergence*` (and `config-sync-ldnote` if unused elsewhere).

---

### Task 1: ① Attribute file-absent known core plugins

**Files:**
- Modify: `src/core/registry.ts:157`
- Test: `tests/registry.test.ts` (update `:55-56`, `:191-196`; add one case)

**Interfaces:**
- Consumes: `corePluginFile(id)` (already imported), `RegistryCoreEnv` (keeps `fileExists`, now informational-only), `leftoverStoreRels` (from `../src/core/leftover`).
- Produces: for a **selected** known core whose file is absent, `compileSingleFile` now emits a `SyncGroup` at `{configDir}/<corePluginFile>` (default `devices:"all"`), so its store copy is attributed (not leftover) and status is To-apply/no-settings instead of leftover.

- [ ] **Step 1: Update the two existing registry assertions to the new behavior (failing test)**

In `tests/registry.test.ts`, change the state-only assertions to expect a real path/group. Replace `:55-56`:

```ts
    expect(zk?.settingsFile?.defaultPath).toBe("{configDir}/zk-prefixer.json"); // ① known core keeps a path even when its file is absent
```

Replace the whole `:191-196` test body:

```ts
  it("① a state-only core card still compiles a file group when enabled (attributable, not leftover)", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "zk-prefixer", name: "Unique note creator", fileExists: false }] };
    const defs = buildItemDefs(env);
    const groups = compileItems(defs, settings({ "core:zk-prefixer": on() }));
    expect(findGroup(groups, "zk-prefixer")?.path).toBe("{configDir}/zk-prefixer.json");
  });
```

- [ ] **Step 2: Add the leftover-attribution test (failing)**

Add near the block above (import `leftoverStoreRels` at the top of `tests/registry.test.ts` from `../src/core/leftover`):

```ts
  it("① a file-absent but selected core plugin's store config is attributed, not leftover", () => {
    const env: RegistryEnv = { ...EMPTY_ENV, cores: [{ id: "backlink", name: "Backlinks", fileExists: false }] };
    const defs = buildItemDefs(env);
    const selected = compileItems(defs, settings({ "core:backlink": on() }));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], selected)).toEqual([]);
    const unselected = compileItems(defs, settings({}));
    expect(leftoverStoreRels(["store/configdir/backlink.json"], unselected).map((l) => l.path)).toEqual(["configdir/backlink.json"]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — current code nulls the path for `fileExists:false`, so the group/path assertions fail and the store file is still leftover.

- [ ] **Step 4: Make the source change**

In `src/core/registry.ts:157`, drop the `fileExists` gate:

```ts
    settingsFile: { defaultPath: `{configDir}/${corePluginFile(c.id)}` },
```

Update the `RegistryCoreEnv.fileExists` doc comment (`:102`) to note it is now informational (no longer gates the settings path):

```ts
  fileExists: boolean; // runtime info only: whether ${corePluginFile(id)} exists now (no longer gates the settings path — ①)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Full gate**

Run: `npm run build && npx vitest run && npm run lint`
Expected: build clean, all tests pass, lint at or below its baseline (0 err). No commit (Global Constraints).

---

### Task 2: ② panelModel pure helpers (summary lines, caption, divergence side, union members)

**Files:**
- Modify: `src/ui/panelModel.ts` (near the existing `switchSummaryLine` at `:284-305`)
- Test: `tests/panelModel.test.ts` (`:326-336` pendingScopeMembers, `:349-365` switchSummaryLine block)

**Interfaces:**
- Consumes: `Direction` (already exported in this file, `:7`).
- Produces: `SummaryLine`, `switchSummaryLines(d, device): SummaryLine[]`, `SWITCH_BOTHWAYS_CAPTION: string`, `memberDivergenceSide(d, id): "here" | "store"`, and a `pendingScopeMembers` that returns the union on both-ways. `switchSummaryLine` (singular) is removed.

- [ ] **Step 1: Write failing tests**

In `tests/panelModel.test.ts`, replace the entire `describe("switchSummaryLine", …)` block (`:349-365`) with:

```ts
describe("switchSummaryLines", () => {
  it("apply direction, plural, desktop wording", () => {
    expect(switchSummaryLines({ captureRemoves: ["a", "b"], applyDisables: [] }, "desktop"))
      .toEqual([{ dir: "apply", text: "2 plugins are on for your other devices but off this computer — Apply turns them on." }]);
  });
  it("apply direction, singular, mobile wording", () => {
    expect(switchSummaryLines({ captureRemoves: ["a"], applyDisables: [] }, "mobile"))
      .toEqual([{ dir: "apply", text: "1 plugin is on for your other devices but off this phone — Apply turns it on." }]);
  });
  it("capture direction, plural", () => {
    expect(switchSummaryLines({ captureRemoves: [], applyDisables: ["a", "b"] }, "desktop"))
      .toEqual([{ dir: "capture", text: "2 plugins are on this computer but off on your other devices — Capture shares them." }]);
  });
  it("both ways → two lines, apply first", () => {
    expect(switchSummaryLines({ captureRemoves: ["a"], applyDisables: ["b"] }, "desktop")).toEqual([
      { dir: "apply", text: "1 plugin is on for your other devices but off this computer — Apply turns it on." },
      { dir: "capture", text: "1 plugin is on this computer but off on your other devices — Capture shares it." },
    ]);
  });
  it("neither → no lines", () => {
    expect(switchSummaryLines({ captureRemoves: [], applyDisables: [] }, "desktop")).toEqual([]);
  });
});

describe("memberDivergenceSide", () => {
  const d = { captureRemoves: ["off-here"], applyDisables: ["on-here"] };
  it("on-here/off-store is 'here', off-here/on-store is 'store'", () => {
    expect(memberDivergenceSide(d, "on-here")).toBe("here");
    expect(memberDivergenceSide(d, "off-here")).toBe("store");
  });
});
```

Change the both-ways `pendingScopeMembers` expectation (`:333-335`) to the union:

```ts
  it("returns the union of both sets when both sides diverge", () => {
    expect(pendingScopeMembers({ captureRemoves: ["a"], applyDisables: ["b"] })).toEqual(["a", "b"]);
  });
```

Update the test import line (`:2`): drop `switchSummaryLine`, add `switchSummaryLines, memberDivergenceSide`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/panelModel.test.ts`
Expected: FAIL — `switchSummaryLines` / `memberDivergenceSide` are not defined; both-ways `pendingScopeMembers` still returns `[]`.

- [ ] **Step 3: Implement**

In `src/ui/panelModel.ts`, replace the `switchSummaryLine` function (`:284-305`) with:

```ts
export interface SummaryLine {
  dir: Direction;
  text: string;
}

// Directional summary lines that replace the per-member flood. One-sided → one line; both-sided
// → both, apply line first (Apply is the primary action on a never-synced item). `here` is
// device-aware. Replaces the old single-line switchSummaryLine, which bailed to null on both-ways.
export function switchSummaryLines(
  d: { captureRemoves: string[]; applyDisables: string[] },
  device: "desktop" | "mobile"
): SummaryLine[] {
  const here = device === "mobile" ? "this phone" : "this computer";
  const out: SummaryLine[] = [];
  if (d.captureRemoves.length > 0) {
    const n = d.captureRemoves.length;
    out.push({
      dir: "apply",
      text:
        n === 1
          ? `1 plugin is on for your other devices but off ${here} — Apply turns it on.`
          : `${n} plugins are on for your other devices but off ${here} — Apply turns them on.`,
    });
  }
  if (d.applyDisables.length > 0) {
    const n = d.applyDisables.length;
    out.push({
      dir: "capture",
      text:
        n === 1
          ? `1 plugin is on ${here} but off on your other devices — Capture shares it.`
          : `${n} plugins are on ${here} but off on your other devices — Capture shares them.`,
    });
  }
  return out;
}

// Shown only when the divergence is two-sided — a bulk Apply/Capture is not a no-op there.
export const SWITCH_BOTHWAYS_CAPTION =
  "Bulk Apply or Capture resolves every plugin one way. Pin the ones that differ on purpose below.";

// Which side a divergent member sits on: on here / off store ("here") vs off here / on store ("store").
export function memberDivergenceSide(
  d: { captureRemoves: string[]; applyDisables: string[] },
  id: string
): "here" | "store" {
  return d.applyDisables.includes(id) ? "here" : "store";
}
```

Widen `pendingScopeMembers` (`:274-277`) to return the union on both-ways:

```ts
// The divergent member set the per-plugin rule list offers: the single divergent side when
// one-sided, the union of both sides when two-sided (each row shows which side via
// memberDivergenceSide).
export function pendingScopeMembers(d: { captureRemoves: string[]; applyDisables: string[] }): string[] {
  if (d.captureRemoves.length > 0 && d.applyDisables.length > 0) return [...d.captureRemoves, ...d.applyDisables];
  return d.captureRemoves.length > 0 ? d.captureRemoves : d.applyDisables;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/panelModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate**

Run: `npm run build && npx vitest run && npm run lint`
Expected: build fails ONLY at `SyncCenterView.ts` if it still imports `switchSummaryLine` — that is fixed in Task 3. If building the whole project here blocks, it is acceptable for this task to leave `SyncCenterView.ts` referencing the old name; note it in the report and let Task 3 resolve. Tests for `panelModel` pass; lint clean for `panelModel.ts`. No commit.

---

### Task 3: ②③ SyncCenterView render restructure (both-ways summary + order + de-dup)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `renderSwitchDivergence` (`:1773-1819`), `renderMemberSummary` (`:1826-1829`), `renderPerPluginRules` (`:1847-1874`), the header span (`:1577-1580`), imports (`:35`), delete `KeepOnDeviceModal` (`:2554…`) and its call site.
- Modify: `styles.css` — add `config-sync-summary-line`, `config-sync-summary-caption`, `config-sync-rule-side`; remove `config-sync-divergence`/`-line` (`:1376-1385`); remove `config-sync-ldnote` (`:1337`) only if unused elsewhere.

**Interfaces:**
- Consumes: Task 2's `switchSummaryLines`, `SWITCH_BOTHWAYS_CAPTION`, `memberDivergenceSide`, `pendingScopeMembers`; existing `renderActionIcon`, `ACTION_COLOR_CLASS`, `renderScopeCycle`, `renderDisclosure`, `renderScopedDisclosure`, `MEMBER_GUIDE_GROUPS`, `MEMBER_PUBLISH_NOTE`, `switchMemberDecisions`, `switchDivergenceFor`, `selfInfo`.
- Produces: DOM only. No new public API. No unit test (repo strategy is DOM-free); verified at Task 4 live-test.

- [ ] **Step 1: Fix imports**

In the `./panelModel` import block (`:10-40`): remove `switchSummaryLine`, add `switchSummaryLines`, `SWITCH_BOTHWAYS_CAPTION`, `memberDivergenceSide`.

- [ ] **Step 2: Restructure `renderSwitchDivergence` (② content + ③ order)**

Replace the whole method (`:1773-1819`) with:

```ts
  // ③ order: summary + caption + per-plugin rules on top, "N scoped to specific devices" (and the
  // capture publish note) at the bottom. Child holders are created synchronously in final order so
  // the async divergence fill can never reorder them. ② the both-ways state now renders the same
  // two-line summary + unified per-plugin rules instead of a red box + Keep-on-device modal.
  private renderSwitchDivergence(detail: HTMLElement, r: StatusRow): void {
    const holder = detail.createDiv();
    const topHolder = holder.createDiv(); // summary + caption + rules (async — needs the divergence)
    const scopedHolder = holder.createDiv(); // publish note + "N scoped to specific devices" — always last
    // The scoped disclosure + publish note only need switchMemberDecisions / self-state, so they
    // render synchronously — independent of switchDivergenceFor, which resolves null before the
    // store is captured and must not hide them (2.15.0 null-safety, preserved).
    if (MEMBER_GUIDE_GROUPS.has(r.group.name)) {
      const decisions = this.host.switchMemberDecisions(r.group.name);
      if (decisions.length > 0 && this.selfInfo !== null && (this.selfInfo.state === "capture" || this.selfInfo.state === "both")) {
        scopedHolder.createDiv({ cls: "config-sync-lddetail", text: MEMBER_PUBLISH_NOTE });
      }
      this.renderScopedDisclosure(scopedHolder, r);
    }
    void this.host.switchDivergenceFor(r.group.name).then((d) => {
      if (!topHolder.isConnected || d === null) return;
      if (!MEMBER_GUIDE_GROUPS.has(r.group.name)) return;
      this.renderMemberSummary(topHolder, r, d);
      const members = pendingScopeMembers(d);
      if (members.length > 0) {
        this.renderDisclosure(topHolder, `${r.group.name}::rules`, "Set a per-plugin rule", false, (panel) =>
          this.renderPerPluginRules(panel, r, members, d)
        );
      }
    });
  }
```

- [ ] **Step 3: Rewrite `renderMemberSummary` (two directional lines + both-ways caption)**

Replace (`:1826-1829`):

```ts
  private renderMemberSummary(holder: HTMLElement, r: StatusRow, d: { captureRemoves: string[]; applyDisables: string[] }): void {
    const lines = switchSummaryLines(d, Platform.isMobile ? "mobile" : "desktop");
    if (lines.length === 0) return;
    const box = holder.createDiv({ cls: "config-sync-member-summary" });
    for (const ln of lines) {
      const row = box.createDiv({ cls: "config-sync-summary-line" });
      renderActionIcon(row, ln.dir).addClass(ACTION_COLOR_CLASS[ln.dir]);
      row.appendText(` ${ln.text}`);
    }
    if (d.captureRemoves.length > 0 && d.applyDisables.length > 0) {
      box.createDiv({ cls: "config-sync-summary-caption", text: SWITCH_BOTHWAYS_CAPTION });
    }
  }
```

(`r` is unused now but kept for signature symmetry with the other `render*` members — if lint flags it, drop the `r` parameter and its call-site argument.)

- [ ] **Step 4: Add the direction tag in `renderPerPluginRules`**

Change the signature and the row build (`:1847-1874`) to take `d` and render the side tag:

```ts
  private renderPerPluginRules(holder: HTMLElement, r: StatusRow, members: string[], d: { captureRemoves: string[]; applyDisables: string[] }): void {
    const group = r.group.name;
    const decisions = this.host.switchMemberDecisions(group);
    const query = this.ruleSearch.get(group) ?? "";
    const search = holder.createEl("input", { cls: "config-sync-rule-search", attr: { type: "text", placeholder: "Search a plugin to give it a rule…" } });
    search.value = query;
    const list = holder.createDiv({ cls: "config-sync-rule-list" });
    const paint = (q: string): void => {
      list.empty();
      for (const id of members) {
        if (q !== "" && !id.toLowerCase().includes(q.toLowerCase())) continue;
        const row = list.createDiv({ cls: "config-sync-rule-row" });
        row.createSpan({ cls: "config-sync-rule-mid", text: id });
        row.createSpan({ cls: "config-sync-rule-side", text: memberDivergenceSide(d, id) === "here" ? "on here only" : "in store only" });
        const cell = row.createSpan();
        renderScopeCycle(cell, {
          scope: memberCurrentScope(decisions, id),
          options: this.scopeOptionsFor(id),
          disabled: false,
          onChange: (v) => void this.writeMemberScope(group, id, v),
        });
      }
    };
    paint(query);
    search.addEventListener("input", () => {
      this.ruleSearch.set(group, search.value);
      paint(search.value);
    });
  }
```

- [ ] **Step 5: Delete the both-ways box and `KeepOnDeviceModal`**

The both-ways box lived inside the old `renderSwitchDivergence` (already removed in Step 2). Now delete the `KeepOnDeviceModal` class (`:2554…` through its closing brace) — its only call site was the removed box. Leave `StopSyncingModal` and the `Modal` import intact.

- [ ] **Step 6: Remove the header `· N device-scoped` duplicate (③)**

Delete the span at `:1577-1580`:

```ts
    const ldCount = this.host.switchMemberDecisions(group.name).length;
    if (ldCount > 0) {
      row.createSpan({ cls: "config-sync-ldnote", text: `· ${ldCount} device-scoped` });
    }
```

(The count now lives only in the bottom scoped disclosure's title.)

- [ ] **Step 7: CSS**

In `styles.css`: remove `.config-sync-divergence { … }` and `.config-sync-divergence-line` rules (`:1376-1385`). Add beside `.config-sync-member-summary` (`:1390`):

```css
.config-sync-summary-line { color: var(--text-normal); font-size: var(--font-ui-smaller); padding: 1px 0; }
.config-sync-summary-caption { color: var(--text-muted); font-size: var(--font-ui-smaller); padding: 4px 0 2px; }
.config-sync-rule-side { color: var(--text-faint); font-size: var(--font-ui-smaller); margin-left: var(--size-4-2); }
```

Grep `config-sync-ldnote` across `src/`; if the header span (Step 6) was its only user, remove its CSS rule (`:1337`) too.

- [ ] **Step 8: Build + gate + manual smoke read**

Run: `npm run build && npx vitest run && npm run lint`
Expected: build clean (Task 2's import is now consumed), all tests pass, lint at/below baseline. No commit.
Then re-read the changed `SyncCenterView.ts` regions to confirm: no remaining reference to `switchSummaryLine`, `config-sync-divergence`, or `KeepOnDeviceModal`; holder order is `topHolder` then `scopedHolder`.

---

### Task 4: Deploy to main / kickstart / llm and live-test (before any cut)

**Not a code task — the test-before-cut step the user mandated.** Do not cut until live-test passes on all three vaults.

- [ ] **Step 1: Build the release artifacts**

Run: `npm run build` (produces `main.js`; `manifest.json` and `styles.css` are at repo root).

- [ ] **Step 2: Deploy to the three vaults**

Copy `main.js`, `manifest.json`, `styles.css` into each vault's `.obsidian/plugins/config-sync/`:
- `kickstart`: `~/local/data/application_data/obsidian/kickstart.vault/.obsidian/plugins/config-sync/`
- `main` and `llm`: confirm each vault's absolute path with the user at this step, then copy the same three files.

Reload each vault (Obsidian command palette → "Reload app without saving", or toggle the plugin off/on) so the new build loads.

- [ ] **Step 3: Live-test checklist (per vault)**

① Leftover safety:
- The `Leftover` tab no longer lists disabled core plugins' configs as "Safe to delete".
- Those configs appear under Core plugins as **To apply** (store has settings, this device doesn't), and clear after Apply.
- A core plugin scoped to another device is neither leftover nor To-apply on the excluded device.

② on/off both-ways:
- A both-ways-divergent Core plugins on/off item shows the **two-line** summary (Apply line then Capture line) + the both-ways caption; no red box, no "Keep N extras" modal.
- "Set a per-plugin rule" lists both sets, each tagged "on here only" / "in store only"; setting a member to **this device** keeps it (old Keep behavior).

③ order/de-dup:
- Body order is summary → "Set a per-plugin rule" → "N scoped to specific devices" (bottom).
- The group header no longer shows "· N device-scoped".
- With an un-captured store, the scoped disclosure and the publish note still render.

- [ ] **Step 4: Report results and STOP**

Report the live-test outcome per vault. If all pass, tell the user the change is ready to cut and wait for their go-ahead — **do not cut or publish autonomously**. If anything fails, treat it as a bug (systematic-debugging), fix, rebuild, redeploy, retest.

---

## Self-Review

- **Spec coverage:** ① registry attribution + scope parity → Task 1 (source) with scope/device-gate inherited via the shared `compileSingleFile`/`groupsForDevice` (no code needed — verified by the state-only-compiles-a-group test + live-test scoped case). ② two-line summary + caption + union rules + delete box/modal → Tasks 2–3. ③ order + header de-dup → Task 3.
- **Placeholder scan:** none — every code step carries real content; the only "confirm at this step" is the main/llm vault paths in the ops task (Task 4), which are runtime facts the user holds.
- **Type consistency:** `switchSummaryLines` returns `SummaryLine[]` (`{dir: Direction; text}`); `renderMemberSummary` consumes `ln.dir` via `ACTION_COLOR_CLASS[ln.dir]` / `renderActionIcon(row, ln.dir)` (Direction = "capture" | "apply", matches `SyncAction` used by those helpers). `renderPerPluginRules` gains `d` and passes it to `memberDivergenceSide`. `pendingScopeMembers` return type unchanged (`string[]`).
- **Test hygiene:** Task 1 flips two existing assertions — this is the intended behavior change (spec-backed), not a test-weakening; call it out to the reviewer. Task 3 is DOM-only with no unit test by repo strategy; its verification is the Task 4 live-test checklist.
