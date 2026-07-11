import { Menu, Notice, Platform, Plugin } from "obsidian";
import {
  CoreContext,
  ExternalStoreReader,
  ExternalStoreWriter,
  PluginHost,
  apply,
  capture,
  checkApply,
  createStarterManifest as coreCreateStarterManifest,
  groupsForDevice,
  importExternal,
  loadLock,
  loadManifest,
  pushExternal,
  readGroups,
  revertLastApply,
  writeGroups,
} from "./core/ConfigSyncCore";
import { type CatalogSection, listCoreSections, listDiscovered, listOptionSections, listPluginSections } from "./core/catalog";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { checkRemote, GroupStatus, RemoteCheck, statusForGroups } from "./core/status";
import { Remote, RibbonButtons, StoreLock, SyncGroup } from "./core/types";
import { GroupSelectModal } from "./ui/GroupSelectModal";
import { confirmWarnings } from "./ui/ConfirmModal";
import { ReportModal } from "./ui/ReportModal";
import { SourceSelectModal } from "./ui/SourceSelectModal";
import { remoteCheckText, StatusModal } from "./ui/StatusModal";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  remotes: Remote[];
  ribbonButtons: RibbonButtons;
  statusInMenu: boolean;
  remoteAutoCheck: boolean;
  localPeriodicCheck: boolean;
}

const DEFAULT_SETTINGS: ConfigSyncSettings = {
  pkmMode: "auto",
  rootPath: "",
  remotes: [],
  ribbonButtons: { capture: false, apply: false, revert: false, pull: false, push: false },
  statusInMenu: true,
  remoteAutoCheck: true,
  localPeriodicCheck: true,
};

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string }>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
}

// app.internalPlugins is not part of the public API; this is the community-standard access path for core plugins.
interface InternalPluginsRegistry {
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string } }>;
}

