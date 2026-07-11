import { promises as fs } from "fs";
import * as nodePath from "path";
import { homedir } from "os";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

export function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? nodePath.join(homedir(), p.slice(1)) : p;
}

export function createLocalPathReader(storeDir: string): ExternalStoreReader {
  const base = expandTilde(storeDir);
  return {
    async listFiles(): Promise<string[]> {
      try {
        await fs.access(base);
      } catch {
        throw new Error(`External store not found: ${base} — check the remote's "Store path" setting`);
      }
      const out: string[] = [];
      await walk(base, "", out);
      return out.sort();
    },
    async readFile(relPath: string): Promise<string> {
      return fs.readFile(nodePath.join(base, relPath), "utf8");
    },
  };
}

export function createLocalPathWriter(storeDir: string): ExternalStoreWriter {
  const base = expandTilde(storeDir);
  return {
    async listFiles(): Promise<string[]> {
      const out: string[] = [];
      try {
        await fs.access(base);
        await walk(base, "", out);
      } catch {
        // dest root does not exist yet — nothing to list
      }
      return out.sort();
    },
    async readFile(relPath: string): Promise<string> {
      return fs.readFile(nodePath.join(base, relPath), "utf8");
    },
    async writeFile(relPath: string, content: string): Promise<void> {
      const target = nodePath.join(base, relPath);
      await fs.mkdir(nodePath.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
    async deleteFile(relPath: string): Promise<void> {
      await fs.rm(nodePath.join(base, relPath), { force: true });
    },
    async finalize(): Promise<void> {
      // no-op: fs writes are already durable
    },
  };
}

async function walk(absBase: string, rel: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(nodePath.join(absBase, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(absBase, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
  }
}

/** BFS for directories containing config-sync.json: depth ≤ 4, skips dot-dirs and node_modules,
 *  does not descend below a hit. Used by the settings Browse flow to locate a store. */
export async function findStoreDirs(baseAbs: string): Promise<string[]> {
  const base = expandTilde(baseAbs);
  const hits: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const abs = item.rel === "" ? base : nodePath.join(base, item.rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (item.rel === "") throw new Error(`Cannot read folder ${base}: ${(e as Error).message}`);
      continue; // unreadable subdir — keep scanning the rest
    }
    if (entries.some((e) => e.isFile() && e.name === "config-sync.json")) {
      hits.push(abs);
      continue;
    }
    if (item.depth >= 4) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      queue.push({ rel: item.rel === "" ? entry.name : `${item.rel}/${entry.name}`, depth: item.depth + 1 });
    }
  }
  return hits.sort();
}
