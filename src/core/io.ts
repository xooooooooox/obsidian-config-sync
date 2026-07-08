export interface ListedDir {
  files: string[];
  folders: string[];
}

// Structurally satisfied by Obsidian's DataAdapter (app.vault.adapter).
export interface FileIO {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<ListedDir>;
}

export async function listFilesRecursive(io: FileIO, dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const listed = await io.list(cur);
    out.push(...listed.files);
    stack.push(...listed.folders);
  }
  return out.sort();
}

export async function ensureParentDir(io: FileIO, filePath: string): Promise<void> {
  const idx = filePath.lastIndexOf("/");
  if (idx === -1) return;
  const parts = filePath.slice(0, idx).split("/");
  let cur = "";
  for (const part of parts) {
    cur = cur === "" ? part : `${cur}/${part}`;
    if (!(await io.exists(cur))) {
      await io.mkdir(cur);
    }
  }
}

export async function pruneEmptyDirsUnder(io: FileIO, dir: string): Promise<void> {
  const listed = await io.list(dir);
  for (const sub of listed.folders) {
    await pruneDir(io, sub);
  }
}

async function pruneDir(io: FileIO, dir: string): Promise<boolean> {
  const listed = await io.list(dir);
  let empty = listed.files.length === 0;
  for (const sub of listed.folders) {
    const removed = await pruneDir(io, sub);
    if (!removed) empty = false;
  }
  if (empty) {
    await io.rmdir(dir, false);
    return true;
  }
  return false;
}