export default class ConfigSyncPlugin extends Plugin {
  settings: ConfigSyncSettings = DEFAULT_SETTINGS;
  private individualRibbons: HTMLElement[] = [];
  private mainRibbonEl: HTMLElement | null = null;
  private lastResolvedRoot: string | null = null;
  localStatuses: GroupStatus[] | null = null;
  remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
  private storeEventTimer: number | null = null;
  private remoteAutoCheckStartupTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.mainRibbonEl = this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => void this.openSyncMenu(evt));
    this.refreshRibbons();
    this.addCommand({ id: "capture", name: "Capture: save this device's settings", callback: () => void this.runCapture() });
    this.addCommand({ id: "apply", name: "Apply: update this device with synced settings", callback: () => void this.runApply() });
    this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });
    this.addCommand({ id: "status", name: "Status: check what's in sync", callback: () => void this.runStatus() });
    this.addCommand({
      id: "pull",
      name: "Pull: get settings from a remote",
      checkCallback: (checking) => {
        if (!this.transportAvailable()) return false;
        if (!checking) void this.runPull();
        return true;
      },
    });
    this.addCommand({
      id: "push",
      name: "Push: send settings to a remote",
      checkCallback: (checking) => {
        if (!this.transportAvailable()) return false;
        if (!checking) void this.runPush();
        return true;
      },
    });

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
    this.app.workspace.onLayoutReady(() => void this.refreshLocalStatus());
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
    } catch (e) {
      console.error("Config Sync: status refresh failed", e);
    }
    this.updateRibbonDot();
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
  }

  updateRibbonDot(): void {
    const el = this.mainRibbonEl;
    if (el === null) return;
    const s = this.localStatuses ?? [];
    const changedHere = s.filter((x) => x.state === "local-changed" || x.state === "differs").length;
    const storeNewer = s.filter((x) => x.state === "store-newer").length;
    const remoteNewer = [...this.remoteChecks.entries()].filter(([, v]) => v.check.state === "remote-newer").map(([k]) => k);
    el.toggleClass("config-sync-dot-capture", changedHere > 0);
    el.toggleClass("config-sync-dot-apply", changedHere === 0 && (storeNewer > 0 || remoteNewer.length > 0));
    const parts: string[] = [];
    if (changedHere > 0) parts.push(`${changedHere} changed here`);
    if (storeNewer > 0) parts.push(`${storeNewer} store-newer`);
    for (const name of remoteNewer) parts.push(`remote "${name}" newer`);
    el.setAttribute("aria-label", parts.length > 0 ? `Config Sync — ${parts.join(", ")}` : "Config Sync");
  }

  transportAvailable(): boolean {
    return Platform.isDesktop && this.settings.remotes.length > 0;
  }

  private async openSyncMenu(evt: MouseEvent): Promise<void> {
    let captureTitle = "Capture: save this device's settings";
    let applyTitle = "Apply: update this device with synced settings";
    if (this.settings.statusInMenu) {
      try {
        const ctx = await this.coreContext();
        const manifest = await loadManifest(ctx);
        const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
        const statuses = await statusForGroups(ctx, groupsForDevice(manifest, device));
        const changedHere = statuses.filter((s) => s.state === "local-changed" || s.state === "differs").length;
        const storeNewer = statuses.filter((s) => s.state === "store-newer").length;
        if (changedHere > 0) captureTitle = `Capture (${changedHere} changed here)`;
        if (storeNewer > 0) applyTitle = `Apply (${storeNewer} store-newer)`;
      } catch (e) {
        console.error("Config Sync: menu status check failed", e); // the menu must still open
      }
    }
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(captureTitle).setIcon("upload").onClick(() => void this.runCapture()));
    menu.addItem((i) => i.setTitle(applyTitle).setIcon("folder-sync").onClick(() => void this.runApply()));
    menu.addItem((i) => i.setTitle("Revert last apply").setIcon("undo-2").onClick(() => void this.runRevert()));
    menu.addItem((i) => i.setTitle("Status…").setIcon("activity").onClick(() => void this.runStatus()));
    if (this.transportAvailable()) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Pull: get settings from a remote").setIcon("folder-input").onClick(() => void this.runPull()));
      menu.addItem((i) => i.setTitle("Push: send settings to a remote").setIcon("upload-cloud").onClick(() => void this.runPush()));
    }
    menu.showAtMouseEvent(evt);
  }

  refreshRibbons(): void {
    for (const el of this.individualRibbons) el.remove();
    this.individualRibbons = [];
    const rb = this.settings.ribbonButtons;
    const add = (icon: string, title: string, run: () => void): void => {
      this.individualRibbons.push(this.addRibbonIcon(icon, title, () => run()));
    };
    if (rb.capture) add("upload", "Config Sync: Capture", () => void this.runCapture());
    if (rb.apply) add("folder-sync", "Config Sync: Apply", () => void this.runApply());
    if (rb.revert) add("undo-2", "Config Sync: Revert last apply", () => void this.runRevert());
    if (rb.pull && this.transportAvailable()) add("folder-input", "Config Sync: Pull", () => void this.runPull());
    if (rb.push && this.transportAvailable()) add("upload-cloud", "Config Sync: Push", () => void this.runPush());
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

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    const registry = this.pluginRegistry();
    const host: PluginHost = {
      getInstalledPluginVersion: (id) => registry.manifests[id]?.version ?? null,
      isPluginEnabled: (id) => registry.enabledPlugins.has(id),
      disablePlugin: (id) => registry.disablePlugin(id),
      enablePlugin: (id) => registry.enablePlugin(id),
    };
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: host,
      now: () => new Date().toISOString(),
    };
  }

  private async runCapture(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      if ((await coreCreateStarterManifest(ctx)) === "created") {
        new Notice(`Config Sync: created starter groups file at ${ctx.rootPath}/config-sync.json — review it in settings`);
      }
      const results = await capture(ctx);
      new ReportModal(this.app, "Config Sync: Capture report", results).open();
      void this.refreshLocalStatus();
    } catch (e) {
      new Notice(`Config Sync capture failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runApply(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      if ((await coreCreateStarterManifest(ctx)) === "created") {
        new Notice(`Config Sync: created starter groups file at ${ctx.rootPath}/config-sync.json — review it in settings`);
      }
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      const groups = groupsForDevice(manifest, device);
      if (groups.length === 0) {
        new Notice("Config Sync: no groups available for this device");
        return;
      }
      const statuses = await statusForGroups(ctx, groups);
      const statusByName = new Map(statuses.map((s) => [s.group, s]));
      const deviceWords: Record<SyncGroup["devices"], string> = { all: "all devices", desktop: "desktop only", mobile: "mobile only" };
      const items = groups.map((group) => ({
        group,
        resolvedPath: group.path.replace("{configDir}", this.app.vault.configDir),
        meta: group.description ?? `${group.type === "dir" ? "folder" : "file"} · ${deviceWords[group.devices]}`,
        status: statusByName.get(group.name) ?? null,
      }));
      new GroupSelectModal(this.app, items, "Config Sync: select groups to apply", (names) => {
        void this.applyGroups(ctx, names);
      }).open();
    } catch (e) {
      new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
    }
  }

  private async applyGroups(ctx: CoreContext, names: string[]): Promise<void> {
    if (names.length === 0) return;
    try {
      const warnings = await checkApply(ctx, names);
      if (warnings.length > 0) {
        const ok = await confirmWarnings(
          this.app,
          "Config Sync: version warnings",
          warnings.map((w) => `${w.group}: ${w.message}`)
        );
        if (!ok) return;
      }
      const results = await apply(ctx, names);
      new ReportModal(this.app, "Config Sync: Apply report", results).open();
      void this.refreshLocalStatus();
    } catch (e) {
      new Notice(`Config Sync apply failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runRevert(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const result = await revertLastApply(ctx);
      new ReportModal(this.app, "Config Sync: Revert report", [result]).open();
    } catch (e) {
      new Notice(`Config Sync revert failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runStatus(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const manifest = await loadManifest(ctx);
      const device = Platform.isMobile ? ("mobile" as const) : ("desktop" as const);
      const groups = groupsForDevice(manifest, device);
      const statuses = await statusForGroups(ctx, groups);
      const byName = new Map(groups.map((g) => [g.name, g]));
      const entries = statuses.map((s) => ({
        status: s,
        resolvedPath: (byName.get(s.group)?.path ?? "").replace("{configDir}", this.app.vault.configDir),
      }));
      let localLock: StoreLock | null = null;
      try {
        localLock = await loadLock(ctx);
      } catch {
        localLock = null;
      }
      const remotes = Platform.isDesktop ? this.settings.remotes : [];
      new StatusModal(this.app, entries, remotes, async (remote) => {
        const reader = await this.createReader(remote);
        return remoteCheckText(await checkRemote(localLock, reader));
      }).open();
    } catch (e) {
      new Notice(`Config Sync status failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runPull(): Promise<void> {
    const remotes = this.settings.remotes;
    if (remotes.length === 0) {
      new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
      return;
    }
    const only = remotes[0];
    if (remotes.length === 1 && only !== undefined) {
      void this.pullFrom(only);
      return;
    }
    new SourceSelectModal(this.app, remotes, (remote) => {
      void this.pullFrom(remote);
    }).open();
  }

  private async pullFrom(remote: Remote): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const reader = await this.createReader(remote);
      const results = await importExternal(ctx, reader);
      new ReportModal(this.app, `Pulled from ${remote.name}`, results).open();
      void this.refreshLocalStatus();
    } catch (e) {
      new Notice(`Config Sync pull failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runPush(): Promise<void> {
    const remotes = this.settings.remotes;
    if (remotes.length === 0) {
      new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
      return;
    }
    const only = remotes[0];
    if (remotes.length === 1 && only !== undefined) {
      void this.pushTo(only);
      return;
    }
    new SourceSelectModal(this.app, remotes, (remote) => {
      void this.pushTo(remote);
    }).open();
  }

  private async pushTo(remote: Remote): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const writer = await this.createWriter(remote);
      const results = await pushExternal(ctx, writer);
      new ReportModal(this.app, `Pushed to ${remote.name}`, results).open();
      void this.refreshLocalStatus();
    } catch (e) {
      new Notice(`Config Sync push failed: ${(e as Error).message}`, 10000);
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

  detectedMode(): "ioto" | "default" {
    return resolveEffectiveMode("auto", this.pkmProbe());
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<ConfigSyncSettings> | null);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
