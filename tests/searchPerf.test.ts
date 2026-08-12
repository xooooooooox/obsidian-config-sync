import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { SyncGroup } from "../src/core/types";
import { GroupStatus } from "../src/core/status";

// C-#48 (docs/superpowers/specs/2026-08-10-c-livetest-batch23-search-perf.md): live-measured on a
// 100+ row vault, a single search keystroke cost 400-500ms end to end. Real instrumentation (a
// live Sync Center, temporary performance.now() wrappers around the real methods — see the task
// report, not shipped here) attributed the overwhelming majority of that to `familySearchText`
// re-deriving every row's searchable text from scratch on every one of a keystroke's several
// full-row-list passes (sidebar per-section badges, filter pills, each type section): each call
// rescans `familyCompanions`, which itself walks the WHOLE group list through
// `host.companionParentOf` — on a 100+ row vault, tens of thousands of redundant calls per
// keystroke. `rows()` (the sorted row list) showed the same pattern at smaller scale — rebuilt and
// re-sorted from scratch on every sidebar section entry.
//
// These tests drive the REAL private familySearchText/rows/debounceSearchRender via the same
// harness idiom as tests/emptyVerbDegradation.test.ts (a minimal fake host, bracket access to
// bypass TypeScript's compile-time-only `private`) — no DOM is exercised (this repo's UI code has
// no DOM test harness; SyncCenterView's real rendering is verified live, per CLAUDE.md).

interface Harness {
  groups: SyncGroup[];
  statuses: Map<string, GroupStatus>;
  familySearchText(r: { group: SyncGroup; status: GroupStatus }): string;
  rows(): { group: SyncGroup; status: GroupStatus }[];
  debounceSearchRender(run: () => void): void;
  renderMainRegion(): void;
  searchTextCache: Map<string, string>;
  rowsCache: unknown[] | null;
  searchDebounceTimer: number | null;
}

function fileGroup(name: string, label?: string): SyncGroup {
  return { name, path: name, type: "file", devices: "all", label };
}

interface HarnessResult {
  view: Harness;
  companionParentOfCalls: number;
  displayPartsCalls: number;
}

function harness(opts: { groups: SyncGroup[]; statuses: Record<string, GroupStatus>; companionParentOf?: (group: string) => string | null }): HarnessResult {
  const calls = { companionParentOf: 0, displayParts: 0 };
  const host = {
    companionParentOf: (g: string): string | null => {
      calls.companionParentOf++;
      return opts.companionParentOf?.(g) ?? null;
    },
    displayParts: (group: string, storedLabel?: string): { parent: string | null; label: string } => {
      calls.displayParts++;
      return { parent: null, label: storedLabel ?? group };
    },
    deviceOptedOut: () => false,
    // No registry behind these harnesses: the view falls back to the same legacy rules a v1/v2
    // lock read uses, which is exactly what a store-only row gets in production.
    itemRefForGroup: () => null,
  };
  const view = new SyncCenterView({} as never, host as never);
  const instance = view as unknown as Harness;
  instance.groups = opts.groups;
  instance.statuses = new Map(Object.entries(opts.statuses));
  return {
    view: instance,
    get companionParentOfCalls() {
      return calls.companionParentOf;
    },
    get displayPartsCalls() {
      return calls.displayParts;
    },
  };
}

