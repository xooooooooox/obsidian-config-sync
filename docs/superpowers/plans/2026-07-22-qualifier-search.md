# Qualifier Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google/git-style `key:value` qualifier parsing plus an autocomplete dropdown to both searchbars (SettingTab "Search all settings…" and Sync Center "Filter by name…").

**Architecture:** One new module `src/ui/qualifierSearch.ts` holds all shared logic — a pure parser (`parseQuery`), a pure generic matcher (`matchesQualifiers`), a pure suggestion generator (`suggest` + `applySuggestion`), and one imperative DOM widget class (`QualifierAutocomplete`). Each searchbar supplies its own curated `QualifierSpec[]`, `validKeys` set, and `resolvers` map; the pure helpers do the rest. Filtering stays each view's job — the widget only rewrites `input.value` and dispatches a native `input` event.

**Tech Stack:** TypeScript, Obsidian API (`setIcon`), vitest (node env — no DOM tests), esbuild.

## Global Constraints

- No hardcoded colors — theme vars only; alpha as `rgba(var(--*-rgb), α)`. `./scripts/check-no-hardcoded-color.sh` must pass.
- eslint: 0 errors, warning baseline **67** — do not exceed. Disclose+justify any unavoidable new warning.
- `npx tsc -noEmit -skipLibCheck` clean · `npm test` green · `npm run build` clean.
- No emoji in UI copy — Lucide icons via `setIcon` only. UI copy in sentence case (`obsidianmd/ui/sentence-case`).
- Vocabulary is fixed (see spec `docs/superpowers/specs/2026-07-22-qualifier-search-design.md`):
  - **Sync Center:** `type:` file·folder · `scope:` obsidian·core·community·beta·custom · `action:` capture·apply·ok·none · `mode:` plain·fields·encrypted · `device:` all·desktop·mobile
  - **SettingTab:** `scope:` general·obsidian·core·community·advanced·remotes · `type:` file·folder
- Deploy to dev vault for live-verify: `npm run smoke:install` (builds + copies to `dev/vault/.obsidian/plugins/config-sync/`); reload via obsidian-cli run from `dev/vault/`.

---

### Task 1: Pure parser — `parseQuery` + `applySuggestion`

**Files:**
- Create: `src/ui/qualifierSearch.ts`
- Test: `tests/qualifierSearch.test.ts`

**Interfaces:**
- Produces: `interface Qualifier { key: string; value: string }`, `interface ParsedQuery { text: string; qualifiers: Qualifier[] }`, `function parseQuery(raw: string, validKeys: ReadonlySet<string>): ParsedQuery`, `function applySuggestion(raw: string, insert: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/qualifierSearch.test.ts
import { describe, expect, it } from "vitest";
import { parseQuery, applySuggestion } from "../src/ui/qualifierSearch";

const KEYS = new Set(["type", "scope", "action", "mode", "device"]);

describe("parseQuery", () => {
  it("empty → no text, no qualifiers", () => {
    expect(parseQuery("", KEYS)).toEqual({ text: "", qualifiers: [] });
  });
  it("plain words → text only", () => {
    expect(parseQuery("hot keys", KEYS)).toEqual({ text: "hot keys", qualifiers: [] });
  });
  it("single qualifier", () => {
    expect(parseQuery("type:folder", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "folder" }] });
  });
  it("multiple qualifiers AND, mixed with text, any order", () => {
    expect(parseQuery("snippets scope:community type:folder", KEYS)).toEqual({
      text: "snippets",
      qualifiers: [{ key: "scope", value: "community" }, { key: "type", value: "folder" }],
    });
  });
  it("unknown key → literal free text", () => {
    expect(parseQuery("foo:bar type:file", KEYS)).toEqual({
      text: "foo:bar",
      qualifiers: [{ key: "type", value: "file" }],
    });
  });
  it("key and value are case-insensitive (lowercased)", () => {
    expect(parseQuery("Type:Folder", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "folder" }] });
  });
  it("empty value kept (mid-typing)", () => {
    expect(parseQuery("type:", KEYS)).toEqual({ text: "", qualifiers: [{ key: "type", value: "" }] });
  });
  it("quoted value keeps spaces, quotes stripped", () => {
    expect(parseQuery('scope:"a b" plain', KEYS)).toEqual({
      text: "plain",
      qualifiers: [{ key: "scope", value: "a b" }],
    });
  });
  it("quoted free text has quotes stripped", () => {
    expect(parseQuery('"a b" type:file', KEYS)).toEqual({
      text: "a b",
      qualifiers: [{ key: "type", value: "file" }],
    });
  });
});

describe("applySuggestion", () => {
  it("replaces the only token", () => {
    expect(applySuggestion("ty", "type:")).toBe("type:");
  });
  it("replaces just the last token, preserving earlier ones", () => {
    expect(applySuggestion("scope:core ty", "type:")).toBe("scope:core type:");
  });
  it("completes a value token in place", () => {
    expect(applySuggestion("type:fo", "type:folder ")).toBe("type:folder ");
  });
  it("appends when input ends with a space", () => {
    expect(applySuggestion("type:folder ", "scope:")).toBe("type:folder scope:");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: FAIL — module has no exports yet.

- [ ] **Step 3: Implement**

```ts
// src/ui/qualifierSearch.ts
export interface Qualifier {
  key: string;
  value: string;
}

