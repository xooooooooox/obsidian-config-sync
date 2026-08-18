import { describe, expect, it } from "vitest";
import { baseHasStaleLocalKeys } from "../src/core/ConfigSyncCore";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { ruleRowHasLocalLayer } from "../src/ui/itemCard";
import { EVERYWHERE, perClass, SyncGroup, THIS_DEVICE } from "../src/core/types";

const group: SyncGroup = {
  name: "graph",
  ref: "core/graph",
  path: "{configDir}/graph.json",
  type: "file",
  devices: "all",
  mode: "fields",
  fields: [{ pattern: "colorGroups", sharing: EVERYWHERE, encrypted: false }],
};

const local = JSON.stringify({ colorGroups: ["mine"], scale: 1 }, null, 2) + "\n";
// Deliberately the OPPOSITE key order from `local`: an implementation that rebuilds the object by
// spreading non-excepted keys first and appending excepted keys from the store afterwards would
// converge to a stable-but-wrong order on the first capture, and the idempotence test below would
// still pass (same wrong order reproduced twice). Only a genuinely order-preserving
// implementation — one that walks local's own key order and swaps in the store's value for an
// excepted key's slot — produces output whose keys match `local`'s order, not `store`'s.
const store = JSON.stringify({ scale: 1, colorGroups: ["theirs"] }, null, 2) + "\n";

describe("capture with a device exception", () => {
  it("keeps the store's value for the excepted key — never publishes the local one", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["theirs"], scale: 1 });
  });

  it("does not invent the key when the store never had it", async () => {
    const bare = JSON.stringify({ scale: 1 }, null, 2) + "\n";
    const out = await captureTransform(group, local, null, "desktop", bare, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
  });

  it("is idempotent — a second capture reproduces the same bytes", async () => {
    const first = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    // Local's key order ("colorGroups", "scale"), not the store's ("scale", "colorGroups") —
    // proves the excepted key kept local's slot rather than being appended from the store.
    expect(Object.keys(JSON.parse(first.content) as Record<string, unknown>)).toEqual(["colorGroups", "scale"]);
    const second = await captureTransform(group, local, null, "desktop", first.content, null, ["colorGroups"]);
    expect(second.content).toBe(first.content);
  });

  it("without the exception the local value wins, exactly as before", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, []);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });
});

describe("apply with a device exception", () => {
  it("keeps this device's value and still applies the rest", async () => {
    const out = await applyTransform(group, store, local, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });

  it("with no local file the excepted key does not land", async () => {
    const out = await applyTransform(group, store, null, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ scale: 1 });
  });
});

describe("comparison with a device exception", () => {
  it("differing only in the excepted key reads as unchanged", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, ["colorGroups"])).toBe(true);
  });

  it("a real difference elsewhere still reads as changed", async () => {
    const moved = JSON.stringify({ colorGroups: ["mine"], scale: 2 }, null, 2) + "\n";
    expect(await contentUnchanged(group, moved, store, null, "desktop", null, ["colorGroups"])).toBe(false);
  });

  it("without the exception the same pair reads as changed", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, [])).toBe(false);
  });
});

// The four blocks below exist because everything above uses ONE shape of rule — `everywhere`,
// unencrypted, no per-item scopes, no sidecar. "Capture leaves the store's value as it found it" is
// a claim about the whole store copy, and a fields-mode store copy is TWO files: the base and this
// device class's `__scopes__` sidecar. A rule whose fleet answer is `Desktop only` keeps its value
// in the sidecar, so an exception that only rewrote the base published this device's private answer
// into a file every desktop device shares — the same cross-device overwrite the exception exists to
// prevent, one file over.

