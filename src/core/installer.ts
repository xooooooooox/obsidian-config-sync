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

interface Resolved {
  manifestRaw: string;
  mainJs: string;
  base: string;
  version: string;
}

// Returns an install function that downloads a community plugin into {configDir}/plugins/{id}/
// and resolves to the installed manifest version. Without a target version it installs the
// stable version the repo's root manifest points to (what Obsidian's own community browser
// does — NOT GitHub's "latest release", which can be a divergent beta). With a target version
// it pins to that version's tagged release, falling back to latest-stable if that tag is gone.
// The catalog is fetched once per installer.
export function createInstaller(io: FileIO, configDir: string, http: HttpGet): (pluginId: string, targetVersion?: string) => Promise<string> {
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
  return async (pluginId: string, targetVersion?: string): Promise<string> => {
    const entries = await loadCatalog();
    const entry = entries.find((e) => e.id === pluginId);
    if (entry === undefined) {
      throw new CatalogError(`${pluginId} isn't in the community catalog — install it manually`);
    }
    const repo = entry.repo;

    // Download and validate a specific version's tagged release (manifest.json + main.js
    // required). Throws on any missing/invalid asset or id mismatch.
    const fromRelease = async (version: string): Promise<Resolved> => {
      const base = `https://github.com/${repo}/releases/download/${version}`;
      const grab = async (file: string): Promise<string> => {
        try {
          return decode(await http(`${base}/${file}`));
        } catch {
          throw new DownloadError(`couldn't download ${pluginId} ${version} from the community catalog`);
        }
      };
      const manifestRaw = await grab("manifest.json");
      const mainJs = await grab("main.js");
      const manifest = JSON.parse(manifestRaw) as { id?: string; version?: string };
      if (typeof manifest.version !== "string") {
        throw new DownloadError(`couldn't download ${pluginId} ${version} from the community catalog`);
      }
      if (manifest.id !== pluginId) {
        throw new DownloadError(
          `${pluginId}'s release identifies as "${manifest.id}" — install it manually from the community browser`
        );
      }
      return { manifestRaw, mainJs, base, version: manifest.version };
    };

    // The stable version Obsidian would install: the version pinned in the repo's root manifest.
    const latestStable = async (): Promise<Resolved> => {
      const rootRaw = decode(await http(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`));
      const root = JSON.parse(rootRaw) as { version?: string };
      if (typeof root.version !== "string") {
        throw new DownloadError(`couldn't resolve ${pluginId}'s version from the community catalog`);
      }
      return fromRelease(root.version);
    };

    let resolved: Resolved;
    if (targetVersion !== undefined) {
      try {
        resolved = await fromRelease(targetVersion);
      } catch {
        resolved = await latestStable(); // pinned tag gone — install the current stable instead
      }
    } else {
      resolved = await latestStable();
    }

    const dir = `${configDir}/plugins/${pluginId}`;
    await ensureParentDir(io, `${dir}/manifest.json`);
    await io.write(`${dir}/manifest.json`, resolved.manifestRaw);
    await io.write(`${dir}/main.js`, resolved.mainJs);
    let styles: string | null = null;
    try {
      styles = decode(await http(`${resolved.base}/styles.css`));
    } catch {
      // styles.css is optional — many plugins ship without one
    }
    if (styles !== null) await io.write(`${dir}/styles.css`, styles);
    return resolved.version;
  };
}
