import { promises as fs } from "fs";
import * as nodePath from "path";
import { ExternalStoreReader } from "../core/ConfigSyncCore";

export function createLocalPathReader(sourceVaultPath: string, sourceRoot: string): ExternalStoreReader {
  const base = nodePath.join(sourceVaultPath, sourceRoot);
  return {
    async listFiles(): Promise<string[]> {
      try {
        await fs.access(base);
      } catch {
        throw new Error(`External source root not found: ${base} — check the source "path" and "root" settings`);
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
