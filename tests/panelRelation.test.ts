import { describe, it, expect } from "vitest";
import { destinationKey, pickerBadgeDigits, excludedLineText, foldStateKey, RECORD_ONLY_PULL_CLAUSE, recordOnlyPushClause, withheldChangeClause, insyncLineText, PanelDestination, PanelRelation, relationCopy, relationHint, relationKey, relationLabel, relationShortLabel, viewOptions } from "../src/ui/panelModel";

describe("relationLabel", () => {
  it("names the two relations exactly as the design says", () => {
    expect(relationLabel({ kind: "device" })).toBe("This device ↔ store");
    expect(relationLabel({ kind: "remote", name: "main" })).toBe("store ↔ main");
  });
});

describe("relationKey / destinationKey", () => {
  it("keeps a remote's key apart from an item category that happens to share its name", () => {
    // "beta" is a real item category AND a plausible remote name — the two must never collide
    expect(relationKey({ kind: "remote", name: "beta" })).not.toBe(destinationKey({ kind: "items", cat: "beta" }));
  });

  it("is stable per value", () => {
    expect(relationKey({ kind: "device" })).toBe(relationKey({ kind: "device" }));
    expect(relationKey({ kind: "remote", name: "a" })).toBe(relationKey({ kind: "remote", name: "a" }));
    expect(relationKey({ kind: "remote", name: "a" })).not.toBe(relationKey({ kind: "remote", name: "b" }));
    expect(destinationKey({ kind: "history" })).not.toBe(destinationKey({ kind: "self" }));
  });
});

describe("foldStateKey", () => {
  it("separates the same fold under two different relations", () => {
    const d: PanelDestination = { kind: "items", cat: "all" };
    const device: PanelRelation = { kind: "device" };
    const remote: PanelRelation = { kind: "remote", name: "main" };
    expect(foldStateKey(device, d, "plugins", "outdated")).not.toBe(foldStateKey(remote, d, "plugins", "outdated"));
  });

  it("separates two folds under the same relation and destination", () => {
    const r: PanelRelation = { kind: "device" };
    const d: PanelDestination = { kind: "items", cat: "all" };
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "plugins", "disabled"));
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "obsidian", "outdated"));
  });
});

describe("viewOptions", () => {
  const remotes = [
    { name: "main", state: "remote-newer" as const, counts: null },
    { name: "work", state: "same" as const, counts: null },
  ];

  it("puts this device first, then the remotes in the order settings gave them", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.label)).toEqual(["This device ↔ store", "store ↔ main", "store ↔ work"]);
  });

  it("marks exactly one option active, by value not by identity", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "work" }, deviceCounts: { up: 3, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([false, false, true]);
  });

  it("falls back to this device when the current remote is gone", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "deleted" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([true, false, false]);
  });

  it("gives this device its capture/apply counts and drops the zeroes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 11, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([{ kind: "capture", count: 11 }]);
  });

  it("gives this device no badges at all when nothing is waiting", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([]);
  });

  it("gives a remote no comparison has run against its whole-store state", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts[1]?.badges).toEqual([{ kind: "remote-state", state: "remote-newer" }]);
    expect(opts[2]?.badges).toEqual([{ kind: "remote-state", state: "same" }]);
  });

  it("counts items for a remote a comparison HAS run against, and drops the zeroes", () => {
    const compared = [{ name: "main", state: "remote-newer" as const, counts: { push: 0, pull: 4 } }];
    const opts = viewOptions({ current: { kind: "remote", name: "main" }, deviceCounts: { up: 0, down: 0 }, remotes: compared });
    expect(opts[1]?.badges).toEqual([{ kind: "pull", count: 4 }]);
  });

  it("counts a remote that is NOT the current view when its tally is in hand", () => {
    const counted = [{ name: "main", state: "remote-newer" as const, counts: { push: 2, pull: 1 } }];
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes: counted });
    expect(opts[1]?.badges).toEqual([
      { kind: "push", count: 2 },
      { kind: "pull", count: 1 },
    ]);
  });

  it("gives a compared remote with nothing waiting no badges at all — not a state icon", () => {
    const compared = [{ name: "main", state: "same" as const, counts: { push: 0, pull: 0 } }];
    const opts = viewOptions({ current: { kind: "remote", name: "main" }, deviceCounts: { up: 0, down: 0 }, remotes: compared });
    expect(opts[1]?.badges).toEqual([]);
  });

  it("offers this device alone when there are no remotes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 1, down: 2 }, remotes: [] });
    expect(opts).toHaveLength(1);
    expect(opts[0]?.badges).toEqual([
      { kind: "capture", count: 1 },
      { kind: "apply", count: 2 },
    ]);
  });
});

