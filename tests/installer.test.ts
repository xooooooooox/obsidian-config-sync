import { describe, expect, it } from "vitest";
import { COMMUNITY_CATALOG_URL, CatalogError, DownloadError, createInstaller } from "../src/core/installer";
import { MemFS } from "./memfs";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer;
const CATALOG = JSON.stringify([{ id: "demo", name: "Demo", repo: "acme/demo" }]);

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
  const base = "https://github.com/acme/demo/releases/latest/download";
  it("downloads manifest/main.js/styles.css into the plugin dir and returns the version", async () => {
    const io = new MemFS();
    const { http, calls } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: "module.exports = {};",
      [`${base}/styles.css`]: ".x{}",
    });
    const install = createInstaller(io, ".obs", http);
    expect(await install("demo")).toBe("2.5.0");
    expect(await io.read(".obs/plugins/demo/manifest.json")).toContain("2.5.0");
    expect(await io.read(".obs/plugins/demo/main.js")).toBe("module.exports = {};");
    expect(await io.read(".obs/plugins/demo/styles.css")).toBe(".x{}");
    await install("demo");
    expect(calls.filter((u) => u === COMMUNITY_CATALOG_URL)).toHaveLength(1); // catalog cached
  });
  it("tolerates a missing styles.css", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: "x",
      [`${base}/styles.css`]: null,
    });
    expect(await createInstaller(io, ".obs", http)("demo")).toBe("2.5.0");
    expect(await io.exists(".obs/plugins/demo/styles.css")).toBe(false);
  });
  it("throws CatalogError for unknown ids and DownloadError for failed required assets", async () => {
    const io = new MemFS();
    const miss = fakeHttp({ [COMMUNITY_CATALOG_URL]: CATALOG });
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow(CatalogError);
    await expect(createInstaller(io, ".obs", miss.http)("nope")).rejects.toThrow(
      'nope isn\'t in the community catalog — install it manually'
    );
    const noMain = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: null,
    });
    await expect(createInstaller(io, ".obs", noMain.http)("demo")).rejects.toThrow(DownloadError);
    await expect(createInstaller(io, ".obs", noMain.http)("demo")).rejects.toThrow(
      "couldn't download demo from the community catalog"
    );
  });
  it("rejects when the release manifest identifies as a different plugin id, and writes nothing to disk", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo-beta", version: "9.0.0" }),
      [`${base}/main.js`]: "x",
      [`${base}/styles.css`]: ".x{}",
    });
    await expect(createInstaller(io, ".obs", http)("demo")).rejects.toThrow(DownloadError);
    await expect(createInstaller(io, ".obs", http)("demo")).rejects.toThrow('identifies as "demo-beta"');
    expect(await io.exists(".obs/plugins/demo/manifest.json")).toBe(false);
  });
  it("rejects when styles.css write fails (disk full, permissions, etc)", async () => {
    const io = new MemFS();
    const { http } = fakeHttp({
      [COMMUNITY_CATALOG_URL]: CATALOG,
      [`${base}/manifest.json`]: JSON.stringify({ id: "demo", version: "2.5.0" }),
      [`${base}/main.js`]: "x",
      [`${base}/styles.css`]: ".x{}",
    });
    // Wrap io.write to throw for styles.css after manifest/main.js are written
    let manifestWritten = false;
    let mainWritten = false;
    const originalWrite = io.write.bind(io);
    io.write = async (path: string, data: string) => {
      if (path.endsWith("/manifest.json")) {
        await originalWrite(path, data);
        manifestWritten = true;
      } else if (path.endsWith("/main.js")) {
        await originalWrite(path, data);
        mainWritten = true;
      } else if (path.endsWith("/styles.css") && manifestWritten && mainWritten) {
        throw new Error("disk full");
      } else {
        await originalWrite(path, data);
      }
    };
    await expect(createInstaller(io, ".obs", http)("demo")).rejects.toThrow("disk full");
  });
});