export interface ParsedQuery {
  text: string;
  qualifiers: Qualifier[];
}

// Match either `key:"quoted value"`, a bare `"quoted value"`, or a whitespace-run token.
const TOKEN_RE = /[^\s:"]+:"[^"]*"|"[^"]*"|\S+/g;
const KEYVAL_RE = /^([A-Za-z][\w-]*):(.*)$/;

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseQuery(raw: string, validKeys: ReadonlySet<string>): ParsedQuery {
  const qualifiers: Qualifier[] = [];
  const textParts: string[] = [];
  for (const token of raw.match(TOKEN_RE) ?? []) {
    const m = KEYVAL_RE.exec(token);
    if (m !== null && validKeys.has(m[1].toLowerCase())) {
      qualifiers.push({ key: m[1].toLowerCase(), value: stripQuotes(m[2]).toLowerCase() });
      continue;
    }
    textParts.push(stripQuotes(token));
  }
  return { text: textParts.join(" "), qualifiers };
}

// Replace the last whitespace-delimited token of `raw` with `insert` (an autocomplete completion).
export function applySuggestion(raw: string, insert: string): string {
  const start = raw.search(/\S*$/); // index where the trailing non-space run begins (raw.length if trailing space)
  return raw.slice(0, start) + insert;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: PASS (12 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/ui/qualifierSearch.ts tests/qualifierSearch.test.ts
git commit -m "feat(search): qualifier query parser + applySuggestion"
```

---

### Task 2: Pure matcher + suggestions — `matchesQualifiers` + `suggest`

**Files:**
- Modify: `src/ui/qualifierSearch.ts`
- Test: `tests/qualifierSearch.test.ts`

**Interfaces:**
- Consumes: `Qualifier` (Task 1).
- Produces:
  - `type QualifierResolver<T> = (item: T) => string | string[] | null`
  - `function matchesQualifiers<T>(item: T, qualifiers: readonly Qualifier[], resolvers: Record<string, QualifierResolver<T>>): boolean`
  - `interface QualifierValue { value: string; description?: string }`
  - `interface QualifierSpec { key: string; description?: string; values: QualifierValue[] }`
  - `interface Suggestion { display: string; insert: string; description?: string; kind: "key" | "value" }`
  - `function suggest(token: string, specs: readonly QualifierSpec[]): Suggestion[]`

- [ ] **Step 1: Write the failing tests** (append to `tests/qualifierSearch.test.ts`)

```ts
import { matchesQualifiers, suggest, type QualifierSpec } from "../src/ui/qualifierSearch";

interface Row { t: string; tags: string[]; opt: string | null }
const RESOLVERS = {
  type: (r: Row) => r.t,
  tag: (r: Row) => r.tags,
  opt: (r: Row) => r.opt,
};

describe("matchesQualifiers", () => {
  const row: Row = { t: "folder", tags: ["a", "b"], opt: null };
  it("no qualifiers → matches", () => {
    expect(matchesQualifiers(row, [], RESOLVERS)).toBe(true);
  });
  it("single scalar match, case-insensitive", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }], RESOLVERS)).toBe(true);
    expect(matchesQualifiers(row, [{ key: "type", value: "file" }], RESOLVERS)).toBe(false);
  });
  it("AND across qualifiers", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }, { key: "tag", value: "a" }], RESOLVERS)).toBe(true);
    expect(matchesQualifiers(row, [{ key: "type", value: "folder" }, { key: "tag", value: "z" }], RESOLVERS)).toBe(false);
  });
  it("array resolver matches any element", () => {
    expect(matchesQualifiers(row, [{ key: "tag", value: "b" }], RESOLVERS)).toBe(true);
  });
  it("empty value is a no-op", () => {
    expect(matchesQualifiers(row, [{ key: "type", value: "" }], RESOLVERS)).toBe(true);
  });
  it("null resolver result → no match", () => {
    expect(matchesQualifiers(row, [{ key: "opt", value: "x" }], RESOLVERS)).toBe(false);
  });
  it("unknown key is skipped (defensive)", () => {
    expect(matchesQualifiers(row, [{ key: "nope", value: "x" }], RESOLVERS)).toBe(true);
  });
});

