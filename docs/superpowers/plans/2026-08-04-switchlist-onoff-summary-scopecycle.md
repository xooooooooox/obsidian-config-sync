# Switch-list on/off — summary-first block + shared scope cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-member "flood" in the Sync Center's switch-list on/off items (`community-plugins`, `core-plugins`) with a summary line + two collapsible disclosures, and unify the scope control on the Settings panel's click-to-cycle scope icon.

**Architecture:** Extract `renderScopeCycle` (today private in `SettingTab`) into a shared `src/ui/scopeCycle.ts`. Add pure presentation helpers to `panelModel.ts`. Rewrite `SyncCenterView`'s switch-list detail to render: (1) a summary line, (2) a "Set a per-plugin rule" disclosure listing divergent members each with the shared scope-cycle icon, (3) a "N scoped to specific devices" disclosure. The scope-cycle `onChange` composes the *existing, unchanged* host writes (`setMemberEnabledOn` / `addSwitchExceptions` / `clearMemberLocal`), so persisted state and capture/apply/status semantics are untouched.

**Tech Stack:** TypeScript, Vitest (pure-function tests — the repo has no DOM test environment; rendering is verified by typecheck + build + the existing suite). Obsidian plugin UI.

**Spec:** `docs/superpowers/specs/2026-08-04-switchlist-onoff-summary-scopecycle-design.md`

## Global Constraints

