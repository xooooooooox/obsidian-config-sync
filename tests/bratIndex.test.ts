import { describe, expect, it } from "vitest";
import { resolveBratIndex, parseBratRepoList, bratRepoIndex, withBratRepos } from "../src/core/bratIndex";
import { itemsIn } from "./items";

const fetcher =
  (manifests: Record<string, string | null>) =>
  async (repo: string): Promise<string | null> =>
    manifests[repo] ?? null;

describe("resolveBratIndex", () => {
  it("fills unresolved repos from fetched manifests and keys by plugin id", async () => {
    const index = await resolveBratIndex(
      {},
      ["shawndotty/slidesrup", "Kenshin/simpread-obsidian-plugin"],
      fetcher({
        "shawndotty/slidesrup": JSON.stringify({ id: "slides-rup", name: "SlidesRup" }),
        "Kenshin/simpread-obsidian-plugin": JSON.stringify({ id: "simpread", name: "SimpRead Sync" }),
      })
    );
    expect(index).toEqual({ "slides-rup": "shawndotty/slidesrup", simpread: "Kenshin/simpread-obsidian-plugin" });
  });

  it("keeps already-resolved entries without refetching them", async () => {
    let calls = 0;
    const index = await resolveBratIndex({ "slides-rup": "shawndotty/slidesrup" }, ["shawndotty/slidesrup"], async () => {
      calls += 1;
      return null;
    });
    expect(index).toEqual({ "slides-rup": "shawndotty/slidesrup" });
    expect(calls).toBe(0);
  });

  it("prunes entries whose repo left the BRAT list", async () => {
    const index = await resolveBratIndex({ "slides-rup": "shawndotty/slidesrup", gone: "x/gone" }, ["shawndotty/slidesrup"], fetcher({}));
    expect(index).toEqual({ "slides-rup": "shawndotty/slidesrup" });
  });

  it("leaves failed fetches unresolved without throwing", async () => {
    const index = await resolveBratIndex({}, ["a/one", "b/two"], fetcher({ "b/two": JSON.stringify({ id: "two" }) }));
    expect(index).toEqual({ two: "b/two" });
  });

  it("ignores manifests without a string id", async () => {
    const index = await resolveBratIndex({}, ["a/bad"], fetcher({ "a/bad": JSON.stringify({ name: "no id" }) }));
    expect(index).toEqual({});
  });

  it("ignores unparseable manifests", async () => {
    const index = await resolveBratIndex({}, ["a/broken"], fetcher({ "a/broken": "not json" }));
    expect(index).toEqual({});
  });
});

describe("BRAT repos on the plugin they belong to", () => {
  it("reads the index back out of the items map", () => {
    const items = itemsIn({ community: { dataview: { synced: true }, "some-beta": { synced: true, bratRepo: "owner/some-beta" } } });
    expect(bratRepoIndex(items)).toEqual({ "some-beta": "owner/some-beta" });
  });

  it("a resolved repo for a plugin with no entry creates a skeleton that is NOT synced", () => {
    const next = withBratRepos(itemsIn({}), { "new-beta": "owner/new-beta" });
    expect(next.community["new-beta"]).toEqual({ synced: false, bratRepo: "owner/new-beta" });
  });

  it("a repo that left BRAT's list clears the field without touching the rest of the item", () => {
    const before = itemsIn({ community: { "some-beta": { synced: true, bratRepo: "owner/some-beta", path: "custom.json" } } });
    const after = withBratRepos(before, {});
    expect(after.community["some-beta"]).toEqual({ synced: true, path: "custom.json" });
  });
});

describe("parseBratRepoList", () => {
  it("extracts pluginList string entries from BRAT data.json content", () => {
    expect(parseBratRepoList('{"pluginList":["a/one","b/two"],"other":1}')).toEqual(["a/one", "b/two"]);
  });
  it("returns [] for missing/invalid pluginList or unparseable content", () => {
    expect(parseBratRepoList('{"pluginList":"nope"}')).toEqual([]);
    expect(parseBratRepoList("{}")).toEqual([]);
    expect(parseBratRepoList("not json")).toEqual([]);
  });
  it("drops non-string entries", () => {
    expect(parseBratRepoList('{"pluginList":["a/one",42,null]}')).toEqual(["a/one"]);
  });
});
