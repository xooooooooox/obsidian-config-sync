import { describe, expect, it } from "vitest";
import ConfigSyncPlugin from "../src/main";
import { SyncCenterView } from "../src/ui/SyncCenterView";
import { SyncGroup } from "../src/core/types";

// Task-3 review I4, and the reason this file exists: BOTH ref resolvers memoize, and a memo with no
// test is a memo the next reader deletes as "an unnecessary field".
//
// The cost they avoid is not theoretical. `lockRefFor(groups)` BUILDS a name→ref index over the whole
// compiled list, and both resolvers are asked per row per render — main.ts's by `displayName` and
// `isDeviceOptedOut`, the view's by half a dozen row-level derivations. Rebuilding that index per
// call is the same per-row, per-render rebuild this project has already paid for twice (C-#22, then
// C-#48's `familySearchText`/`rows()`), which is why the guards below assert the two things a
// deletion would break: the memo HOLDS while its source is unchanged, and it is REBUILT the moment
// the source list is replaced — the identity check both resolvers use as their invalidation point.

function fileGroup(name: string, ref?: string): SyncGroup {
  return { name, path: name, type: "file", devices: "all", ...(ref === undefined ? {} : { ref: ref as SyncGroup["ref"] }) };
}

// ── main.ts's groupRef ────────────────────────────────────────────────────────────────────────

interface ShellSurface {
  compiledGroups: SyncGroup[];
  groupRef: (group: string) => string;
  groupRefFor: (group: string) => string;
  groupRefSource: SyncGroup[] | null;
}

function shell(groups: SyncGroup[]): ShellSurface {
  // Same idiom as tests/lockLabelHeal.test.ts: a real plugin instance (Plugin is stubbed to an empty
  // class by tests/mock-obsidian.ts), reached through bracket access to bypass compile-time
  // `private`. groupRef needs nothing but the compiled list.
  const instance = new ConfigSyncPlugin({} as never, {} as never) as unknown as ShellSurface;
  instance.compiledGroups = groups;
  return instance;
}

describe("main.ts groupRef — memoized name→ref index (task-3 review I4)", () => {
  it("resolves through the compiled list, and through the legacy rules for a name it does not hold", () => {
    const s = shell([fileGroup("plugin-dataview", "community/dataview")]);
    expect(s.groupRef("plugin-dataview")).toBe("community/dataview");
    expect(s.groupRef("plugin-not-installed-here")).toBe("community/not-installed-here");
  });

  it("holds while the compiled list is unchanged — the index is built once, not per call", () => {
    const s = shell([fileGroup("plugin-dataview", "community/dataview")]);
    s.groupRef("plugin-dataview");
    const built = s.groupRefFor; // the resolver lockRefFor returned, i.e. the index it closed over
    expect(typeof built).toBe("function"); // a deleted memo must fail here, not pass on undefined === undefined
    s.groupRef("plugin-dataview");
    s.groupRef("plugin-something-else");
    expect(s.groupRefFor).toBe(built); // same closure — no rebuild for either call
    expect(s.groupRefSource).toBe(s.compiledGroups);
  });

  it("rebuilds when the compiled list is replaced — a stale index would answer for the old vault", () => {
    const s = shell([fileGroup("plugin-dataview", "community/dataview")]);
    expect(s.groupRef("my-rule")).toBe("legacy/my-rule"); // not compiled yet: the holding pen
    const built = s.groupRefFor;

    // What recompile() does: a new array lands in compiledGroups (identity change is the signal).
    s.compiledGroups = [fileGroup("plugin-dataview", "community/dataview"), fileGroup("my-rule", "custom/my-rule")];
    expect(s.groupRef("my-rule")).toBe("custom/my-rule");
    expect(s.groupRefFor).not.toBe(built);
  });
});

// ── SyncCenterView's rowRef ───────────────────────────────────────────────────────────────────

interface ViewSurface {
  groups: SyncGroup[];
  rowRef: (name: string) => string;
  rowRefMemo: Map<string, string>;
  rowRefSource: SyncGroup[] | null;
}

interface ViewHarness {
  view: ViewSurface;
  readonly hostCalls: number;
  setHostAnswer: (f: (name: string) => string | null) => void;
}

function viewHarness(groups: SyncGroup[], answer: (name: string) => string | null): ViewHarness {
  const state = { calls: 0, answer };
  const host = {
    itemRefForGroup: (name: string): string | null => {
      state.calls++;
      return state.answer(name);
    },
  };
  const instance = new SyncCenterView({} as never, host as never) as unknown as ViewSurface;
  instance.groups = groups;
  return {
    view: instance,
    get hostCalls() {
      return state.calls;
    },
    setHostAnswer: (f) => {
      state.answer = f;
    },
  };
}

describe("SyncCenterView rowRef — memoized per group list (task-3 review I4)", () => {
  it("asks the host once per name, then serves the memo", () => {
    const h = viewHarness([fileGroup("plugin-dataview")], (n) => (n === "plugin-dataview" ? "community/dataview" : null));
    expect(h.view.rowRef("plugin-dataview")).toBe("community/dataview");
    expect(h.hostCalls).toBe(1);
    expect(h.view.rowRef("plugin-dataview")).toBe("community/dataview");
    expect(h.hostCalls).toBe(1); // the second row-level derivation costs nothing
  });

  it("a store-only row (no registry answer) falls through to the legacy rules, and that answer is memoized too", () => {
    const h = viewHarness([fileGroup("plugin-dataview")], () => null);
    expect(h.view.rowRef("plugin-gone-from-here")).toBe("community/gone-from-here");
    const callsAfterFirst = h.hostCalls;
    expect(h.view.rowRef("plugin-gone-from-here")).toBe("community/gone-from-here");
    expect(h.hostCalls).toBe(callsAfterFirst); // the fallback index is not rebuilt per row either
  });

  it("replacing the group list invalidates it — a reload that renames an item must not serve the old ref", () => {
    const h = viewHarness([fileGroup("my-rule")], () => null);
    expect(h.view.rowRef("my-rule")).toBe("legacy/my-rule");

    // reload() replaces `this.groups` wholesale; the resolver's source-identity check is what turns
    // that into an invalidation. Nothing else clears this memo, so if the check goes, the panel
    // keeps resolving against a vault that no longer exists.
    h.setHostAnswer((n) => (n === "my-rule" ? "custom/my-rule" : null));
    h.view.groups = [fileGroup("my-rule", "custom/my-rule")];
    expect(h.view.rowRef("my-rule")).toBe("custom/my-rule");
    expect(h.view.rowRefSource).toBe(h.view.groups);
    expect(h.view.rowRefMemo.get("my-rule")).toBe("custom/my-rule");
  });
});
