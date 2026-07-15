import { Menu, Notice, Platform, Plugin, apiVersion, requestUrl } from "obsidian";
import {
  ApplyItem,
  applyImport,
  CoreContext,
  ExternalStoreReader,
  ExternalStoreWriter,
  PluginHost,
  PluginInstallFn,
  planImport,
  ProgressFn,
  applyWithActions,
  capture,
  groupsForDevice,
  loadLock,
  loadManifest,
  pushExternal,
  readGroups,
  revertLastApply,
  writeGroups,
} from "./core/ConfigSyncCore";
import { createInstaller } from "./core/installer";
import { type CatalogSection, displayLabelForGroup, ensureSelfPresets, groupForItem, listCoreSections, listDiscovered, listOptionSections, listPluginSections, SELF_GROUP_NAME, setCorePluginIds } from "./core/catalog";
import { Availability, availabilityForGroup } from "./core/availability";
import { listFilesRecursive } from "./core/io";
import { ManifestValidationError, migrateLegacyManifest, parseStoreLock, validateSyncManifest } from "./core/manifest";
import { groupRealPath } from "./core/pathing";
import { scanSensitive, SensitiveScan } from "./core/modes";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { bucketCounts, checkRemote, diffRemote, GroupStatus, RemoteCheck, statusForGroups } from "./core/status";
import { Remote, RibbonButtons, StoreLock, SyncGroup } from "./core/types";
import { ConflictModal } from "./ui/ConflictModal";
import { ReportModal } from "./ui/ReportModal";
import { SYNC_CENTER_VIEW_TYPE, SyncCenterHost, SyncCenterView } from "./ui/SyncCenterView";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  remotes: Remote[];
  ribbonButtons: RibbonButtons;
  statusInMenu: boolean;
  remoteAutoCheck: boolean;
  localPeriodicCheck: boolean;
  groups: SyncGroup[];
}

const DEFAULT_SETTINGS: ConfigSyncSettings = {
  pkmMode: "auto",
  rootPath: "",
  remotes: [],
  ribbonButtons: { sync: false, revert: false },
  statusInMenu: true,
  remoteAutoCheck: true,
  localPeriodicCheck: true,
  groups: [],
};

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string }>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  enablePluginAndSave(id: string): Promise<void>;
  loadManifests(): Promise<void>;
}

// app.internalPlugins is not part of the public API; this is the community-standard access path for core plugins.
interface InternalPluginsRegistry {
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string }; enable(): Promise<void> }>;
}

export default class ConfigSyncPlugin extends Plugin {
  settings: ConfigSyncSettings = DEFAULT_SETTINGS;
  private individualRibbons: HTMLElement[] = [];
  private mainRibbonEl: HTMLElement | null = null;
  private lastResolvedRoot: string | null = null;
  private installFn: PluginInstallFn | null = null;
  localStatuses: GroupStatus[] | null = null;
  private lastGroups: SyncGroup[] | null = null;
  remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
  private storeEventTimer: number | null = null;
  private remoteAutoCheckStartupTimer: number | null = null;
  private bootstrapDismissed = false; // session-only: "adopt configuration" banner dismissed

