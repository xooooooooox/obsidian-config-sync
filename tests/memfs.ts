import { FileIO, ListedDir } from "../src/core/io";

export class MemFS implements FileIO {
  files = new Map<string, string>();
  dirs = new Set<string>();
  mtimes = new Map<string, number>();

  /** Test control: set a file's mtime (epoch ms). Seeded files default to 1000. */
  touch(path: string, mtime: number): void {
    this.mtimes.set(path, mtime);
  }

  async stat(path: string): Promise<{ mtime: number } | null> {
    if (!this.files.has(path)) return null;
    return { mtime: this.mtimes.get(path) ?? 1000 };
  }

  seed(files: Record<string, string>): void {
    for (const [p, content] of Object.entries(files)) {
      this.files.set(p, content);
      this.addAncestors(p);
    }
  }

  private addAncestors(path: string): void {
    let cur = path;
    while (cur.includes("/")) {
      cur = cur.slice(0, cur.lastIndexOf("/"));
      this.dirs.add(cur);
    }
  }

  async read(path: string): Promise<string> {
    const c = this.files.get(path);
    if (c === undefined) throw new Error(`MemFS: read of missing file ${path}`);
    return c;
  }

  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
    this.addAncestors(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`MemFS: remove of missing file ${path}`);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
    this.addAncestors(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!this.dirs.has(path)) throw new Error(`MemFS: rmdir of missing dir ${path}`);
    const children = [...this.files.keys(), ...this.dirs].filter((p) => p.startsWith(path + "/"));
    if (!recursive && children.length > 0) {
      throw new Error(`MemFS: rmdir of non-empty dir ${path}`);
    }
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(path + "/")) this.files.delete(f);
    }
    for (const d of [...this.dirs]) {
      if (d === path || d.startsWith(path + "/")) this.dirs.delete(d);
    }
  }

  async list(path: string): Promise<ListedDir> {
    if (!this.dirs.has(path)) throw new Error(`MemFS: list of missing dir ${path}`);
    const files: string[] = [];
    const folders = new Set<string>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(path + "/")) continue;
      const rest = f.slice(path.length + 1);
      if (rest.includes("/")) folders.add(`${path}/${rest.slice(0, rest.indexOf("/"))}`);
      else files.push(f);
    }
    for (const d of this.dirs) {
      if (!d.startsWith(path + "/")) continue;
      const rest = d.slice(path.length + 1);
      if (!rest.includes("/")) folders.add(d);
    }
    return { files: files.sort(), folders: [...folders].sort() };
  }
}

export class FakePlugins {
  installed = new Map<string, string>();
  enabled = new Set<string>();
  installedNames = new Map<string, string>();
  coreNames = new Map<string, string>();
  appVersion = "1.8.7";
  coreEnabled = new Set<string>();
  log: string[] = [];

  getInstalledPluginVersion(id: string): string | null {
    return this.installed.get(id) ?? null;
  }
  isPluginEnabled(id: string): boolean {
    return this.enabled.has(id);
  }
  async disablePlugin(id: string): Promise<void> {
    this.enabled.delete(id);
    this.log.push(`disable:${id}`);
  }
  async enablePlugin(id: string): Promise<void> {
    this.enabled.add(id);
    this.log.push(`enable:${id}`);
  }
  async enablePluginPersistent(id: string): Promise<void> {
    this.enabled.add(id);
    this.log.push(`enable-persist:${id}`);
  }
  getInstalledPluginName(id: string): string | null {
    return this.installedNames.get(id) ?? null;
  }
  getCorePluginName(id: string): string | null {
    return this.coreNames.get(id) ?? null;
  }
  getAppVersion(): string {
    return this.appVersion;
  }
  isCorePluginEnabled(id: string): boolean {
    return this.coreEnabled.has(id);
  }
  async enableCorePlugin(id: string): Promise<void> {
    this.coreEnabled.add(id);
    this.log.push(`enable-core:${id}`);
  }
  async reloadPluginManifests(): Promise<void> {
    this.log.push("reload-manifests");
  }
}