describe("familySearchText — per-row memoization (C-#48)", () => {
  it("first call derives the family text (own name + label + every companion's)", () => {
    const parent = fileGroup("custom-notes", "My Notes");
    const companion = fileGroup("notes-attachments", "Attachments");
    const h = harness({
      groups: [parent, companion],
      statuses: { "custom-notes": { group: "custom-notes", state: "no-settings" }, "notes-attachments": { group: "notes-attachments", state: "no-settings" } },
      companionParentOf: (g) => (g === "notes-attachments" ? "custom-notes" : null),
    });
    const row = { group: parent, status: h.view.statuses.get("custom-notes")! };
    const text = h.view.familySearchText(row);
    expect(text).toContain("My Notes");
    expect(text).toContain("custom-notes");
    expect(text).toContain("Attachments");
    expect(text).toContain("notes-attachments");
  });

  it("repeat calls for the same row return the identical text without re-walking companions (memo hit)", () => {
    const parent = fileGroup("custom-notes", "My Notes");
    const companion = fileGroup("notes-attachments", "Attachments");
    const h = harness({
      groups: [parent, companion],
      statuses: { "custom-notes": { group: "custom-notes", state: "no-settings" }, "notes-attachments": { group: "notes-attachments", state: "no-settings" } },
      companionParentOf: (g) => (g === "notes-attachments" ? "custom-notes" : null),
    });
    const row = { group: parent, status: h.view.statuses.get("custom-notes")! };
    const first = h.view.familySearchText(row);
    const callsAfterFirst = h.companionParentOfCalls;
    expect(callsAfterFirst).toBeGreaterThan(0); // the first call really did walk companionParentOf
    const second = h.view.familySearchText(row);
    expect(second).toBe(first);
    expect(h.companionParentOfCalls).toBe(callsAfterFirst); // no more companion-resolution work on the memo hit
  });

  it("a different row's own memo entry is independent (no cross-row bleed)", () => {
    const a = fileGroup("group-a", "Alpha");
    const b = fileGroup("group-b", "Beta");
    const h = harness({
      groups: [a, b],
      statuses: { "group-a": { group: "group-a", state: "no-settings" }, "group-b": { group: "group-b", state: "no-settings" } },
    });
    const textA = h.view.familySearchText({ group: a, status: h.view.statuses.get("group-a")! });
    const textB = h.view.familySearchText({ group: b, status: h.view.statuses.get("group-b")! });
    expect(textA).toContain("Alpha");
    expect(textA).not.toContain("Beta");
    expect(textB).toContain("Beta");
    expect(textB).not.toContain("Alpha");
  });

  // Review fix-round-1 (adjudicated gap): the memo-hit tests above prove the FAST path; they don't
  // prove the cache can't go stale. This is the actual risk surface — a memo that never clears
  // would "work" (fast, wrong) forever. Applies the EXACT clear the source performs at the top of
  // render()/reload() (`searchTextCache.clear()`), never a different one, so this stays true to
  // what production code actually does at its documented invalidation points.
  it("clearing searchTextCache (the render()/reload() invalidation point) drops stale text after the row's label changes", () => {
    const parent = fileGroup("custom-notes", "My Notes");
    const h = harness({ groups: [parent], statuses: { "custom-notes": { group: "custom-notes", state: "no-settings" } } });
    const row = { group: parent, status: h.view.statuses.get("custom-notes")! };
    const before = h.view.familySearchText(row);
    expect(before).toContain("My Notes");
    // Simulate what a reload() actually does: the group list is replaced (a relabel arrives from
    // the store) and the memo is cleared at the same point production code clears it.
    const relabeled = fileGroup("custom-notes", "Renamed Notes");
    h.view.groups = [relabeled];
    h.view.searchTextCache.clear();
    const after = h.view.familySearchText({ group: relabeled, status: h.view.statuses.get("custom-notes")! });
    expect(after).toContain("Renamed Notes");
    expect(after).not.toContain("My Notes"); // the stale label must not survive the clear
  });

  it("clearing searchTextCache picks up a newly-added companion (a stale text without it would hide the companion from search)", () => {
    const parent = fileGroup("custom-notes", "My Notes");
    const h = harness({
      groups: [parent],
      statuses: { "custom-notes": { group: "custom-notes", state: "no-settings" } },
      companionParentOf: (g) => (g === "notes-attachments" ? "custom-notes" : null),
    });
    const row = { group: parent, status: h.view.statuses.get("custom-notes")! };
    const before = h.view.familySearchText(row);
    expect(before).not.toContain("Attachments"); // no companion yet
    // A companion is added (e.g. the user ticks "+ Add folder") — this reaches `this.groups`/
    // `this.statuses` exactly the way reload() replaces them, then the same clear reload() performs.
    const companion = fileGroup("notes-attachments", "Attachments");
    h.view.groups = [parent, companion];
    h.view.statuses.set("notes-attachments", { group: "notes-attachments", state: "no-settings" });
    h.view.searchTextCache.clear();
    const after = h.view.familySearchText(row);
    expect(after).toContain("Attachments");
  });
});

