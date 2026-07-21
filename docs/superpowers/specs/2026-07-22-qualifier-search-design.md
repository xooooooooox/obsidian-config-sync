# Qualifier Search — Design

**Date:** 2026-07-22
**Status:** Approved (pending spec review)

## Goal

Enhance both existing searchbars — SettingTab "Search all settings…" and Sync
Center "Filter by name…" — to support Google/git-style `key:value` qualifiers
(e.g. `type:folder`, `scope:community`, `action:capture`), with an
autocomplete dropdown that suggests keys and values as the user types.

## Non-goals

- No change to the existing filter/scope pills or their behavior (including
  Sync Center's "reset state pills to All on search" behavior — left as-is).
- No negation (`-type:file`) or OR (repeated key) syntax — YAGNI.
- No `device:` qualifier in SettingTab (its search index does not carry a
  group's device class; threading it in is out of scope).

## Decisions (locked)

- **Vocabulary:** curated (see tables below).
- **Pill interaction:** independent. Qualifiers AND with free text and with
  whatever pill/category state is currently active; typing never mutates a
  pill and a pill never mutates the text box.
- **Syntax:** multiple `key:value` tokens AND together, ANDed with free text.
  Values are case-insensitive. Unknown keys fall back to literal free text.
  Quoted values (`key:"a b"`) supported for spaces. An empty value
  (`type:`, mid-typing) is a no-op (matches everything).
- **Affordance:** autocomplete dropdown ("方案 2"). Empty/partial key → suggest
  keys; after `key:` → suggest that key's values.

## Curated vocabulary

### Sync Center (`src/ui/SyncCenterView.ts`) — filters `StatusRow` (`group`, `status`)

| key | values | resolves to (stored → vocabulary) |
|---|---|---|
| `type:` | `file` · `folder` | `group.type` (`dir` → `folder`) |
| `scope:` | `obsidian` · `core` · `community` · `beta` · `custom` | `scopeOf(name)` |
| `action:` | `capture` · `apply` · `ok` · `none` | `PanelFilter` bucket of the row's presented state, via `visibleUnderFilter` |
| `mode:` | `plain` · `fields` · `encrypted` | `group.mode ?? "plain"` (`SyncMode`) |
| `device:` | `all` · `desktop` · `mobile` | `group.devices` (exact) |

`action:` is named to match the history view's "Action" column and the
`SyncAction`/`Direction` vocabulary (`capture`/`apply`); it mirrors the
existing state-filter pills 1:1 (`visibleUnderFilter`). The `GroupState`
condition vocabulary (`in-sync`, `store-newer`…) is internal and is NOT
exposed.

### SettingTab (`src/ui/SettingTab.ts`) — filters `SearchHit`

| key | values | resolves to |
|---|---|---|
| `scope:` | `general` · `obsidian` · `core` · `community` · `advanced` · `remotes` | `hit.scope`, with `community` → {`plugins`, `beta`}, `remotes` → `sources` |
| `type:` | `file` · `folder` | `hit.item?.type` (`dir` → `folder`); only bites on `kind === "item"` hits, else no match |

Free text keeps its existing reach: Sync Center matches
`${displayName} ${group.name}`; SettingTab matches `${hit.name} ${hit.desc}`.

## Architecture

New module **`src/ui/qualifierSearch.ts`** holds all pure logic + the thin DOM
helper. Each searchbar supplies a small config; all matching/parsing/suggesting
logic is shared.

### Pure core (unit-tested, TDD)

```ts
export interface Qualifier { key: string; value: string }        // value lowercased
export interface ParsedQuery { text: string; qualifiers: Qualifier[] }

// Tokenize honoring quotes. A token `key:...` whose key (lowercased) is in
// validKeys becomes a Qualifier (surrounding quotes stripped, value lowercased);
// every other token is joined into `text`. Empty value is kept as a Qualifier
// with value "".
export function parseQuery(raw: string, validKeys: ReadonlySet<string>): ParsedQuery;

// A resolver returns the item's value(s) IN THE QUALIFIER VOCABULARY
// (i.e. already translated: dir→"folder", plugins/beta→"community"), or null.
export type QualifierResolver<T> = (item: T) => string | string[] | null;

// AND across qualifiers. Empty-value qualifiers and unknown keys are skipped.
// A qualifier matches when any resolved value equals it (case-insensitive).
export function matchesQualifiers<T>(
  item: T,
  qualifiers: readonly Qualifier[],
  resolvers: Record<string, QualifierResolver<T>>,
): boolean;
```

```ts
export interface QualifierValue { value: string; description?: string }
export interface QualifierSpec { key: string; description?: string; values: QualifierValue[] }

export interface Suggestion { display: string; insert: string; description?: string; kind: "key" | "value" }

// currentToken = the last whitespace-delimited fragment of the raw input
// (caret assumed at end — the common case for incremental filtering).
//  - no ":" → suggest specs whose key startsWith the fragment; insert = "key:"
//  - "key:val" → suggest that spec's values startsWith val; insert = "key:value "
//  - unknown key before ":" → no suggestions
export function suggest(currentToken: string, specs: readonly QualifierSpec[]): Suggestion[];

// Replace the last whitespace-delimited token of `raw` with `insert`.
export function applySuggestion(raw: string, insert: string): string;
```

### DOM helper (thin, live-verified)

```ts
export interface AutocompleteController { destroy(): void }

// Wraps an existing <input>. On input, computes suggest(lastToken, specs) and
// renders a dropdown. ArrowUp/Down move selection; Enter/Tab apply the selected
// suggestion (mutate input.value via applySuggestion, keep focus) then dispatch
// a native "input" event so the view's existing oninput re-runs the filter;
// Escape / outside-click / blur close the dropdown.
export function attachQualifierAutocomplete(
  input: HTMLInputElement,
  specs: readonly QualifierSpec[],
): AutocompleteController;
```

The helper dispatches a synthetic `input` event after applying a suggestion, so
each view's *existing* `oninput` handler remains the single source of filter
truth — the autocomplete never re-implements filtering.

### Integration per bar

Each bar:
1. Builds its `QualifierSpec[]` (keys + values + short descriptions) and a
   `validKeys` set + a `resolvers` map.
2. In its filter path, replaces the bare `matchesSearch`/substring call with:
   `const q = parseQuery(this.search, validKeys);` then keeps a row/hit when
   `matchesQualifiers(item, q.qualifiers, resolvers)` AND the existing free-text
   match run against `q.text` (instead of the whole raw string).
3. Calls `attachQualifierAutocomplete(inputEl, specs)` once, when the input is
   created. Input is wrapped in a `position: relative` container so the dropdown
   positions under it.

**SettingTab note:** its `renderSearchResults` (`:1189`) currently matches the
raw query; it must switch to `q.text` for the substring and add the qualifier
gate. The scope pills (`:1217`) continue to filter on `hit.scope` independently.

**Sync Center note:** `matchesSearch` is called at several sites (`:692`,
`:1092`, `:1162`, `:1272`, `:1298`). Introduce one helper on the view,
`rowMatchesSearch(row)`, that runs parse + qualifier gate + free-text match, and
route every existing call site through it so counts and filtered rows agree.

## Data flow

```
input text ──▶ parseQuery(raw, validKeys) ──▶ { text, qualifiers }
                                                 │        │
                          free-text substring ◀──┘        └──▶ matchesQualifiers(item, qualifiers, resolvers)
                                     │                                     │
                                     └──────────── AND ────────────────────┘ ──▶ visible?

input keystroke ──▶ suggest(lastToken, specs) ──▶ dropdown ──▶ (Enter/Tab/click)
                     applySuggestion ──▶ input.value ──▶ dispatch "input" ──▶ view oninput ──▶ re-filter
```

## Error / edge handling

- Empty query → `{ text: "", qualifiers: [] }` → everything visible (unchanged).
- `key:` with no value → no-op qualifier (matches all); dropdown shows values.
- Valid key, invalid value (`type:xyz`) → 0 matches (dropdown prevents this in
  practice).
- Unknown key (`foo:bar`) → folded into free text; matched as literal substring.
- Quoted value with spaces (`scope:"community"`, `type:"folder"`) → quotes
  stripped; primarily to allow future multi-word values, harmless now.
- Resolver returning `null` (e.g. `type:` on a non-item SettingTab hit) →
  qualifier fails → hit excluded.

## Testing

- **`tests/qualifierSearch.test.ts`** (new): `parseQuery` (plain, single/multi
  qualifier, unknown key → text, quoted value, empty value, mixed order,
  case-insensitivity), `matchesQualifiers` (AND, empty-value skip, alias via
  resolver, array resolver, null resolver), `suggest` (empty → all keys, key
  prefix, `key:` → values, value prefix, unknown key → none), `applySuggestion`
  (replace last token only, preserve earlier tokens).
- **Sync Center resolvers** and **SettingTab resolvers** are exported pure
  functions with their own focused tests (each key: correct value, alias, miss).
- The DOM helper (`attachQualifierAutocomplete`) is a thin imperative shell —
  verified live on the dev vault (dropdown appears, key→value suggestion flow,
  ↑/↓/Enter/Tab/Esc, outside-click close, filter updates), not unit-tested.

## Files

- **Create:** `src/ui/qualifierSearch.ts`, `tests/qualifierSearch.test.ts`
- **Modify:** `src/ui/SyncCenterView.ts` (specs/resolvers, `rowMatchesSearch`,
  attach autocomplete), `src/ui/SettingTab.ts` (specs/resolvers, parse in
  `renderSearchResults`, attach autocomplete), `styles.css` (dropdown styles).

## Global constraints

- No hardcoded colors — theme vars only (`rgba(var(--*-rgb), α)` for alpha);
  `./scripts/check-no-hardcoded-color.sh` must pass.
- No new eslint errors; hold the warning baseline (67). Any unavoidable new
  warning must be disclosed and justified.
- `npx tsc -noEmit -skipLibCheck` clean · `npm test` green · `npm run build`
  clean.
- No emoji in UI copy — use Lucide icons via `setIcon` where an icon is needed.
- UI copy in sentence case (obsidianmd/ui/sentence-case).
