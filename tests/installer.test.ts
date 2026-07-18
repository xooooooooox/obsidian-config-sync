import { describe, expect, it } from "vitest";
import { COMMUNITY_CATALOG_URL, CatalogError, DownloadError, createInstaller } from "../src/core/installer";
import { MemFS } from "./memfs";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const CATALOG = JSON.stringify([{ id: "demo", name: "Demo", repo: "acme/demo" }]);
const ROOT = "https://raw.githubusercontent.com/acme/demo/HEAD/manifest.json";
const rel = (version: string): string => `https://github.com/acme/demo/releases/download/${version}`;

function fakeHttp(files: Record<string, string | null>): { http: (url: string) => Promise<ArrayBuffer>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    http: async (url: string) => {
      calls.push(url);
      const body = files[url];
      if (body === undefined || body === null) throw new Error(`404 ${url}`);
      return enc(body);
    },
  };
}

describe("createInstaller", () => {
  it("resolves the stable version from the root manifest and downloads that tagged release", async () => {
    const io = new MemFS();
    const { http, calls } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [ROOT]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/manifest.json`]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/main.js`]: "module.exports = {};",
      [`${rel("1.5.10")}/styles.css`]: ".x{}",
    });
    const install = createInstaller(io, ".obs", http);
    expect(await install("demo")).toBe("1.5.10");
    expect(await io.read(".obs/plugins/demo/manifest.json")).toContain("1.5.10");
    expect(await io.read(".obs/plugins/demo/main.js")).toBe("module.exports = {};");
    expect(await io.read(".obs/plugins/demo/styles.css")).toBe(".x{}");
    // never touches "releases/latest" (which can be a divergent beta)
    expect(calls.some((u) => u.includes("releases/latest"))).toBe(false);
    await install("demo");
    expect(calls.filter((u) => u === COMMUNITY_CATALOG_URL)).toHaveLength(1); // catalog cached
  });

  it("does NOT install a beta whose 'latest release' id diverges — root manifest wins", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      // root manifest is the stable line; a hypothetical latest-release beta is simply never fetched
      [ROOT]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/manifest.json`]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/main.js`]: "x",
      [`${rel("1.5.10")}/styles.css`]: null,
    });
    expect(await createInstaller(io, ".obs", http)("demo")).toBe("1.5.10");
  });

  it("installs a pinned target version from its tagged release", async () => {
    const io = new MemFS();
    const { http, calls } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${rel("1.4.0")}/manifest.json`]: JSON.stringify({ id: "demo", version: "1.4.0" }),
      [`${rel("1.4.0")}/main.js`]: "pinned",
      [`${rel("1.4.0")}/styles.css`]: null,
    });
    expect(await createInstaller(io, ".obs", http)("demo", "1.4.0")).toBe("1.4.0");
    expect(await io.read(".obs/plugins/demo/main.js")).toBe("pinned");
    expect(calls.includes(ROOT)).toBe(false); // pinned path skips root-manifest resolution
  });

  it("falls back to latest-stable when the pinned release is missing", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      // 0.9.0 tag was deleted — its assets 404
      [ROOT]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/manifest.json`]: JSON.stringify({ id: "demo", version: "1.5.10" }),
      [`${rel("1.5.10")}/main.js`]: "latest",
      [`${rel("1.5.10")}/styles.css`]: null,
    });
    // returns the fallback version, so the caller can detect the mismatch and warn
    expect(await createInstaller(io, ".obs", http)("demo", "0.9.0")).toBe("1.5.10");
    expect(await io.read(".obs/plugins/demo/main.js")).toBe("latest");
  });

  it("tolerates a missing styles.css", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [ROOT]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${rel("2.5.0")}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${rel("2.5.0")}/main.js`]: "x",
      [`${rel("2.5.0")}/styles.css`]: null,
    });
    expect(await createInstaller(io, ".obs", http)("demo")).toBe("2.5.0");
    expect(await io.exists(".obs/plugins/demo/styles.css")).toBe(false);
  });

  it("throws CatalogError for unknown ids and DownloadError for failed required assets", async () => {
    const io = new MemFS();
    const miss = fakeHttp({ [COMMUNITY_CATALOG_URL]: CATALOG });
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow(CatalogError);
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow("not in the community catalog");
    const noMain = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [ROOT]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${rel("2.5.0")}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${rel("2.5.0")}/main.js`]: null,
    });
    await expect(createInstaller(io, ".obs", noMain.http)("demo")).rejects.toThrow(DownloadError);
  });

  it("rejects when the resolved release manifest identifies as a different plugin id, writing nothing", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [ROOT]: JSON.stringify({ id: "demo", version: "9.0.0" }),
      [`${rel("9.0.0")}/manifest.json`]: JSON.stringify({ id: "demo-beta", version: "9.0.0" }),
      [`${rel("9.0.0")}/main.js`]: "x",
      [`${rel("9.0.0")}/styles.css`]: ".x{}",
    });
    await expect(createInstaller(io, ".obs", http)("demo")).rejects.toThrow('identifies as "demo-beta"');
    expect(await io.exists(".obs/plugins/demo/manifest.json")).toBe(false);
  });
});