  async onload(): Promise<void> {
    await this.loadSettings();
    setCorePluginIds(this.coreRuntime().map((c) => c.id));
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.registerView(SYNC_CENTER_VIEW_TYPE, (leaf) => new SyncCenterView(leaf, this.syncCenterHost()));
    this.mainRibbonEl = this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => void this.openSyncMenu(evt));
    this.refreshRibbons();
    this.addCommand({ id: "sync", name: "Sync: open the sync panel", callback: () => void this.openSyncCenter() });
    this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });

    // --- awareness runtime ---
    this.registerEvent(this.app.vault.on("modify", (f) => this.onStoreFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("create", (f) => this.onStoreFileEvent(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => this.onStoreFileEvent(f.path)));
    this.registerEvent(
      this.app.vault.on("rename", (f, old) => {
        this.onStoreFileEvent(f.path);
        this.onStoreFileEvent(old);
      })
    );
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.localPeriodicCheck && document.hasFocus()) void this.refreshLocalStatus();
      }, 5 * 60 * 1000)
    );
    if (Platform.isDesktop) {
      this.remoteAutoCheckStartupTimer = window.setTimeout(() => {
        this.remoteAutoCheckStartupTimer = null;
        if (this.settings.remoteAutoCheck) void this.refreshRemoteChecks();
      }, 30 * 1000);
      this.registerInterval(
        window.setInterval(() => {
          if (this.settings.remoteAutoCheck) void this.refreshRemoteChecks();
        }, 4 * 60 * 60 * 1000)
      );
    }
    this.app.workspace.onLayoutReady(
      () =>
        void (async () => {
          await this.migrateLegacy();
          await this.refreshLocalStatus();
        })()
    );
  }

  private async migrateLegacy(): Promise<void> {
    try {
      const rootPath = await this.resolvedRootPath();
      const result = await migrateLegacyManifest(this.app.vault.adapter, rootPath, this.settings.groups, new Date().toISOString());
      if (result.migrated) {
        this.settings.groups = ensureSelfPresets(result.groups);
        await this.saveSettings();
        new Notice("Config Sync: imported groups from config-sync.json (file renamed, now lives in plugin settings)");
      }
    } catch (e) {
      if (e instanceof ManifestValidationError) {
        new Notice(`Config Sync: could not migrate config-sync.json — ${e.message}`, 10000);
        return;
      }
      console.error("Config Sync: unexpected error migrating config-sync.json", e);
      new Notice(`Config Sync: migration hit an unexpected error — ${(e as Error).message}. The renamed config-sync.json.migrated-* file (if present) still holds your groups.`, 10000);
    }
  }

  onunload(): void {
    if (this.storeEventTimer !== null) window.clearTimeout(this.storeEventTimer);
    if (this.remoteAutoCheckStartupTimer !== null) window.clearTimeout(this.remoteAutoCheckStartupTimer);
  }

  private onStoreFileEvent(path: string): void {
    const root = this.settings.rootPath !== "" ? this.settings.rootPath : this.lastResolvedRoot;
    if (root === null || !(path === root || path.startsWith(root + "/"))) return;
    if (this.storeEventTimer !== null) window.clearTimeout(this.storeEventTimer);
    this.storeEventTimer = window.setTimeout(() => {
      this.storeEventTimer = null;
      void this.refreshLocalStatus();
    }, 2000);
  }

  async refreshLocalStatus(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      this.localStatuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
      await this.backfillLabels(ctx);
    } catch (e) {
      console.error("Config Sync: status refresh failed", e);
    }
    this.updateRibbonDot();
    this.notifySyncCenter();
  }

  // Fills in any missing display-name label using runtime plugin/core names, and persists the
  // manifest only if at least one label was added. Never throws into the caller.
  private async backfillLabels(ctx: CoreContext): Promise<void> {
    try {
      const groups = await readGroups(ctx);
      let changed = false;
      for (const g of groups) {
        if (g.label !== undefined) continue;
        const resolved = this.displayName(g.name, g.label);
        if (resolved !== g.name && resolved !== g.name.replace(/^plugin-/, "")) {
          g.label = resolved;
          changed = true;
        }
      }
      if (changed) await writeGroups(ctx, groups);
    } catch (e) {
      console.error("Config Sync: label backfill skipped", e);
    }
  }

  async refreshRemoteChecks(): Promise<void> {
    if (!Platform.isDesktop) return;
    let localLock: StoreLock | null = null;
    try {
      localLock = await loadLock(await this.coreContext());
    } catch {
      localLock = null;
    }
    for (const remote of this.settings.remotes) {
      try {
        const reader = await this.createReader(remote);
        this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader), at: Date.now() });
      } catch (e) {
        this.remoteChecks.set(remote.name, { check: { state: "unknown", remoteCapturedAt: null }, at: Date.now() });
        console.error(`Config Sync: remote check failed for ${remote.name}`, e);
      }
    }
    this.updateRibbonDot();
    this.notifySyncCenter();
  }

  private notifySyncCenter(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_CENTER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SyncCenterView) view.notifyExternalChange();
    }
  }

  updateRibbonDot(): void {
    const el = this.mainRibbonEl;
    if (el === null) return;
    const s = this.localStatuses ?? [];
    const { up, down } = bucketCounts(s);
    const remoteNewer = [...this.remoteChecks.entries()].filter(([, v]) => v.check.state === "remote-newer").map(([k]) => k);
    el.toggleClass("config-sync-dot-capture", up > 0);
    el.toggleClass("config-sync-dot-apply", up === 0 && (down > 0 || remoteNewer.length > 0));
    const parts: string[] = [];
    if (up > 0) parts.push(`${up} to capture`);
    if (down > 0) parts.push(`${down} to apply`);
    for (const name of remoteNewer) parts.push(`remote "${name}" newer`);
    el.setAttribute("aria-label", parts.length > 0 ? `Config Sync — ${parts.join(", ")}` : "Config Sync");
  }

  private async openSyncMenu(evt: MouseEvent): Promise<void> {
    if (this.settings.statusInMenu) await this.refreshLocalStatus(); // never throws
    const s = this.localStatuses ?? [];
    const { up, down } = bucketCounts(s);
    const menu = new Menu();
    const parts: string[] = [];
    if (this.settings.statusInMenu && up > 0) parts.push(`↑${up}`);
    if (this.settings.statusInMenu && down > 0) parts.push(`↓${down}`);
    const syncTitle = parts.length > 0 ? `Sync… (${parts.join(" ")})` : "Sync…";
    menu.addItem((i) => i.setTitle(syncTitle).setIcon("refresh-cw").onClick(() => void this.openSyncCenter()));
    menu.addItem((i) => i.setTitle("Revert last apply").setIcon("undo-2").onClick(() => void this.runRevert()));
    menu.showAtMouseEvent(evt);
  }

  private async openSyncCenter(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SYNC_CENTER_VIEW_TYPE)[0];
    if (existing !== undefined) {
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: SYNC_CENTER_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private syncCenterHost(): SyncCenterHost {
    return {
      computeStatuses: async () => {
        const ctx = await this.coreContext();
        const manifest = await loadManifest(ctx);
        const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
        const groups = groupsForDevice(manifest, device);
        this.lastGroups = groups;
        const statuses = await statusForGroups(ctx, groups);
        this.localStatuses = statuses;
        this.updateRibbonDot();
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        const availability: Record<string, Availability> = {};
        for (const g of groups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        return { groups, statuses, availability };
      },
      resolvedPath: (g) => g.path.replace("{configDir}", this.app.vault.configDir),
      displayName: (g) => this.displayName(g, this.lastGroups?.find((x) => x.name === g)?.label),
      bootstrapOffer: async () => {
        if (this.bootstrapDismissed || this.settings.groups.length > 0) return null;
        try {
          const root = await this.resolvedRootPath();
          if (await this.app.vault.adapter.exists(`${root}/config-sync.json`)) return null; // legacy file → migration path handles it
          const selfCopy = `${root}/store/configdir/plugins/config-sync/data.json`;
          if (!(await this.app.vault.adapter.exists(selfCopy))) return null;
          const raw = JSON.parse(await this.app.vault.adapter.read(selfCopy)) as { groups?: unknown };
          const itemCount = Array.isArray(raw.groups) ? raw.groups.length : 0;
          if (itemCount === 0) return null;
          let capturedAt: string | null = null;
          const lockPath = `${root}/store.lock.json`;
          if (await this.app.vault.adapter.exists(lockPath)) {
            capturedAt = parseStoreLock(await this.app.vault.adapter.read(lockPath)).capturedAt;
          }
          return { itemCount, capturedAt };
        } catch (e) {
          console.error("Config Sync: bootstrap offer check failed", e);
          return null;
        }
      },
      dismissBootstrap: () => {
        this.bootstrapDismissed = true;
      },
      adoptConfiguration: async () => {
        try {
          const ctx = await this.coreContext();
          const existing = await readGroups(ctx);
          if (!existing.some((g) => g.name === SELF_GROUP_NAME)) {
            const self = groupForItem(SELF_GROUP_NAME, "{configDir}/plugins/config-sync/data.json", "file", "Settings of config-sync.", "Config Sync");
            await writeGroups(ctx, [...existing, self]);
          }
          const results = await applyWithActions(ctx, [{ name: SELF_GROUP_NAME, action: "none" }], this.installPlugin());
          if (results.some((r) => r.group === SELF_GROUP_NAME && r.status !== "error")) {
            await this.loadSettings(); // the apply rewrote our own settings file — pick up the adopted contract
          }
          await this.refreshLocalStatus();
          return results;
        } catch (e) {
          new Notice(`Config Sync adopt failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
      captureItems: async (names: string[], onProgress?: ProgressFn) => {
        try {
          const ctx = await this.coreContext();
          const results = await capture(ctx, names, onProgress);
          await this.refreshLocalStatus();
          return results;
        } catch (e) {
          new Notice(`Config Sync capture failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
      applyItems: async (items: ApplyItem[], onProgress?: ProgressFn) => {
        try {
          const ctx = await this.coreContext();
          const results = await applyWithActions(ctx, items, this.installPlugin(), onProgress);
          if (results.some((r) => r.group === SELF_GROUP_NAME && r.status !== "error")) {
            // The apply just rewrote this plugin's own settings file on disk — reload before
            // refreshing status so the running plugin picks up the new contract immediately.
            await this.loadSettings();
          }
          await this.refreshLocalStatus();
          return results;
        } catch (e) {
          new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
      reloadApp: () => (this.app as unknown as { commands: { executeCommandById(id: string): void } }).commands.executeCommandById("app:reload"),
      remotes: () => (Platform.isDesktop ? this.settings.remotes : []),
      remoteCheck: (name) => this.remoteChecks.get(name),
      refreshRemoteChecks: () => this.refreshRemoteChecks(),
      deepDiff: async (remote) => {
        const ctx = await this.coreContext();
        return diffRemote(ctx, await this.createReader(remote));
      },
      pullFrom: async (remote) => {
        try {
          const ctx = await this.coreContext();
          const pending = await planImport(ctx, await this.createReader(remote));
          if (pending.plan.conflicts.length > 0) {
            // Conflicted pull: pause for git-style resolution. Nothing has been written
            // (planImport is read-only); Cancel keeps it that way — all-or-nothing.
            const choices = await new Promise<("local" | "remote")[] | null>((resolve) => {
              new ConflictModal(
                this.app,
                pending,
                remote.name,
                (name) => this.displayName(name),
                (picked) => resolve(picked),
                () => resolve(null)
              ).open();
            });
            if (choices === null) {
              new Notice("Pull cancelled — nothing was changed");
              return null;
            }
            const results = await applyImport(ctx, pending, choices);
            await this.refreshLocalStatus();
            await this.refreshRemoteChecks();
            return results;
          }
          const results = await applyImport(ctx, pending, []);
          await this.refreshLocalStatus();
          await this.refreshRemoteChecks();
          return results;
        } catch (e) {
          new Notice(`Config Sync pull failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
      pushTo: async (remote) => {
        try {
          const ctx = await this.coreContext();
          const results = await pushExternal(ctx, await this.createWriter(remote));
          await this.refreshRemoteChecks();
          return results;
        } catch (e) {
          new Notice(`Config Sync push failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
    };
  }

  refreshRibbons(): void {
    for (const el of this.individualRibbons) el.remove();
    this.individualRibbons = [];
    const rb = this.settings.ribbonButtons;
    const add = (icon: string, title: string, run: () => void): void => {
      this.individualRibbons.push(this.addRibbonIcon(icon, title, () => run()));
    };
    if (rb.sync) add("refresh-cw", "Config Sync: Sync", () => void this.openSyncCenter());
    if (rb.revert) add("undo-2", "Config Sync: Revert last apply", () => void this.runRevert());
  }

  private pluginRegistry(): CommunityPluginRegistry {
    return (this.app as unknown as { plugins: CommunityPluginRegistry }).plugins;
  }

  private internalPlugins(): InternalPluginsRegistry {
    return (this.app as unknown as { internalPlugins: InternalPluginsRegistry }).internalPlugins;
  }

  private coreRuntime(): { id: string; name: string; enabled: boolean }[] {
    const reg = this.internalPlugins().plugins;
    return Object.entries(reg).map(([id, p]) => ({ id, name: p.instance?.name ?? id, enabled: p.enabled }));
  }

  private pluginRuntime(): { id: string; name: string; enabled: boolean }[] {
    const reg = this.pluginRegistry();
    return Object.values(reg.manifests).map((m) => ({ id: m.id, name: m.name, enabled: reg.enabledPlugins.has(m.id) }));
  }

  private pkmProbe(): PkmProbe {
    const registry = this.pluginRegistry();
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
    };
  }

  passphrase(): string | null {
    const v: unknown = this.app.loadLocalStorage("config-sync-passphrase");
    return typeof v === "string" && v !== "" ? v : null;
  }

  setPassphrase(v: string | null): void {
    this.app.saveLocalStorage("config-sync-passphrase", v === "" ? null : v);
  }

  private pluginHost(): PluginHost {
    const registry = this.pluginRegistry();
    return {
      getInstalledPluginVersion: (id) => registry.manifests[id]?.version ?? null,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
      disablePlugin: (id) => registry.disablePlugin(id),
      enablePlugin: (id) => registry.enablePlugin(id),
      enablePluginPersistent: (id) => registry.enablePluginAndSave(id),
      getInstalledPluginName: (id) => registry.manifests[id]?.name ?? null,
      getCorePluginName: (id) => this.internalPlugins().plugins[id]?.instance?.name ?? null,
      getAppVersion: () => apiVersion,
      isCorePluginEnabled: (id) => this.internalPlugins().plugins[id]?.enabled === true,
      enableCorePlugin: async (id) => {
        const p = this.internalPlugins().plugins[id];
        if (p === undefined) throw new Error(`core plugin "${id}" does not exist in this Obsidian build`);
        await p.enable();
      },
      reloadPluginManifests: () => this.pluginRegistry().loadManifests(),
    };
  }

  installPlugin(): PluginInstallFn {
    if (this.installFn === null) {
      this.installFn = createInstaller(this.app.vault.adapter, this.app.vault.configDir, async (url) => {
        const res = await requestUrl({ url, throw: true });
        return res.arrayBuffer;
      });
    }
    return this.installFn;
  }

  displayName(group: string, storedLabel?: string): string {
    return displayLabelForGroup(group, this.pluginHost(), storedLabel);
  }

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: this.pluginHost(),
      passphrase: this.passphrase(),
      groupsIO: {
        read: async () => this.settings.groups,
        write: async (groups) => {
          // Swap-only-on-success, matching the commitDraft rollback pattern: a failed disk
          // write must not leave unpersisted groups visible in memory.
          const prev = this.settings.groups;
          this.settings.groups = groups;
          try {
            await this.saveSettings();
          } catch (e) {
            this.settings.groups = prev;
            throw e;
          }
        },
      },
      now: () => new Date().toISOString(),
    };
  }

  private async runRevert(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const result = await revertLastApply(ctx);
      new ReportModal(this.app, "Reverted", [result], undefined, (g) => this.displayName(g, this.lastGroups?.find((x) => x.name === g)?.label)).open();
    } catch (e) {
      new Notice(`Config Sync revert failed: ${(e as Error).message}`, 10000);
    }
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async createReader(remote: Remote): Promise<ExternalStoreReader> {
    if (remote.type === "vault") {
      const { createLocalPathReader } = await import("./external/localPath");
      return createLocalPathReader(remote.storePath);
    }
    const { createGitReader } = await import("./external/gitSource");
    const adapter = this.app.vault.adapter as unknown as { getBasePath(): string };
    return createGitReader(adapter.getBasePath(), remote.url, remote.branch, remote.subdir ?? "");
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async createWriter(remote: Remote): Promise<ExternalStoreWriter> {
    if (remote.type === "vault") {
      const { createLocalPathWriter } = await import("./external/localPath");
      return createLocalPathWriter(remote.storePath);
    }
    const { createGitWriter } = await import("./external/gitSource");
    return createGitWriter(remote.url, remote.branch, remote.subdir ?? "");
  }

  async readGroupsFile(): Promise<SyncGroup[]> {
    return readGroups(await this.coreContext());
  }

  async writeGroupsFile(groups: SyncGroup[]): Promise<void> {
    await writeGroups(await this.coreContext(), groups);
  }

  async resolvedRootPath(): Promise<string> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    this.lastResolvedRoot = rootPath;
    return rootPath;
  }

  async listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listOptionSections(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  async listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listCoreSections(this.app.vault.adapter, this.app.vault.configDir, this.coreRuntime(), groups);
  }

  async listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listPluginSections(this.app.vault.adapter, this.app.vault.configDir, this.pluginRuntime(), groups);
  }

  installedPluginIds(): string[] {
    return Object.values(this.pluginRegistry().manifests).map((m) => m.id);
  }

  async listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]> {
    return listDiscovered(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  async readItemFile(group: SyncGroup): Promise<string | null> {
    const io = this.app.vault.adapter;
    const real = groupRealPath(group.path, this.app.vault.configDir);
    if (group.type !== "file" || !(await io.exists(real))) return null;
    try {
      return await io.read(real);
    } catch {
      return null;
    }
  }

  async detectSensitive(group: SyncGroup): Promise<SensitiveScan> {
    const io = this.app.vault.adapter;
    const real = groupRealPath(group.path, this.app.vault.configDir);
    const dirExists = group.type === "dir" && (await io.exists(real));
    const files = group.type === "file" ? [real] : dirExists ? await listFilesRecursive(io, real) : [];
    const keys = new Set<string>();
    let blob = false;
    for (const f of files) {
      if (!(await io.exists(f))) continue;
      let content: string;
      try {
        content = await io.read(f);
      } catch {
        continue;
      }
      const scan = scanSensitive(content);
      for (const k of scan.keys) keys.add(k);
      if (scan.blob) blob = true;
    }
    return { keys: [...keys], blob };
  }

  detectedMode(): "ioto" | "default" {
    return resolveEffectiveMode("auto", this.pkmProbe());
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ConfigSyncSettings> | null);
    try {
      this.settings.groups = validateSyncManifest({ version: 1, groups: this.settings.groups }).groups;
    } catch (e) {
      console.error("Config Sync: invalid groups in settings", e);
      new Notice(`Config Sync: saved sync configuration is invalid (${(e as Error).message}) — fix it in Settings → Config Sync`, 10000);
      this.settings.groups = [];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
