import { setIcon } from "obsidian";

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
    if (m !== null && validKeys.has(m[1]!.toLowerCase())) {
      qualifiers.push({ key: m[1]!.toLowerCase(), value: stripQuotes(m[2]!).toLowerCase() });
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
  private readonly onBlur = (): void => {
    window.setTimeout(() => this.close(), 120);
  };
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
    this.input.value = applySuggestion(this.input.value, this.items[i]!.insert);
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
