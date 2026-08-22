import { describe, it, expect } from "vitest";
import { remoteRowStatuses, skipRefsForSelection } from "../src/core/remoteRows";
import { ItemRef } from "../src/core/types";
import { RemoteDiffEntry } from "../src/core/status";

const entry = (group: string, kinds: ("added" | "updated" | "deleted")[]): RemoteDiffEntry => ({
  group,
  files: kinds.map((kind, i) => ({ itemRel: `f${i}.json`, kind, local: null, remote: null })),
});

describe("remoteRowStatuses", () => {
  const local = ["appearance", "hotkeys", "dataview"];
  const refOf = (g: string): string | undefined =>
    g === "hotkeys" ? "obsidian/hotkeys" : g === "appearance" ? "obsidian/appearance" : g === "dataview" ? "community/dataview" : undefined;
  const companionRefsOf = (g: string): string[] => (g === "appearance" ? ["obsidian/appearance/themes", "obsidian/appearance/snippets"] : []);

  it("takes each row's direction from the verdict table, not from the file diff", () => {
    const rows = remoteRowStatuses({
      uncomparable: [],
      entries: [entry("hotkeys", ["updated"]), entry("dataview", ["updated"])],
      verdicts: { "obsidian/hotkeys": "pull", "community/dataview": "push" },
      refOf,
      companionRefsOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "hotkeys")?.state).toBe("store-newer");
    expect(rows.find((r) => r.group === "dataview")?.state).toBe("local-changed");
  });

  it("raises the parent row when only a companion's verdict is waiting", () => {
    // The family's one row must speak for the themes/ files the pull would write.
    const rows = remoteRowStatuses({
      uncomparable: [],
      entries: [],
      verdicts: { "obsidian/appearance/themes": "pull" },
      refOf,
      companionRefsOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "appearance")?.state).toBe("store-newer");
  });

  it("shows the pull when family members disagree — an incoming write outranks an outgoing one", () => {
    const rows = remoteRowStatuses({
      uncomparable: [],
      entries: [],
      verdicts: { "obsidian/appearance": "push", "obsidian/appearance/snippets": "pull" },
      refOf,
      companionRefsOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "appearance")?.state).toBe("store-newer");
  });

  it("calls an item in sync when its bytes differ but nothing flows in an allowed direction", () => {
    // spec 3.3: the remote edited a Push only item. Different bytes, no pending work.
    const rows = remoteRowStatuses({ uncomparable: [], entries: [entry("dataview", ["updated"])], verdicts: {}, refOf, companionRefsOf, localGroupNames: local });
    expect(rows.find((r) => r.group === "dataview")?.state).toBe("in-sync");
  });

  it("still carries the changed files, so the card can show what the row stays quiet about", () => {
    const rows = remoteRowStatuses({ uncomparable: [], entries: [entry("dataview", ["updated", "added"])], verdicts: {}, refOf, companionRefsOf, localGroupNames: local });
    expect(rows.find((r) => r.group === "dataview")?.changes).toEqual({ added: ["f1.json"], updated: ["f0.json"], deleted: [] });
  });

  it("gives a row to an item the verdict table names but the file diff never mentioned", () => {
    // Version info moved on the remote and nothing else — a real pull, with no file-level delta.
    const rows = remoteRowStatuses({ uncomparable: [], entries: [], verdicts: { "obsidian/hotkeys": "pull" }, refOf, companionRefsOf, localGroupNames: local });
    expect(rows.find((r) => r.group === "hotkeys")?.state).toBe("store-newer");
  });

  it("keeps an entry with no local counterpart — the remote has items this device does not", () => {
    const rows = remoteRowStatuses({
      uncomparable: [],
      entries: [entry("themes", ["added"])],
      verdicts: {},
      refOf: (g) => (g === "themes" ? undefined : refOf(g)),
      companionRefsOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "themes")?.state).toBe("store-newer");
    expect(rows).toHaveLength(4);
  });

  it("folds the file kinds into the same FileChanges shape the device relation uses", () => {
    const rows = remoteRowStatuses({
      uncomparable: [],
      entries: [entry("hotkeys", ["added", "updated", "updated", "deleted"])],
      verdicts: { "obsidian/hotkeys": "pull" },
      refOf,
      companionRefsOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "hotkeys")?.changes).toEqual({ added: ["f0.json"], updated: ["f1.json", "f2.json"], deleted: ["f3.json"] });
  });

  it("drops the store-metadata pseudo-entry, which is bookkeeping and never an item", () => {
    const rows = remoteRowStatuses({ uncomparable: [], entries: [entry("", ["updated"])], verdicts: {}, refOf, companionRefsOf, localGroupNames: local });
    expect(rows.every((r) => r.group !== "")).toBe(true);
  });

  it("says nothing is waiting when the table is empty and the diff found nothing", () => {
    const rows = remoteRowStatuses({ uncomparable: [], entries: [], verdicts: {}, refOf, companionRefsOf, localGroupNames: local });
    expect(rows.every((r) => r.state === "in-sync")).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("says it cannot compare an item whose copies could not be opened here", () => {
    const rows = remoteRowStatuses({
      uncomparable: ["community/dataview"],
      entries: [entry("dataview", ["updated"])],
      verdicts: { "community/dataview": "pull" },
      refOf,
      companionRefsOf,
      localGroupNames: local,
    });
    // Outranks both the verdict and the file diff: neither is a claim anybody verified.
    expect(rows.find((r) => r.group === "dataview")?.state).toBe("locked");
  });
});

describe("skipRefsForSelection", () => {
  const all = ["obsidian/appearance", "core/backlink", "community/dataview"] as ItemRef[];

  it("skips exactly what the user left unchecked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: ["core/backlink"] as ItemRef[] }).sort()).toEqual([
      "community/dataview",
      "obsidian/appearance",
    ]);
  });

  it("skips nothing when every row is checked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: all })).toEqual([]);
  });

  it("skips everything when nothing is checked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: [] }).sort()).toEqual([...all].sort());
  });

  it("ignores a selected ref that is not on the list at all", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: ["community/ghost"] as ItemRef[] }).sort()).toEqual([...all].sort());
  });

  it("carries a family-expanded list through untouched — an unstaged parent's companions skip with it", () => {
    // The view hands in refs already expanded (familyRefs): parent + companions on both lists.
    const expanded = ["obsidian/appearance", "obsidian/appearance/themes", "obsidian/appearance/snippets", "community/dataview"] as ItemRef[];
    expect(skipRefsForSelection({ allRefs: expanded, selectedRefs: ["community/dataview"] as ItemRef[] }).sort()).toEqual([
      "obsidian/appearance",
      "obsidian/appearance/snippets",
      "obsidian/appearance/themes",
    ]);
  });
});
