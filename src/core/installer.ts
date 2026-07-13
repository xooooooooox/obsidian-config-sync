import { FileIO, ensureParentDir } from "./io";

export type HttpGet = (url: string) => Promise<ArrayBuffer>; // must throw on non-2xx

export class CatalogError extends Error {}
export class DownloadError extends Error {}

export const COMMUNITY_CATALOG_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";

interface CatalogEntry {
  id: string;
  repo: string;
}

const decode = (buf: ArrayBuffer): string => new TextDecoder().decode(buf);

// Returns an install function that downloads a community plugin's latest release
// (manifest.json + main.js required, styles.css optional) into {configDir}/plugins/{id}/
// and resolves to the installed manifest version. The catalog is fetched once per installer.
export function createInstaller(io: FileIO, configDir: string, http: HttpGet): (pluginId: string) => Promise<string> {
  let catalog: Promise<CatalogEntry[]> | null = null;
  const loadCatalog = (): Promise<CatalogEntry[]> => {
    if (catalog === null) {
      catalog = http(COMMUNITY_CATALOG_URL).then((buf) => JSON.parse(decode(buf)) as CatalogEntry[]);
      catalog.catch(() => {
        catalog = null; // a failed fetch must not poison later installs
      });
    }
    return catalog;
  };
  return async (pluginId: string): Promise<string> => {
    const entries = await loadCatalog();
    const entry = entries.find((e) => e.id === pluginId);
    if (entry === undefined) {
      throw new CatalogError(`${pluginId} isn't in the community catalog — install it manually`);
    }
    const base = `https://github.com/${entry.repo}/releases/latest/download`;
    const required = async (file: string): Promise<string> => {
      try {
        return decode(await http(`${base}/${file}`));
      } catch {
        throw new DownloadError(`couldn't download ${pluginId} from the community catalog`);
      }
    };
    const manifestRaw = await required("manifest.json");
    const mainJs = await required("main.js");
    const manifest = JSON.parse(manifestRaw) as { version?: string };
    if (typeof manifest.version !== "string") {
      throw new DownloadError(`couldn't download ${pluginId} from the community catalog`);
    }
    const dir = `${configDir}/plugins/${pluginId}`;
    await ensureParentDir(io, `${dir}/manifest.json`);
    await io.write(`${dir}/manifest.json`, manifestRaw);
    await io.write(`${dir}/main.js`, mainJs);
    try {
      await io.write(`${dir}/styles.css`, decode(await http(`${base}/styles.css`)));
    } catch {
      // styles.css is optional — many plugins ship without one
    }
    return manifest.version;
  };
}