const SPECS: QualifierSpec[] = [
  { key: "type", description: "kind", values: [{ value: "file" }, { value: "folder" }] },
  { key: "scope", description: "area", values: [{ value: "core" }, { value: "community" }] },
];

describe("suggest", () => {
  it("empty token → all keys", () => {
    expect(suggest("", SPECS).map((s) => s.insert)).toEqual(["type:", "scope:"]);
  });
  it("key prefix filters keys", () => {
    expect(suggest("sc", SPECS).map((s) => s.insert)).toEqual(["scope:"]);
  });
  it("key: → that key's values, with trailing space", () => {
    expect(suggest("type:", SPECS).map((s) => s.insert)).toEqual(["type:file ", "type:folder "]);
  });
  it("value prefix filters values", () => {
    expect(suggest("scope:comm", SPECS).map((s) => s.insert)).toEqual(["scope:community "]);
  });
  it("unknown key before colon → no suggestions", () => {
    expect(suggest("bogus:x", SPECS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement** (append to `src/ui/qualifierSearch.ts`)

```ts
export type QualifierResolver<T> = (item: T) => string | string[] | null;

// AND across qualifiers. Empty-value qualifiers and keys with no resolver are skipped; a
// qualifier matches when any resolved value equals it (case-insensitive). A null resolver
// result means the qualifier cannot be satisfied → the item is excluded.
export function matchesQualifiers<T>(
  item: T,
  qualifiers: readonly Qualifier[],
  resolvers: Record<string, QualifierResolver<T>>,
): boolean {
  for (const q of qualifiers) {
    if (q.value === "") continue;
    const resolver = resolvers[q.key];
    if (resolver === undefined) continue;
    const got = resolver(item);
    if (got === null) return false;
    const vals = Array.isArray(got) ? got : [got];
    if (!vals.some((v) => v.toLowerCase() === q.value)) return false;
  }
  return true;
}

export interface QualifierValue {
  value: string;
  description?: string;
}

export interface QualifierSpec {
  key: string;
  description?: string;
  values: QualifierValue[];
}

export interface Suggestion {
  display: string;
  insert: string;
  description?: string;
  kind: "key" | "value";
}

// currentToken = the last whitespace-delimited fragment of the input (caret assumed at end).
export function suggest(token: string, specs: readonly QualifierSpec[]): Suggestion[] {
  const colon = token.indexOf(":");
  if (colon === -1) {
    const p = token.toLowerCase();
    return specs
      .filter((s) => s.key.startsWith(p))
      .map((s) => ({ display: `${s.key}:`, insert: `${s.key}:`, description: s.description, kind: "key" as const }));
  }
  const key = token.slice(0, colon).toLowerCase();
  const spec = specs.find((s) => s.key === key);
  if (spec === undefined) return [];
  const vp = token.slice(colon + 1).replace(/^"/, "").toLowerCase();
  return spec.values
    .filter((v) => v.value.startsWith(vp))
    .map((v) => ({ display: `${key}:${v.value}`, insert: `${key}:${v.value} `, description: v.description, kind: "value" as const }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: PASS (all Task 1 + Task 2 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/ui/qualifierSearch.ts tests/qualifierSearch.test.ts
git commit -m "feat(search): generic qualifier matcher + suggestion generator"
```

---

### Task 3: Autocomplete DOM widget — `QualifierAutocomplete` + styles

**Files:**
- Modify: `src/ui/qualifierSearch.ts` (append the class)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `suggest`, `applySuggestion`, `QualifierSpec`, `Suggestion` (Tasks 1–2).
- Produces: `class QualifierAutocomplete { constructor(specs: readonly QualifierSpec[]); attach(input: HTMLInputElement): void; destroy(): void }`.

**Context:** This is the only imperative piece and is NOT unit-tested (vitest runs in node — no DOM). It is verified live. It must survive Sync Center's full re-render-on-keystroke: the sidebar search handler calls `this.render()` on every keystroke, recreating the input, so `attach()` is called with a fresh input each keystroke and must preserve the dropdown's open state. The dropdown is a child of the input's parent (which the caller sets `position: relative`), rebuilt on each `attach`/input.

- [ ] **Step 1: Implement the widget** (append to `src/ui/qualifierSearch.ts`)

```ts
import { setIcon } from "obsidian";

// Autocomplete dropdown for a qualifier searchbar. Attaches to an <input>; on input it renders
// key/value suggestions under the input's parent (caller must set the parent position:relative).
// Selecting a suggestion rewrites input.value via applySuggestion and dispatches a native "input"
// event so the host view's own handler re-runs the filter — the widget never filters itself.
export class QualifierAutocomplete {
  private input: HTMLInputElement | null = null;
  private dropdown: HTMLElement | null = null;
  private items: Suggestion[] = [];
  private selected = 0;
  private open = false;
  private readonly onInput = (): void => this.refresh(true);
  private readonly onKeydown = (e: KeyboardEvent): void => this.handleKey(e);
  private readonly onBlur = (): void => window.setTimeout(() => this.close(), 120);
  private readonly onDocPointer = (e: MouseEvent): void => {
    const parent = this.input?.parentElement ?? null;
    if (parent !== null && e.target instanceof Node && !parent.contains(e.target)) this.close();
  };

  constructor(private readonly specs: readonly QualifierSpec[]) {}

  attach(input: HTMLInputElement): void {
    this.detach();
    this.input = input;
    input.addEventListener("input", this.onInput);
    input.addEventListener("keydown", this.onKeydown);
    input.addEventListener("blur", this.onBlur);
    if (this.open) this.refresh(false); // re-render after a host full re-render recreated the input
  }

  destroy(): void {
    this.detach();
    this.open = false;
  }

  private detach(): void {
    document.removeEventListener("pointerdown", this.onDocPointer, true);
    this.removeDropdown();
    if (this.input !== null) {
      this.input.removeEventListener("input", this.onInput);
      this.input.removeEventListener("keydown", this.onKeydown);
      this.input.removeEventListener("blur", this.onBlur);
    }
    this.input = null;
  }

  private lastToken(): string {
    const v = this.input?.value ?? "";
    return v.slice(v.search(/\S*$/));
  }

  private refresh(openIfHits: boolean): void {
    if (this.input === null) return;
    this.items = suggest(this.lastToken(), this.specs);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    if (openIfHits) this.open = true;
    if (!this.open) return;
    this.selected = Math.min(this.selected, this.items.length - 1);
    this.renderDropdown();
  }

  private renderDropdown(): void {
    if (this.input === null) return;
    const parent = this.input.parentElement;
    if (parent === null) return;
    this.removeDropdown();
    const dd = parent.createDiv({ cls: "config-sync-qac" });
    this.items.forEach((s, i) => {
      const row = dd.createDiv({ cls: `config-sync-qac-opt${i === this.selected ? " is-sel" : ""}` });
      const ic = row.createSpan({ cls: "config-sync-qac-ic" });
      setIcon(ic, s.kind === "key" ? "chevron-right" : "check");
      row.createSpan({ cls: "config-sync-qac-txt", text: s.display });
      if (s.description !== undefined) row.createSpan({ cls: "config-sync-qac-desc", text: s.description });
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // keep focus in the input
        this.apply(i);
      });
    });
    this.dropdown = dd;
    document.addEventListener("pointerdown", this.onDocPointer, true);
  }

  private removeDropdown(): void {
    this.dropdown?.remove();
    this.dropdown = null;
  }

  private close(): void {
    this.open = false;
    this.removeDropdown();
    document.removeEventListener("pointerdown", this.onDocPointer, true);
  }

  private apply(i: number): void {
    if (this.input === null) return;
    this.input.value = applySuggestion(this.input.value, this.items[i].insert);
    this.selected = 0;
    this.input.focus();
    this.input.dispatchEvent(new Event("input")); // host re-runs its filter; may re-create the input
    this.refresh(true); // show the next level (values after a key)
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.open || this.items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = (this.selected + 1) % this.items.length;
      this.renderDropdown();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = (this.selected - 1 + this.items.length) % this.items.length;
      this.renderDropdown();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      this.apply(this.selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }
}
```

Note: place the `import { setIcon } from "obsidian";` at the TOP of the file with the other imports, not mid-file.

- [ ] **Step 2: Add styles** (append to `styles.css` — theme vars only)

```css
/* Qualifier-search autocomplete dropdown */
.config-sync-qac {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: var(--layer-popover);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-s);
  overflow: hidden;
}
.config-sync-qac-opt {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  padding: var(--size-4-1) var(--size-4-3);
  cursor: pointer;
  font-size: var(--font-ui-small);
}
.config-sync-qac-opt.is-sel {
  background: var(--background-modifier-hover);
}
.config-sync-qac-ic {
  display: inline-flex;
  color: var(--text-muted);
}
.config-sync-qac-ic svg {
  width: var(--icon-xs);
  height: var(--icon-xs);
}
.config-sync-qac-txt {
  color: var(--text-normal);
  font-family: var(--font-monospace);
}
.config-sync-qac-desc {
  margin-left: auto;
  color: var(--text-faint);
  font-size: var(--font-ui-smaller);
}
```

- [ ] **Step 3: Verify gates**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx tsc -noEmit -skipLibCheck && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build`
Expected: tsc clean; eslint 0 errors / ≤67 warnings; color check OK; build OK. (No new tests — DOM widget is live-verified in Tasks 4–5.)

- [ ] **Step 4: Commit**

```bash
git add src/ui/qualifierSearch.ts styles.css
git commit -m "feat(search): qualifier autocomplete dropdown widget"
```

---

### Task 4: Sync Center integration

**Files:**
- Modify: `src/ui/SyncCenterView.ts`
- Test: `tests/qualifierSearch.test.ts` (resolver-value helpers)

**Interfaces:**
- Consumes: `parseQuery`, `matchesQualifiers`, `QualifierAutocomplete`, `QualifierSpec`, `QualifierResolver` (Tasks 1–3), and existing view methods `scopeOf(name)`, `presState(r)`, `visibleUnderFilter`, `matchesSearch`, `host.displayName`.
- Produces (exported pure helpers for testing): `syncTypeValue`, `syncModeValue`, `syncActionValue`.

**Context:** `matchesSearch(\`${displayName} ${name}\`, this.search)` is called at 5 sites (`:692`, `:1092`, `:1162`, `:1272`, `:1298`). Route all 5 through one new `rowMatchesSearch(r)`. The view has TWO inputs (sidebar `config-sync-side-search`, compact `config-sync-mainbar-search`); attach one shared `QualifierAutocomplete` instance to whichever renders. Do NOT touch the existing pill-reset-on-search behavior.

- [ ] **Step 1: Write failing resolver-value tests** (append to `tests/qualifierSearch.test.ts`)

```ts
import { syncTypeValue, syncModeValue, syncActionValue } from "../src/ui/SyncCenterView";

describe("sync resolver values", () => {
  it("type: dir → folder, file → file", () => {
    expect(syncTypeValue({ type: "dir" } as never)).toBe("folder");
    expect(syncTypeValue({ type: "file" } as never)).toBe("file");
  });
  it("mode: absent → plain, else the mode", () => {
    expect(syncModeValue({} as never)).toBe("plain");
    expect(syncModeValue({ mode: "fields" } as never)).toBe("fields");
    expect(syncModeValue({ mode: "encrypted" } as never)).toBe("encrypted");
  });
  it("action: state → PanelFilter bucket, locked → null", () => {
    expect(syncActionValue("local-changed")).toBe("capture");
    expect(syncActionValue("not-captured")).toBe("capture");
    expect(syncActionValue("store-newer")).toBe("apply");
    expect(syncActionValue("differs")).toBe("apply");
    expect(syncActionValue("in-sync")).toBe("ok");
    expect(syncActionValue("no-settings")).toBe("none");
    expect(syncActionValue("locked")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add exported pure helpers + specs** (top of `src/ui/SyncCenterView.ts`, after imports; add `QualifierAutocomplete`, `parseQuery`, `matchesQualifiers`, and the spec/resolver types to the `./qualifierSearch` import)

```ts
import {
  QualifierAutocomplete,
  parseQuery,
  matchesQualifiers,
  type QualifierSpec,
  type QualifierResolver,
} from "./qualifierSearch";
import type { SyncGroup } from "../core/types"; // if not already imported — SyncGroup is already imported at line 5, reuse it
```

```ts
// --- Qualifier search vocabulary (Sync Center) ---
export function syncTypeValue(g: SyncGroup): "file" | "folder" {
  return g.type === "dir" ? "folder" : "file";
}
export function syncModeValue(g: SyncGroup): string {
  return g.mode ?? "plain";
}
// The row's PanelFilter bucket, mirroring the state-filter pills. locked → null (no bucket).
export function syncActionValue(state: GroupState): "capture" | "apply" | "ok" | "none" | null {
  for (const f of ["capture", "apply", "ok", "none"] as const) {
    if (visibleUnderFilter(state, f)) return f;
  }
  return null;
}

const SYNC_QUALIFIER_SPECS: QualifierSpec[] = [
  { key: "type", description: "group kind", values: [{ value: "file", description: "single-file group" }, { value: "folder", description: "directory group" }] },
  { key: "scope", description: "category", values: [{ value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "beta" }, { value: "custom" }] },
  { key: "action", description: "what it needs", values: [{ value: "capture", description: "needs capture" }, { value: "apply", description: "needs apply" }, { value: "ok", description: "in sync" }, { value: "none", description: "no settings yet" }] },
  { key: "mode", description: "field handling", values: [{ value: "plain" }, { value: "fields" }, { value: "encrypted" }] },
  { key: "device", description: "device class", values: [{ value: "all" }, { value: "desktop" }, { value: "mobile" }] },
];
const SYNC_QUALIFIER_KEYS = new Set(SYNC_QUALIFIER_SPECS.map((s) => s.key));
```

Note: `visibleUnderFilter` is already imported from `./panelModel` (line 27); `GroupState` from `../core/status` (line 3); `SyncGroup` from `../core/types` (line 5). Do not add duplicate imports.

- [ ] **Step 4: Add `rowMatchesSearch` + resolvers as view methods**

Add fields/methods to the `SyncCenterView` class:

```ts
private readonly qac = new QualifierAutocomplete(SYNC_QUALIFIER_SPECS);

private syncResolvers(): Record<string, QualifierResolver<StatusRow>> {
  return {
    type: (r) => syncTypeValue(r.group),
    scope: (r) => this.scopeOf(r.group.name),
    action: (r) => syncActionValue(this.presState(r)),
    mode: (r) => syncModeValue(r.group),
    device: (r) => r.group.devices,
  };
}

private rowMatchesSearch(r: StatusRow): boolean {
  const parsed = parseQuery(this.search, SYNC_QUALIFIER_KEYS);
  return (
    matchesQualifiers(r, parsed.qualifiers, this.syncResolvers()) &&
    matchesSearch(`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}`, parsed.text)
  );
}
```

- [ ] **Step 5: Route the 5 call sites through `rowMatchesSearch`**

Replace each occurrence of
`matchesSearch(\`${this.host.displayName(r.group.name, r.group.label)} ${r.group.name}\`, this.search)`
with `this.rowMatchesSearch(r)` at:
- `:692` (sidebar hit counts, inside `scopeRows.filter(...)`)
- `:1092` (pill counts, `mainRows.filter(...)`)
- `:1162` (`visibleRows`: keep the `visibleUnderFilter(this.presState(r), this.filter) && …` conjunction, replace only the `matchesSearch(...)` half)
- `:1272` (`renderInfoSection` matches)
- `:1298` (`renderSection` matches)

After this, if `matchesSearch` has no remaining references in the file, remove it from the `./panelModel` import (it is still exported for other callers — do not delete the function).

- [ ] **Step 6: Attach autocomplete to both inputs**

In `renderSidebar` (after `searchEl.value = this.search;` around `:660`): wrap and attach.

```ts
// searchEl's parent must be position:relative for the dropdown. The .config-sync-side already
// is the flex column; wrap the input so the dropdown anchors to the input, not the whole side.
const searchWrap = side.createDiv({ cls: "config-sync-search-wrap" }); // create BEFORE the input
// (Restructure: create searchWrap first, then create searchEl inside searchWrap instead of side.)
```

Concretely, change the input creation so it lives inside a `config-sync-search-wrap` div, then at the end of `renderSidebar` (before `this.renderScopeEntries(side)` or after creating the input) call:

```ts
this.qac.attach(searchEl);
```

In `renderItemMode`, the compact branch (`:1076`): likewise create the input inside a `config-sync-search-wrap` div and call `this.qac.attach(searchEl);` right after wiring its `input` listener (after the block ending `:1156`). Because only one of the two inputs exists per render, the single `qac` instance is correct.

Add to `styles.css`:
```css
.config-sync-search-wrap {
  position: relative;
}
```

- [ ] **Step 7: Run gates**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run && npx tsc -noEmit -skipLibCheck && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build`
Expected: tests green (incl. new resolver tests); tsc clean; eslint 0 errors / ≤67 warnings; color OK; build OK.

- [ ] **Step 8: Live-verify on dev vault**

Run: `cd ~/local/coding/open/obsidian-config-sync && npm run smoke:install`, reload plugin via obsidian-cli (from `dev/vault/`), open Sync Center. Verify:
- Typing `ty` shows a `type:` key suggestion; selecting it (Enter) fills `type:` and immediately shows `file`/`folder` value suggestions.
- `type:folder` filters rows to directory groups; adding ` scope:community` narrows to community folder groups (AND).
- `action:capture` shows only to-capture rows; `device:desktop` shows desktop-only groups; `mode:fields` shows field-mode file groups.
- Free text still works; `foo:bar` behaves as literal text (likely 0 matches).
- ↑/↓ move the highlight, Esc closes, click-away closes, dropdown survives continued typing (does not vanish each keystroke).

- [ ] **Step 9: Commit**

```bash
git add src/ui/SyncCenterView.ts tests/qualifierSearch.test.ts styles.css
git commit -m "feat(search): qualifier search in Sync Center filter"
```

---

### Task 5: SettingTab integration

**Files:**
- Modify: `src/ui/SettingTab.ts`
- Test: `tests/qualifierSearch.test.ts` (resolver-value helpers)

**Interfaces:**
- Consumes: `parseQuery`, `matchesQualifiers`, `QualifierAutocomplete`, `QualifierSpec`, `QualifierResolver` (Tasks 1–3), existing `SearchHit`, `buildSearchIndex`, `renderSearchResults`, `renderSearchBox`.
- Produces (exported pure helpers): `settingScopeValue(scope: SearchHit["scope"]): string`, `settingTypeValue(hit: Pick<SearchHit, "item">): "file" | "folder" | null`.

**Context:** The search box (`renderSearchBox`, `:274`) persists across keystrokes (only `renderBody` re-renders on input via `onChange`), so attach the widget once when the box is created, using `search.inputEl`. `renderSearchResults` (`:1189`) currently matches the raw query — switch it to qualifier-gate + free-text. Scope pills (`:1191`+) stay untouched and AND independently.

- [ ] **Step 1: Write failing resolver-value tests** (append to `tests/qualifierSearch.test.ts`)

```ts
import { settingScopeValue, settingTypeValue } from "../src/ui/SettingTab";

describe("setting resolver values", () => {
  it("scope: plugins & beta → community; sources → remotes; others pass through", () => {
    expect(settingScopeValue("plugins")).toBe("community");
    expect(settingScopeValue("beta")).toBe("community");
    expect(settingScopeValue("sources")).toBe("remotes");
    expect(settingScopeValue("general")).toBe("general");
    expect(settingScopeValue("obsidian")).toBe("obsidian");
    expect(settingScopeValue("core")).toBe("core");
    expect(settingScopeValue("advanced")).toBe("advanced");
  });
  it("type: only on item hits; dir → folder", () => {
    expect(settingTypeValue({ item: { type: "dir" } as never })).toBe("folder");
    expect(settingTypeValue({ item: { type: "file" } as never })).toBe("file");
    expect(settingTypeValue({ item: undefined })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run tests/qualifierSearch.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add exported helpers + specs** (in `src/ui/SettingTab.ts`, after the `SCOPE_LABEL` const around `:172`; add the qualifierSearch import)

```ts
import {
  QualifierAutocomplete,
  parseQuery,
  matchesQualifiers,
  type QualifierSpec,
  type QualifierResolver,
} from "./qualifierSearch";
```

```ts
// --- Qualifier search vocabulary (SettingTab) ---
export function settingScopeValue(scope: SearchHit["scope"]): string {
  if (scope === "plugins" || scope === "beta") return "community";
  if (scope === "sources") return "remotes";
  return scope; // general | obsidian | core | advanced
}
export function settingTypeValue(hit: Pick<SearchHit, "item">): "file" | "folder" | null {
  if (hit.item === undefined) return null;
  return hit.item.type === "dir" ? "folder" : "file";
}

const SETTING_QUALIFIER_SPECS: QualifierSpec[] = [
  { key: "scope", description: "settings area", values: [{ value: "general" }, { value: "obsidian" }, { value: "core" }, { value: "community" }, { value: "advanced" }, { value: "remotes" }] },
  { key: "type", description: "item kind", values: [{ value: "file", description: "single file" }, { value: "folder", description: "directory" }] },
];
const SETTING_QUALIFIER_KEYS = new Set(SETTING_QUALIFIER_SPECS.map((s) => s.key));
const SETTING_QUALIFIER_RESOLVERS: Record<string, QualifierResolver<SearchHit>> = {
  scope: (h) => settingScopeValue(h.scope),
  type: (h) => settingTypeValue(h),
};
```

- [ ] **Step 4: Use the parser in `renderSearchResults`**

Replace `:1186`–`:1189`:

```ts
// was: const q = this.search.trim().toLowerCase();
//      ...
//      const matches = index.filter((h) => `${h.name} ${h.desc}`.toLowerCase().includes(q));
const parsed = parseQuery(this.search, SETTING_QUALIFIER_KEYS);
const text = parsed.text.trim().toLowerCase();
const index = await this.buildSearchIndex(gen);
if (index === null) return;
const matches = index.filter(
  (h) => matchesQualifiers(h, parsed.qualifiers, SETTING_QUALIFIER_RESOLVERS) && `${h.name} ${h.desc}`.toLowerCase().includes(text),
);
```

The scope-pill code below (`:1191`+, using `this.searchScope` and `hit.scope`) is unchanged.

- [ ] **Step 5: Attach the widget in `renderSearchBox`**

Add a field to the class near `:194`:
```ts
private readonly qac = new QualifierAutocomplete(SETTING_QUALIFIER_SPECS);
```

In `renderSearchBox` (`:274`), the `wrap` div (`config-sync-search`) is the SearchComponent's parent. Ensure it is `position: relative` (add to styles if not already) and attach after `search.onChange(...)`:
```ts
this.qac.attach(search.inputEl);
```

Add to `styles.css` if `.config-sync-search` is not already positioned:
```css
.config-sync-search {
  position: relative;
}
```
(Check first — if the rule exists, just add `position: relative;` to it rather than duplicating the selector.)

- [ ] **Step 6: Run gates**

Run: `cd ~/local/coding/open/obsidian-config-sync && npx vitest run && npx tsc -noEmit -skipLibCheck && npx eslint . && ./scripts/check-no-hardcoded-color.sh && npm run build`
Expected: all green; eslint 0 errors / ≤67 warnings.

- [ ] **Step 7: Live-verify on dev vault**

`npm run smoke:install`, reload, open Settings → search box. Verify:
- Typing `sc` suggests `scope:`; selecting shows the six scope values.
- `scope:community` filters to community-plugin hits (and beta hits, if any); `scope:remotes` shows remote hits (desktop only).
- `type:folder` narrows to directory-type item hits; `type:file` to file items; non-item hits (settings/rules/remotes) drop out under a `type:` qualifier.
- Free text still matches name+desc; scope pills still work and AND with a typed `scope:` qualifier.
- Dropdown keyboard nav + close behavior as in Task 4. Dropdown persists while typing (search box is not recreated per keystroke here).

- [ ] **Step 8: Commit**

```bash
git add src/ui/SettingTab.ts tests/qualifierSearch.test.ts styles.css
git commit -m "feat(search): qualifier search in settings search"
```

---

## Self-Review

**Spec coverage:** parser (T1), matcher+suggest (T2), autocomplete widget (T3), Sync Center vocab/resolvers/integration (T4), SettingTab vocab/resolvers/integration (T5). Independent-AND (resolvers AND with existing free text + untouched pills), unknown-key→literal (T1), empty-value no-op (T1/T2), quoted values (T1), curated vocab incl. `action:` rename and `device:` (T4). All spec sections mapped.

**Placeholder scan:** none — every code step carries full code.

**Type consistency:** `Qualifier`/`ParsedQuery`/`QualifierResolver<T>`/`QualifierSpec`/`Suggestion` defined in T1–T2 and consumed unchanged in T3–T5. `syncActionValue` returns the `PanelFilter`-named union used by the pills. `settingTypeValue` takes `Pick<SearchHit,"item">` (matches the test's object literal). Resolver maps key names (`type`/`scope`/`action`/`mode`/`device`) exactly match each bar's spec keys and `validKeys` set.
