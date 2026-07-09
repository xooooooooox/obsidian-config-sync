import { promises as fs } from "fs";
import * as nodePath from "path";
import { ExternalStoreReader, ExternalStoreWriter } from "../core/ConfigSyncCore";

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

export function createLocalPathWriter(destVaultPath: string, destRoot: string): ExternalStoreWriter {
  const base = nodePath.join(destVaultPath, destRoot);
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