describe("rows() — per-render-cycle memoization (C-#48)", () => {
  it("repeat calls return the same sorted content without re-deriving family groups", () => {
    const groups = [fileGroup("zeta", "Zeta"), fileGroup("alpha", "Alpha"), fileGroup("mid", "Mid")];
    const statuses: Record<string, GroupStatus> = Object.fromEntries(groups.map((g) => [g.name, { group: g.name, state: "no-settings" as const }]));
    const h = harness({ groups, statuses });
    const first = h.view.rows();
    const callsAfterFirst = h.companionParentOfCalls;
    expect(callsAfterFirst).toBeGreaterThan(0); // familyGroups() really did walk companionParentOf once
    const second = h.view.rows();
    expect(second).toBe(first); // same cached array reference — no rebuild
    expect(h.companionParentOfCalls).toBe(callsAfterFirst); // no repeat scan on the memo hit
    expect(second.map((r) => r.group.name)).toEqual(["alpha", "mid", "zeta"]); // sort order preserved
  });

  // Review fix-round-1 (adjudicated gap): rows() depends on BOTH this.groups AND this.statuses
  // (a group with no matching status entry is filtered out) — invalidation must hold for either
  // mutation, using the exact clear the source performs (`rowsCache = null`).
  it("clearing rowsCache (the render()/reload() invalidation point) picks up a newly-added group", () => {
    const groups = [fileGroup("alpha", "Alpha")];
    const statuses: Record<string, GroupStatus> = { alpha: { group: "alpha", state: "no-settings" } };
    const h = harness({ groups, statuses });
    const before = h.view.rows();
    expect(before.map((r) => r.group.name)).toEqual(["alpha"]);
    const beta = fileGroup("beta", "Beta");
    h.view.groups = [...groups, beta];
    h.view.statuses.set("beta", { group: "beta", state: "no-settings" });
    h.view.rowsCache = null;
    const after = h.view.rows();
    expect(after.map((r) => r.group.name)).toEqual(["alpha", "beta"]); // the new group must appear, sorted in
  });

  it("clearing rowsCache picks up a group whose status just arrived (rows() requires a matched status entry)", () => {
    const groups = [fileGroup("alpha", "Alpha"), fileGroup("beta", "Beta")];
    // "beta" has no status yet — rows() skips any group without a matching statuses entry.
    const h = harness({ groups, statuses: { alpha: { group: "alpha", state: "no-settings" } } });
    const before = h.view.rows();
    expect(before.map((r) => r.group.name)).toEqual(["alpha"]);
    h.view.statuses.set("beta", { group: "beta", state: "no-settings" }); // status just landed
    h.view.rowsCache = null;
    const after = h.view.rows();
    expect(after.map((r) => r.group.name)).toEqual(["alpha", "beta"]); // stale cache must not still omit it
  });
});