describe("relationCopy", () => {
  it("keeps every word the device relation shows today", () => {
    const c = relationCopy({ kind: "device" });
    expect(c.bucket.capture).toBe("To capture");
    expect(c.bucket.apply).toBe("To apply");
    expect(c.bucket.ok).toBe("In sync");
    expect(c.bucket.excluded).toBe("Not synced here");
    expect(c.bucket.none).toBe("No settings yet");
  });

  it("keeps the device relation's fold lines byte-identical to the ones the list already draws", () => {
    const c = relationCopy({ kind: "device" });
    expect(c.matchFold(1)).toBe(insyncLineText(1));
    expect(c.matchFold(4)).toBe(insyncLineText(4));
    expect(c.excludedFold(2)).toBe(excludedLineText(2));
  });

  it("swaps in the remote relation's words, one for one", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.bucket.capture).toBe("To push");
    expect(c.bucket.apply).toBe("To pull");
    expect(c.bucket.ok).toBe("In sync");
    expect(c.bucket.excluded).toBe("Doesn't sync with this remote");
    expect(c.bucket.none).toBe("Nothing captured yet");
  });

  it("gives both relations the same five buckets and no more", () => {
    const device = Object.keys(relationCopy({ kind: "device" }).bucket).sort();
    const remote = Object.keys(relationCopy({ kind: "remote", name: "m" }).bucket).sort();
    expect(device).toEqual(remote);
  });

  it("carries the remote relation's own sentences", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.sentence.push).toBe("Pushes settings");
    expect(c.sentence.pull).toBe("Pulls settings");
    expect(c.sentence.excluded).toBe("Doesn't sync with this remote");
    expect(c.sentence.nothing).toBe("Nothing to send");
  });

  it("counts the fold lines in that relation's words", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.matchFold(1)).toBe("1 item matches this remote");
    expect(c.matchFold(4)).toBe("4 items match this remote");
    expect(c.excludedFold(1)).toBe("1 item doesn't sync with this remote");
    expect(c.excludedFold(3)).toBe("3 items don't sync with this remote");
  });
});

describe("withheldChangeClause", () => {
  it("names the remote, the size of the change, and why it stays there", () => {
    expect(withheldChangeClause("main", 3)).toBe("main changed 3 files. Push only, so they stay there.");
  });

  it("keeps the singular honest", () => {
    expect(withheldChangeClause("main", 1)).toBe("main changed 1 file. Push only, so they stay there.");
  });
});

describe("record-only clauses — a direction with no byte behind it states the run's substance", () => {
  it("pull: only what pressing the button does — no settings change, the row clears", () => {
    expect(RECORD_ONLY_PULL_CLAUSE).toBe("Changes nothing in your settings; just clears this row back to in sync.");
  });

  it("push mirrors with the remote's settings as the untouched side", () => {
    expect(recordOnlyPushClause("main")).toBe("Changes nothing in main's settings; just clears this row back to in sync.");
  });
});

describe("relation short labels — the picker names what you look at", () => {
  it("shortens without losing the counterpart from hover", () => {
    expect(relationShortLabel({ kind: "device" })).toBe("This device");
    expect(relationShortLabel({ kind: "remote", name: "main" })).toBe("main");
    expect(relationHint({ kind: "device" })).toBe("Comparing this device with your store");
    expect(relationHint({ kind: "remote", name: "main" })).toBe("Comparing your store with main");
  });
});

describe("pickerBadgeDigits", () => {
  it("reserves the widest count the picker itself shows, not the pane's", () => {
    const opts = viewOptions({
      current: { kind: "device" },
      deviceCounts: { up: 11, down: 1 },
      remotes: [{ name: "main", state: "same" as const, counts: { push: 0, pull: 4 } }],
    });
    expect(pickerBadgeDigits(opts)).toBe(2);
  });

  it("counts a state icon as no digits at all", () => {
    const opts = viewOptions({
      current: { kind: "device" },
      deviceCounts: { up: 0, down: 0 },
      remotes: [{ name: "main", state: "remote-newer" as const, counts: null }],
    });
    expect(pickerBadgeDigits(opts)).toBe(1);
  });
});
