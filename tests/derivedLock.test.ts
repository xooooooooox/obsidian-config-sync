import { describe, expect, it } from "vitest";
import { derivedPushLock } from "../src/core/derivedLock";
import { LockItems, StoreLock } from "../src/core/types";

const t0 = "2026-08-01T00:00:00.000Z";
const t1 = "2026-08-02T00:00:00.000Z";
const t2 = "2026-08-03T00:00:00.000Z";

// `StoreLock` carries an index signature for its unknown top-level keys, so the tail spreads in
// without a cast — and `LockItems` keeps the entries honestly typed rather than asserted into shape.
const lock = (capturedAt: string, items: LockItems, tail: Record<string, unknown> = {}): StoreLock => ({ capturedAt, items, ...tail });

describe("derivedPushLock", () => {
  it("sends our entry for an item this push sends", () => {
    const local = lock(t1, { community: { dataview: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { community: { dataview: { hash: "theirs", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["community"]?.["dataview"]).toEqual({ hash: "mine", capturedAt: t1 });
  });

  it("keeps the far end's own entry for an item this push does not send", () => {
    const local = lock(t1, { community: { "config-sync": { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { community: { "config-sync": { hash: "theirs", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.items["community"]?.["config-sync"]).toEqual({ hash: "theirs", capturedAt: t0 });
  });

  it("writes no entry at all for a withheld item the far end has never had", () => {
    const local = lock(t1, { community: { "config-sync": { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, {});
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.items["community"]?.["config-sync"]).toBeUndefined();
  });

  it("drops an entry only the far end has: push mirror-deletes that item's files", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { obsidian: { app: { hash: "theirs", capturedAt: t0 } }, community: { gone: { hash: "g", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["community"]?.["gone"]).toBeUndefined();
  });

  it("carries a field only their entry had onto the entry we send", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { obsidian: { app: { hash: "theirs", capturedAt: t0, futureField: 7 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["obsidian"]?.["app"]).toEqual({ hash: "mine", capturedAt: t1, futureField: 7 });
  });

  it("leaves their watermark where it is — our push is not their pull", () => {
    const local = lock(t1, {}, { syncedWatermark: t1 });
    const remote = lock(t0, {}, { syncedWatermark: t2 });
    expect(derivedPushLock({ local, remote, skipRefs: [] }).syncedWatermark).toBe(t2);
  });

  it("uses our own watermark only when the far end has no lock at all", () => {
    const local = lock(t1, {}, { syncedWatermark: t1 });
    expect(derivedPushLock({ local, remote: null, skipRefs: [] }).syncedWatermark).toBe(t1);
  });

  it("derives capturedAt from the entries it actually wrote, kept ones included", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t0 } } });
    const remote = lock(t0, { community: { "config-sync": { hash: "theirs", capturedAt: t2 } } });
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.capturedAt).toBe(t2);
  });

  it("declares the format this build writes", () => {
    expect(derivedPushLock({ local: lock(t1, {}), remote: null, skipRefs: [] }).version).toBe(3);
  });

  it("keeps an unknown top-level key from either side, the far end's winning a collision", () => {
    const local = lock(t1, {}, { mineOnly: 1, shared: "ours" });
    const remote = lock(t0, {}, { theirsOnly: 2, shared: "theirs" });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.mineOnly).toBe(1);
    expect(out.theirsOnly).toBe(2);
    expect(out.shared).toBe("theirs");
  });
});