- No git commits unless the user explicitly asks; leave changes uncommitted as the review state. (If dispatching subagents that commit: this plan forbids commits — do not commit; no Claude attribution anywhere if that ever changes.)
- No Claude/AI attribution trailer in any commit / PR / issue text.
- Target version 2.15.0 — confirm the exact number at cut; do NOT bump version files in this plan.
- Docs-currency gate before cut (not in this plan's tasks): README + README.zh + ARCHITECTURE + DESIGN + GUIDE updated in the same branch.
- Copy is product-voice: device/consequence language, no implementation terms. Icons follow DESIGN (`SCOPE_ICONS`).
- Behavior invariant: only presentation + control change. The `enabledOn` / `localMembers` / switch-exception writes and all capture/apply/status logic stay exactly as they are.
- Respect the repo test strategy: pure-function unit tests only; no new DOM/render tests.

---

## File Structure

- `src/ui/scopeCycle.ts` — **new.** Shared `renderScopeCycle` free function (moved verbatim from `SettingTab`).
- `src/ui/SettingTab.ts` — **modify.** Import the shared `renderScopeCycle`; delete the private copy.
- `src/ui/panelModel.ts` — **modify.** Add pure helpers (`switchSummaryLine`, `memberScopeWrite`, `pendingScopeMembers`, `memberCurrentScope`, `MemberScopeWrite`). Later remove dead `memberChangeRows`, `whereItRunsEntries`, `MEMBER_BLOCK_TITLE`.
- `src/ui/SyncCenterView.ts` — **modify.** Rewrite switch-list detail rendering; remove `renderMemberBlock` + `openWhereItRunsMenu`; relocate the scoped list into a disclosure; add disclosure/search state.
- `tests/panelModel.test.ts` — **modify.** Add tests for the new pure helpers; remove the `memberChangeRows` and `whereItRunsEntries` describe blocks when those symbols are deleted.

---

### Task 1: Extract `renderScopeCycle` into a shared module

**Files:**
- Create: `src/ui/scopeCycle.ts`
- Modify: `src/ui/SettingTab.ts` (remove private `renderScopeCycle` at ~1004–1024; add import; call sites unchanged)

**Interfaces:**
- Produces: `renderScopeCycle<T extends RuleScope>(cell: HTMLElement, opts: { scope: T; options: readonly T[]; disabled: boolean; note?: string; onChange: (v: T) => void }): void`
- Consumes: `SCOPE_ICONS`, `scopeCycleTooltip`, `nextScope` (from `./itemCard`), `RuleScope` (from `../core/types`), `setIcon` (from `obsidian`).

This is a mechanical move (no logic change), so it is verified by typecheck + build + the existing suite rather than a new DOM test — the cycle logic (`nextScope`) is already covered in `tests/itemCard.test.ts`.

- [ ] **Step 1: Create the shared module**

Create `src/ui/scopeCycle.ts` with the function moved verbatim (converted from a private method to a free function):

```ts
import { setIcon } from "obsidian";
import { RuleScope } from "../core/types";
import { nextScope, SCOPE_ICONS, scopeCycleTooltip } from "./itemCard";

// Commander-style scope control (round-6 定稿, extracted from SettingTab 2026-08-04): a clickable
// icon whose glyph IS the current scope (SCOPE_ICONS); a click advances to the next option in
// `options` and hands the caller the new value — the caller owns the write AND re-rendering this
// cell with the fresh scope. Default "all" renders dim, any narrower scope renders accented,
// mirroring the ghost-rail idle/active language. Shared by the Settings card's "Enabled on" chip
// and the Sync Center's per-plugin rule rows so both teach one gesture.
export function renderScopeCycle<T extends RuleScope>(
  cell: HTMLElement,
  opts: { scope: T; options: readonly T[]; disabled: boolean; note?: string; onChange: (v: T) => void }
): void {
  const icon = cell.createSpan({ cls: `config-sync-scopeicon${opts.scope !== "all" ? " is-set" : ""}` });
  setIcon(icon, SCOPE_ICONS[opts.scope]);
  icon.setAttribute("aria-label", scopeCycleTooltip(opts.scope, opts.note));
  if (opts.disabled) {
    icon.addClass("config-sync-dim");
    return;
  }
  icon.setAttribute("role", "button");
  icon.setAttribute("tabindex", "0");
  const advance = (): void => opts.onChange(nextScope(opts.scope, opts.options));
  icon.addEventListener("click", advance);
  icon.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      advance();
    }
  });
}
```

- [ ] **Step 2: Rewire SettingTab to the shared function**

In `src/ui/SettingTab.ts`: delete the private `renderScopeCycle` method (the `private renderScopeCycle<T ...>(...) { ... }` block at ~1004–1024). Add `import { renderScopeCycle } from "./scopeCycle";` near the other `./` imports. Change the two internal call sites from `this.renderScopeCycle(` to `renderScopeCycle(` (search the file for `this.renderScopeCycle(` — `renderEnabledOnZone` and the per-key/field rule row; update each).

- [ ] **Step 3: Typecheck + build + suite**

Run: `npm run build` then `npm test`
Expected: build succeeds (no `this.renderScopeCycle` references remain); full suite green.

- [ ] **Step 4: Commit** — SKIP. Per Global Constraints, do not commit; leave changes uncommitted.

---

### Task 2: Pure presentation helpers in panelModel (additive)

**Files:**
- Modify: `src/ui/panelModel.ts` (add exports; do NOT remove anything yet)
- Test: `tests/panelModel.test.ts` (add describe blocks)

**Interfaces:**
- Consumes: `RuleScope` (from `../core/types`), `MemberDecision` (already in `panelModel.ts`).
- Produces:
  - `type MemberScopeWrite = { kind: "enabledOn"; scope: "desktop" | "mobile" } | { kind: "local" } | { kind: "clear" }`
  - `memberScopeWrite(scope: RuleScope): MemberScopeWrite`
  - `pendingScopeMembers(d: { captureRemoves: string[]; applyDisables: string[] }): string[]`
  - `memberCurrentScope(decisions: MemberDecision[], id: string): RuleScope`
  - `switchSummaryLine(d: { captureRemoves: string[]; applyDisables: string[] }, device: "desktop" | "mobile"): string | null`

Additive only — old symbols remain so the build/suite stay green until Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `tests/panelModel.test.ts` (import the new names in the top import line):

```ts
describe("memberScopeWrite", () => {
  it("maps each scope to its host write", () => {
    expect(memberScopeWrite("desktop")).toEqual({ kind: "enabledOn", scope: "desktop" });
    expect(memberScopeWrite("mobile")).toEqual({ kind: "enabledOn", scope: "mobile" });
    expect(memberScopeWrite("local")).toEqual({ kind: "local" });
    expect(memberScopeWrite("all")).toEqual({ kind: "clear" });
  });
});

describe("pendingScopeMembers", () => {
  it("returns the apply-direction set when only the store is ahead", () => {
    expect(pendingScopeMembers({ captureRemoves: ["b", "a"], applyDisables: [] })).toEqual(["b", "a"]);
  });
  it("returns the capture-direction set when only this device is ahead", () => {
    expect(pendingScopeMembers({ captureRemoves: [], applyDisables: ["x"] })).toEqual(["x"]);
  });
  it("returns [] when both sides diverge (the red box owns that case)", () => {
    expect(pendingScopeMembers({ captureRemoves: ["a"], applyDisables: ["b"] })).toEqual([]);
  });
});

describe("memberCurrentScope", () => {
  const decisions = [{ id: "git", scope: "desktop" as const }, { id: "rs", scope: "local" as const }];
  it("reads a scoped member's scope", () => {
    expect(memberCurrentScope(decisions, "git")).toBe("desktop");
    expect(memberCurrentScope(decisions, "rs")).toBe("local");
  });
  it("defaults to all for an unscoped member", () => {
    expect(memberCurrentScope(decisions, "dataview")).toBe("all");
  });
});

describe("switchSummaryLine", () => {
  it("apply direction, plural, desktop wording", () => {
    expect(switchSummaryLine({ captureRemoves: ["a", "b"], applyDisables: [] }, "desktop"))
      .toBe("2 plugins are on for your other devices but off this computer — Apply turns them on.");
  });
  it("apply direction, singular, mobile wording", () => {
    expect(switchSummaryLine({ captureRemoves: ["a"], applyDisables: [] }, "mobile"))
      .toBe("1 plugin is on for your other devices but off this phone — Apply turns it on.");
  });
  it("capture direction, plural", () => {
    expect(switchSummaryLine({ captureRemoves: [], applyDisables: ["a", "b"] }, "desktop"))
      .toBe("2 plugins are on this computer but off on your other devices — Capture shares them.");
  });
  it("returns null when both sides diverge", () => {
    expect(switchSummaryLine({ captureRemoves: ["a"], applyDisables: ["b"] }, "desktop")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- panelModel`
Expected: FAIL — the four new describe blocks error on undefined imports.

- [ ] **Step 3: Implement the helpers**

Add to `src/ui/panelModel.ts` (near the existing member helpers; ensure `RuleScope` is imported from `../core/types`):

```ts
export type MemberScopeWrite =
  | { kind: "enabledOn"; scope: "desktop" | "mobile" }
  | { kind: "local" }
  | { kind: "clear" };

// Maps a scope-cycle target to the host write that realizes it (semantics unchanged from the old
// where-it-runs menu): desktop/mobile → setMemberEnabledOn; this-device → addSwitchExceptions;
// all → clearMemberLocal (which clears both a prior enabledOn and a prior this-device exception).
export function memberScopeWrite(scope: RuleScope): MemberScopeWrite {
  if (scope === "desktop" || scope === "mobile") return { kind: "enabledOn", scope };
  if (scope === "local") return { kind: "local" };
  return { kind: "clear" };
}

// The one-sided divergent member set the per-plugin rule list offers. Both-sided divergence is
// owned by the red both-ways box, so this returns [] there.
export function pendingScopeMembers(d: { captureRemoves: string[]; applyDisables: string[] }): string[] {
  if (d.captureRemoves.length > 0 && d.applyDisables.length > 0) return [];
  return d.captureRemoves.length > 0 ? d.captureRemoves : d.applyDisables;
}

// Current scope of a switch-list member: its device rule if it has one, else "all" (no rule).
export function memberCurrentScope(decisions: MemberDecision[], id: string): RuleScope {
  return decisions.find((m) => m.id === id)?.scope ?? "all";
}

// Bulk summary that replaces the per-member flood. One-sided cases only; both-sided → null (the
// red both-ways box states that case). `here` is device-aware.
export function switchSummaryLine(
  d: { captureRemoves: string[]; applyDisables: string[] },
  device: "desktop" | "mobile"
): string | null {
  const here = device === "mobile" ? "this phone" : "this computer";
  if (d.captureRemoves.length > 0 && d.applyDisables.length > 0) return null;
  if (d.captureRemoves.length > 0) {
    const n = d.captureRemoves.length;
    return n === 1
      ? `1 plugin is on for your other devices but off ${here} — Apply turns it on.`
      : `${n} plugins are on for your other devices but off ${here} — Apply turns them on.`;
  }
  if (d.applyDisables.length > 0) {
    const n = d.applyDisables.length;
    return n === 1
      ? `1 plugin is on ${here} but off on your other devices — Capture shares it.`
      : `${n} plugins are on ${here} but off on your other devices — Capture shares them.`;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- panelModel`
Expected: PASS (new blocks green; existing blocks still green).

- [ ] **Step 5: Commit** — SKIP (no commits per Global Constraints).

---

### Task 3: Rewrite the Sync Center switch-list detail

**Files:**
- Modify: `src/ui/SyncCenterView.ts` — `renderItemDetail` (remove the top device-scoped decision loop at ~1669–1680), `renderSwitchDivergence` (~1783–1811), delete `renderMemberBlock` (~1813–1833) and `openWhereItRunsMenu` (~1835–1884); add `renderMemberSummary`, `renderPerPluginRules`, `renderScopedDisclosure`; add disclosure + search state fields.
- Modify: `src/ui/panelModel.ts` — remove now-dead `memberChangeRows`, `whereItRunsEntries`, `MEMBER_BLOCK_TITLE` (and `MemberChangeRow`).
- Modify: `tests/panelModel.test.ts` — delete the `memberChangeRows (spec 2026-07-28 §4)` and `whereItRunsEntries` describe blocks and drop those two names from the import line.

**Interfaces:**
- Consumes: `renderScopeCycle` (Task 1); `switchSummaryLine`, `pendingScopeMembers`, `memberCurrentScope`, `memberScopeWrite` (Task 2); host `switchDivergenceFor`, `switchMemberDecisions`, `isDesktopOnlyPlugin`, `availOf`, `setMemberEnabledOn`, `addSwitchExceptions`, `clearMemberLocal`, `reload`; `memberDecisionsFromScopes`/`MemberDecision` (kept); `FIELD_SCOPE_OPTIONS`, `DESKTOP_ONLY_ENABLED_OPTIONS`, `RuleScope`.
- Produces: no new exported types (view-internal).

No new unit test (view wiring, no DOM test env). Verified by typecheck + build + full suite green with the two dead describe blocks removed.

- [ ] **Step 1: Add view state fields**

In the `SyncCenterView` class field declarations, add:

```ts
private expandedDisclosures = new Set<string>(); // keys: `${group}::rules`, `${group}::scoped`
private ruleSearch = new Map<string, string>();  // per-group per-plugin-rule filter query
```

- [ ] **Step 2: Add a shared onChange helper for member scope writes**

Add a private method that turns a target scope into the existing host write, then reloads:

```ts
private async writeMemberScope(group: string, id: string, scope: RuleScope): Promise<void> {
  const w = memberScopeWrite(scope);
  if (w.kind === "enabledOn") await this.host.setMemberEnabledOn(group, id, w.scope);
  else if (w.kind === "local") await this.host.addSwitchExceptions(group, [id]);
  else await this.host.clearMemberLocal(group, id);
  await this.reload();
}
```

- [ ] **Step 3: Add the three render methods**

```ts
private scopeOptionsFor(id: string): readonly RuleScope[] {
  const desktopOnly = this.host.isDesktopOnlyPlugin(id) ?? this.availOf(`plugin-${id}`).desktopOnly;
  return desktopOnly ? DESKTOP_ONLY_ENABLED_OPTIONS : FIELD_SCOPE_OPTIONS;
}

private renderMemberSummary(holder: HTMLElement, r: StatusRow, d: { captureRemoves: string[]; applyDisables: string[] }): void {
  const text = switchSummaryLine(d, Platform.isMobile ? "mobile" : "desktop");
  if (text !== null) holder.createDiv({ cls: "config-sync-member-summary", text });
}

private renderDisclosure(holder: HTMLElement, key: string, title: string, amber: boolean, body: (el: HTMLElement) => void): void {
  const open = this.expandedDisclosures.has(key);
  const head = holder.createDiv({ cls: `config-sync-disclosure${amber ? " is-amber" : ""}` });
  head.createSpan({ cls: "config-sync-disclosure-cx", text: open ? "▾" : "▸" });
  head.appendText(` ${title}`);
  const panel = holder.createDiv({ cls: "config-sync-disclosure-body" });
  panel.hidden = !open;
  if (open) body(panel);
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    if (this.expandedDisclosures.has(key)) this.expandedDisclosures.delete(key);
    else this.expandedDisclosures.add(key);
    this.render(this.renderGen);
  });
}

private renderPerPluginRules(holder: HTMLElement, r: StatusRow, members: string[]): void {
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

private renderScopedDisclosure(holder: HTMLElement, r: StatusRow): void {
  const group = r.group.name;
  const decisions = this.host.switchMemberDecisions(group);
  if (decisions.length === 0) return;
  this.renderDisclosure(holder, `${group}::scoped`, `${decisions.length} scoped to specific devices`, true, (panel) => {
    for (const m of decisions) {
      const row = panel.createDiv({ cls: "config-sync-rule-row" });
      row.createSpan({ cls: "config-sync-rule-mid", text: m.id });
      const cell = row.createSpan();
      renderScopeCycle(cell, {
        scope: m.scope,
        options: this.scopeOptionsFor(m.id),
        disabled: false,
        onChange: (v) => void this.writeMemberScope(group, m.id, v),
      });
    }
  });
}
```

- [ ] **Step 4: Rewrite `renderSwitchDivergence` to use the new pieces**

Replace the body after the both-ways red box with the summary + disclosures. The both-ways `config-sync-divergence` box and its `KeepOnDeviceModal` button stay unchanged. Replace the final `if (MEMBER_GUIDE_GROUPS.has(r.group.name)) this.renderMemberBlock(holder, r, d);` with:

```ts
      if (MEMBER_GUIDE_GROUPS.has(r.group.name)) {
        this.renderMemberSummary(holder, r, d);
        const members = pendingScopeMembers(d);
        if (members.length > 0) {
          this.renderDisclosure(holder, `${r.group.name}::rules`, "Set a per-plugin rule", false, (panel) =>
            this.renderPerPluginRules(panel, r, members)
          );
        }
        this.renderScopedDisclosure(holder, r);
      }
```

- [ ] **Step 5: Remove the top decision loop from `renderItemDetail`**

Delete the device-scoped decision loop (the `const decisions = this.host.switchMemberDecisions(...)` block that renders `⌂`/`monitor`/`smartphone` rows and the `MEMBER_PUBLISH_NOTE` line, ~1669–1680) — the scoped members now render inside `renderScopedDisclosure`. Preserve the `MEMBER_PUBLISH_NOTE` reminder by moving it into `renderSwitchDivergence` after the disclosures, gated on the same condition (`decisions.length > 0 && this.selfInfo !== null && (this.selfInfo.state === "capture" || this.selfInfo.state === "both")`). Keep the later `in-sync` branch's `decisions.length > 0 ? "in sync — this device's own plugins aren't compared" : "identical to the store"` note (it reads `decisions` for a count only — recompute it locally there if the earlier `const` is gone).

- [ ] **Step 6: Delete `renderMemberBlock` and `openWhereItRunsMenu`**

Remove both methods entirely. Remove now-unused imports in `SyncCenterView.ts`: `memberChangeRows`, `MEMBER_BLOCK_TITLE`, `whereItRunsEntries`, `MemberChangeRow`, and (if unused after this) `Menu`, `renderActionIcon`/`ACTION_COLOR_CLASS` where they were only the member block's — verify each is not used elsewhere before removing. Add imports: `renderScopeCycle` from `./scopeCycle`; `switchSummaryLine`, `pendingScopeMembers`, `memberCurrentScope`, `memberScopeWrite` from `./panelModel`; `FIELD_SCOPE_OPTIONS`, `DESKTOP_ONLY_ENABLED_OPTIONS` from `./itemCard`; `RuleScope` from `../core/types` (if not already imported).

- [ ] **Step 7: Remove dead panelModel symbols + their tests**

In `src/ui/panelModel.ts` delete `MEMBER_BLOCK_TITLE`, `MemberChangeRow`, `memberChangeRows`, and `whereItRunsEntries`. Keep `MEMBER_PUBLISH_NOTE`, `memberDecisionsFromScopes`, `memberDecisionText`, `MemberDecision`. In `tests/panelModel.test.ts` delete the `describe("memberChangeRows ...")` and `describe("whereItRunsEntries")` blocks and remove `memberChangeRows`, `whereItRunsEntries` from the import line.

- [ ] **Step 8: Add minimal CSS**

In the plugin stylesheet (`styles.css`), add classes referenced above so they render sanely: `.config-sync-member-summary`, `.config-sync-disclosure` (+ `.is-amber`, `-cx`, `-body`), `.config-sync-rule-search`, `.config-sync-rule-list`, `.config-sync-rule-row`, `.config-sync-rule-mid`. Reuse existing spacing/color variables; follow DESIGN. The scope icon reuses the existing `.config-sync-scopeicon` / `.is-set` / `.config-sync-dim` styles (shared with Settings — no new rules needed for it).

- [ ] **Step 9: Typecheck + build + full suite**

Run: `npm run build` then `npm test`
Expected: build clean (no references to `renderMemberBlock`, `openWhereItRunsMenu`, `memberChangeRows`, `whereItRunsEntries`, `MEMBER_BLOCK_TITLE`); full suite green (two describe blocks removed, four added in Task 2).

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: 0 errors; warnings at or below the established baseline (57–58). Fix any new error introduced by the edits.

- [ ] **Step 11: Commit** — SKIP (no commits per Global Constraints).

---

## Self-Review

**Spec coverage:**
- §1 summary line → Task 2 `switchSummaryLine` + Task 3 `renderMemberSummary`. ✓
- §2 "Set a per-plugin rule" disclosure (search + scope-cycle rows) → Task 3 `renderDisclosure` + `renderPerPluginRules`. ✓
- §3 "N scoped to specific devices" disclosure → Task 3 `renderScopedDisclosure`; top decision loop removed (Step 5). ✓
- §4 shared `renderScopeCycle`, carrier-based onChange composing existing writes → Task 1 + Task 3 `writeMemberScope` (mapping via Task 2 `memberScopeWrite`). ✓
- Both-ways red box unchanged; summary omitted there → `switchSummaryLine`/`pendingScopeMembers` return null/[] (Task 2), box left intact (Task 3 Step 4). ✓
- Publish reminder preserved → Task 3 Step 5. ✓
- Menu path removed → Task 3 Step 6/7. ✓
- Invariant (writes unchanged) → `writeMemberScope` calls the same host methods; no host code touched. ✓

**Placeholder scan:** No TBD/TODO; every code step carries real code. CSS (Step 8) names concrete classes; exact rules are left to DESIGN conventions, which is a deliberate scope note, not a placeholder.

**Type consistency:** `renderScopeCycle` signature identical across Task 1 producer and Task 3 consumers. `MemberScopeWrite` kinds (`enabledOn`/`local`/`clear`) map 1:1 to `setMemberEnabledOn`/`addSwitchExceptions`/`clearMemberLocal` in `writeMemberScope`. `switchMemberDecisions` returns `MemberDecision[]` consumed by `memberCurrentScope` and `renderScopedDisclosure`. Scope option lists (`FIELD_SCOPE_OPTIONS` / `DESKTOP_ONLY_ENABLED_OPTIONS`) match `renderScopeCycle`'s `options` param type.
