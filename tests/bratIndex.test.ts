import { describe, expect, it } from "vitest";
import { resolveBratIndex, parseBratRepoList } from "../src/core/bratIndex";

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