describe("debounceSearchRender — single trailing timer, settles on the final call (C-#48 spec §3)", () => {
  // debounceSearchRender uses window.setTimeout/clearTimeout (the repo's own idiom — see the
  // pre-existing slowTimer/ticker fields in SyncCenterView.ts) — this test env has no DOM/window
  // (this repo's UI code has no DOM test harness), so `window` is stubbed via vitest's own
  // `vi.stubGlobal` (not a raw `globalThis`/`global` assignment — obsidianmd/no-global-this) onto
  // the same fake setTimeout/clearTimeout vi.useFakeTimers() installs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a burst of rapid calls (simulating fast typing) fires the callback exactly once, for the LAST call", () => {
    const h = harness({ groups: [], statuses: {} });
    const seen: string[] = [];
    // Simulate three keystrokes 20ms apart — well inside the debounce window — each rescheduling
    // the same single timer; only the final one should ever run.
    h.view.debounceSearchRender(() => seen.push("q1"));
    vi.advanceTimersByTime(20);
    h.view.debounceSearchRender(() => seen.push("q12"));
    vi.advanceTimersByTime(20);
    h.view.debounceSearchRender(() => seen.push("q123"));
    // Not enough time has passed yet for even the last timer to fire.
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(200); // well past the debounce window
    expect(seen).toEqual(["q123"]); // exactly once, and it's the FINAL query's callback — none lost, none stale
  });

  it("a single call still settles after the debounce window (no keystroke is ever dropped when typing pauses)", () => {
    const h = harness({ groups: [], statuses: {} });
    let ran = false;
    h.view.debounceSearchRender(() => {
      ran = true;
    });
    vi.advanceTimersByTime(200);
    expect(ran).toBe(true);
  });

  it("well-spaced calls (slower than the debounce window) each settle independently", () => {
    const h = harness({ groups: [], statuses: {} });
    const seen: string[] = [];
    h.view.debounceSearchRender(() => seen.push("a"));
    vi.advanceTimersByTime(200); // settles before the next call
    h.view.debounceSearchRender(() => seen.push("b"));
    vi.advanceTimersByTime(200);
    expect(seen).toEqual(["a", "b"]);
  });

  // Review fix-round-2 (Important gap, round-1 was incomplete): the cold-start banner's
  // "Review settings →"/dismiss handlers call `renderMainRegion()` DIRECTLY, bypassing the
  // render()/reload()-only cancel round-1 added — a realistic sequence (type in the compact search
  // box, then tap the banner within the debounce window — both visible together on a first-run
  // phone) left the OLD timer to fire later into DOM `renderMainRegion()` had already replaced,
  // running the compact path's stale `renderPills`/`renderSectionsBody`/`refreshGlobalSelectAll`
  // closure against detached elements. Round-2 moved the cancel to the TOP of `renderMainRegion()`
  // itself instead — the single method every caller (render(), reload() via render(), the
  // debounce's own trailing call, AND both banner handlers) funnels through — and removed the
  // round-1 render()/reload() copies (single source of truth). This drives the REAL
  // `renderMainRegion()`, not a simulated proxy: `mainEl` stays null in this harness (no DOM), so
  // the call exercises exactly the cancel block and then returns — the same short-circuit
  // production hits whenever `renderMainRegion()` runs before the view's first full render.
  it("renderMainRegion() itself cancels a pending timer — covers every caller, including the banner handlers that bypassed render()/reload()", () => {
    const h = harness({ groups: [], statuses: {} });
    let ran = false;
    h.view.debounceSearchRender(() => {
      ran = true;
    });
    expect(h.view.searchDebounceTimer).not.toBeNull();
    h.view.renderMainRegion(); // exactly what the banner's click handlers call directly
    expect(h.view.searchDebounceTimer).toBeNull(); // cancelled, not just "will be overwritten later"
    vi.advanceTimersByTime(500); // well past the debounce window — nothing pending should fire
    expect(ran).toBe(false);
  });

  it("renderMainRegion() with no pending timer is a harmless no-op (idempotent — the debounce's own trailing call reaches here too)", () => {
    const h = harness({ groups: [], statuses: {} });
    expect(h.view.searchDebounceTimer).toBeNull();
    expect(() => h.view.renderMainRegion()).not.toThrow();
    expect(h.view.searchDebounceTimer).toBeNull();
  });
});