describe("a class-scoped key's exception reaches the class sidecar too", () => {
  const classGroup: SyncGroup = {
    ...group,
    fields: [
      { pattern: "colorGroups", sharing: perClass("desktop"), encrypted: false },
      { pattern: "scale", sharing: EVERYWHERE, encrypted: false },
    ],
  };
  // The base never carries a class-scoped key — the partition sends it to the sidecar before any
  // other rule runs — so the STORE's copy of an excepted `Desktop only` key lives only here.
  const priorSidecar = JSON.stringify({ colorGroups: ["theirs"] }, null, 2) + "\n";
  const base = JSON.stringify({ scale: 1 }, null, 2) + "\n";

  it("keeps the sidecar's existing value — this device's answer never reaches the shared sidecar", async () => {
    const out = await captureTransform(classGroup, local, null, "desktop", base, priorSidecar, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
    expect(JSON.parse(out.ownScope as string)).toEqual({ colorGroups: ["theirs"] });
  });

  it("does not invent the key in the sidecar when the sidecar never had it", async () => {
    const out = await captureTransform(classGroup, local, null, "desktop", base, null, ["colorGroups"]);
    expect(JSON.parse(out.ownScope as string)).toEqual({});
  });

  it("is idempotent — a second capture reproduces both files byte-for-byte", async () => {
    const first = await captureTransform(classGroup, local, null, "desktop", base, priorSidecar, ["colorGroups"]);
    const second = await captureTransform(classGroup, local, null, "desktop", first.content, first.ownScope, ["colorGroups"]);
    expect(second.content).toBe(first.content);
    expect(second.ownScope).toBe(first.ownScope);
  });

  it("without the exception the local value still reaches the sidecar, exactly as before", async () => {
    const out = await captureTransform(classGroup, local, null, "desktop", base, priorSidecar, []);
    expect(JSON.parse(out.ownScope as string)).toEqual({ colorGroups: ["mine"] });
  });
});

describe("an exception cannot resurrect a key the base is forbidden to hold", () => {
  // A base written before the rule existed still carries the key. ConfigSyncCore's base-hygiene
  // guards force the rewrite that purges it; an exception that re-added the key from that same
  // stale base would pin a device-local value in the shared store and leave every future capture
  // rewriting a file that never converges.
  const staleBase = JSON.stringify({ colorGroups: ["stale"], scale: 1 }, null, 2) + "\n";

  it("a this-device key stays stripped, and the base converges", async () => {
    const localOnly: SyncGroup = { ...group, fields: [{ pattern: "colorGroups", sharing: THIS_DEVICE, encrypted: false }] };
    const out = await captureTransform(localOnly, local, null, "desktop", staleBase, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
    expect(baseHasStaleLocalKeys(localOnly, out.content)).toBe(false);
  });

  it("a class-scoped key is not re-added to the base from a stale copy", async () => {
    const classGroup: SyncGroup = { ...group, fields: [{ pattern: "colorGroups", sharing: perClass("desktop"), encrypted: false }] };
    const out = await captureTransform(classGroup, local, null, "desktop", staleBase, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
  });

  it("the other class's key is not re-added to the base either", async () => {
    const classGroup: SyncGroup = { ...group, fields: [{ pattern: "colorGroups", sharing: perClass("mobile"), encrypted: false }] };
    const out = await captureTransform(classGroup, local, null, "desktop", staleBase, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
  });
});

describe("a per-item key has no local layer at all (spec §2)", () => {
  const perElementGroup: SyncGroup = {
    ...group,
    fields: [{ pattern: "enabledSnippets", sharing: EVERYWHERE, encrypted: false }],
    perElement: { enabledSnippets: {} },
  };
  const localList = JSON.stringify({ enabledSnippets: ["a", "b"], scale: 1 }, null, 2) + "\n";
  const storeList = JSON.stringify({ enabledSnippets: ["c"], scale: 1 }, null, 2) + "\n";

  it("capture ignores an exception on a per-item key — the elements publish either way", async () => {
    const withExc = await captureTransform(perElementGroup, localList, null, "desktop", storeList, null, ["enabledSnippets"]);
    const without = await captureTransform(perElementGroup, localList, null, "desktop", storeList, null, []);
    expect(withExc.content).toBe(without.content);
    expect(JSON.parse(withExc.content)).toEqual({ enabledSnippets: ["a", "b"], scale: 1 });
  });

  // …which is exactly why the row must not offer the control. A menu whose two entries produce the
  // same bytes is an option no runtime path will honour — the reason §2 refused a local layer for
  // the element rows one level down.
  it("the rule row hides its local segment while per-item rules are on", () => {
    const row = { key: "enabledSnippets", isArray: true, rule: { sharing: EVERYWHERE, encrypted: false }, perElementEnabled: true };
    expect(ruleRowHasLocalLayer(row)).toBe(false);
    expect(ruleRowHasLocalLayer({ ...row, perElementEnabled: false })).toBe(true);
  });

  // Same refusal, the other reason: a key shared with NO ONE is already absent from the store, so
  // "don't sync it here" asks for the state it is permanently in. The shared answer said there is
  // no shared value; opting out of one is the local layer's only job.
  it("the rule row hides its local segment when the key is shared with no one", () => {
    const row = { key: "colorGroups", isArray: false, rule: { sharing: THIS_DEVICE, encrypted: false }, perElementEnabled: false };
    expect(ruleRowHasLocalLayer(row)).toBe(false);
    expect(ruleRowHasLocalLayer({ ...row, rule: { sharing: EVERYWHERE, encrypted: false } })).toBe(true);
  });
});

describe("an excepted encrypted key keeps the store's ciphertext byte-for-byte (spec §4)", () => {
  const encGroup: SyncGroup = { ...group, fields: [{ pattern: "colorGroups", sharing: EVERYWHERE, encrypted: true }] };
  const PASSPHRASE = "a passphrase this device happens to know";

  it("neither re-encrypts this device's value nor drops the key", async () => {
    // Build the store the honest way — one capture from a device that does share the key — so the
    // stored value is a real envelope with its own salt/IV, not a hand-written stand-in.
    const theirs = JSON.stringify({ colorGroups: ["theirs"], scale: 1 }, null, 2) + "\n";
    const storeCiphertext = (await captureTransform(encGroup, theirs, PASSPHRASE, "desktop", null, null, [])).content;
    const out = await captureTransform(encGroup, local, PASSPHRASE, "desktop", storeCiphertext, null, ["colorGroups"]);
    expect(out.content).toBe(storeCiphertext);
  });
});
