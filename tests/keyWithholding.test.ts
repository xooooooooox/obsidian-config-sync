import { describe, expect, it } from "vitest";
import { overlayWithheld, withheldPatternPredicate } from "../src/core/keyWithholding";
import { ItemRef, RemoteItems, SyncGroup } from "../src/core/types";

const RULES: RemoteItems = {
  community: {
    dataview: { keys: { "*Token*": { direction: "none" }, defaultView: { direction: "push" } } },
    "config-sync": { direction: "pull", keys: { passphrase: { direction: "both" } } },
  },
};

describe("withheldPatternPredicate", () => {
  const groups: SyncGroup[] = [
    { name: "plugin-dataview", ref: "community/dataview" as ItemRef, path: "{configDir}/plugins/dataview/data.json", type: "file", devices: "all" },
    { name: "snippets", ref: "obsidian/snippets" as ItemRef, path: "{configDir}/snippets", type: "folder", devices: "all" },
    { name: "vimrc", ref: "obsidian/vimrc" as ItemRef, path: ".obsidian.vimrc", type: "file", devices: "all" },
  ];

  it("answers for a file item's JSON store copy, sidecars included", () => {
    const at = withheldPatternPredicate(RULES, "push", groups);
    expect(at("store/configdir/plugins/dataview/data.json")).toEqual(["*Token*"]);
    expect(at("store/configdir/plugins/dataview/data.json.__scopes__.desktop.json")).toEqual(["*Token*"]);
  });

  it("says nothing for a folder item, a non-JSON file, or bookkeeping", () => {
    const rules: RemoteItems = { obsidian: { snippets: { keys: { a: { direction: "none" } } }, vimrc: { keys: { a: { direction: "none" } } } } };
    const at = withheldPatternPredicate(rules, "push", groups);
    expect(at("store/configdir/snippets/one.css")).toEqual([]); // a folder travels whole
    expect(at("store/obsidian.vimrc")).toEqual([]); // no keys in this file
    expect(at("store.lock.json")).toEqual([]);
  });

  it("is a constant answer when the remote has no key rules at all", () => {
    const at = withheldPatternPredicate({ community: { dataview: { direction: "none" } } }, "push", groups);
    expect(at("store/configdir/plugins/dataview/data.json")).toEqual([]);
  });
});

describe("overlayWithheld", () => {
  const call = (keep: string | null, take: string, patterns: string[]): unknown =>
    JSON.parse(overlayWithheld({ rel: "store/configdir/plugins/demo/data.json", keep, take, patterns }));

  it("takes everything except the withheld keys, which stay as the kept side had them", () => {
    expect(call('{"a":1,"secret":"mine"}', '{"a":2,"secret":"theirs"}', ["secret"])).toEqual({ a: 2, secret: "mine" });
  });

  it("keeps a withheld key the taken side does not have at all", () => {
    expect(call('{"a":1,"secret":"mine"}', '{"a":2}', ["secret"])).toEqual({ a: 2, secret: "mine" });
  });

  it("omits a withheld key entirely when the kept side has no copy of the file", () => {
    expect(call(null, '{"a":2,"secret":"theirs"}', ["secret"])).toEqual({ a: 2 });
  });

  it("reaches nested keys, the way every other key rule in this codebase does", () => {
    expect(call('{"o":{"secret":"mine","b":1}}', '{"o":{"secret":"theirs","b":2}}', ["secret"])).toEqual({ o: { secret: "mine", b: 2 } });
  });

  it("writes the store's own JSON shape, so an unchanged item stays byte-identical", () => {
    const out = overlayWithheld({ rel: "r", keep: '{"a":1}\n', take: '{\n  "a": 1\n}\n', patterns: ["secret"] });
    expect(out).toBe('{\n  "a": 1\n}\n');
  });

  it("refuses rather than guessing when a side is not JSON: a rule we cannot honour must not be silently skipped", () => {
    expect(() => overlayWithheld({ rel: "store/configdir/x.json", keep: "{", take: "{}", patterns: ["s"] })).toThrow("store/configdir/x.json");
  });
});
