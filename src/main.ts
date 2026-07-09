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
  loadManifest,
  pushExternal,
  readGroups,
  revertLastApply,
  writeGroups,
} from "./core/ConfigSyncCore";
import { type CatalogSection, listCoreSections, listDiscovered, listOptionSections, listPluginSections } from "./core/catalog";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { ExternalSource, RibbonButtons, SyncGroup } from "./core/types";
import { GroupSelectModal } from "./ui/GroupSelectModal";
import { confirmWarnings } from "./ui/ConfirmModal";
import { ReportModal } from "./ui/ReportModal";
import { SourceSelectModal } from "./ui/SourceSelectModal";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  externalSources: ExternalSource[];
  ribbonButtons: RibbonButtons;
}

const DEFAULT_SETTINGS: ConfigSyncSettings = {
  pkmMode: "auto",
  rootPath: "",
  externalSources: [],
  ribbonButtons: { capture: false, apply: false, revert: false, pull: false, push: false },
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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => this.openSyncMenu(evt));
    this.refreshRibbons();
    this.addCommand({ id: "capture", name: "Capture (this device's config → store)", callback: () => void this.runCapture() });
    this.addCommand({ id: "apply", name: "Apply (store → this device)", callback: () => void this.runApply() });
    this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });
    this.addCommand({
      id: "pull",
      name: "Pull (remote → store)",
      checkCallback: (checking) => {
        if (!this.transportAvailable()) return false;
        if (!checking) void this.runPull();
        return true;
      },
    });
    this.addCommand({
      id: "push",
      name: "Push (store → remote)",
      checkCallback: (checking) => {
        if (!this.transportAvailable()) return false;
        if (!checking) void this.runPush();
        return true;
      },
    });
  }

  transportAvailable(): boolean {
    return Platform.isDesktop && this.settings.externalSources.length > 0;
  }

  private openSyncMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Capture (config → store)").setIcon("upload").onClick(() => void this.runCapture()));
    menu.addItem((i) => i.setTitle("Apply (store → this device)").setIcon("folder-sync").onClick(() => void this.runApply()));
    menu.addItem((i) => i.setTitle("Revert last apply").setIcon("undo-2").onClick(() => void this.runRevert()));
    if (this.transportAvailable()) {
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Pull (remote → store)").setIcon("folder-input").onClick(() => void this.runPull()));
      menu.addItem((i) => i.setTitle("Push (store → remote)").setIcon("upload-cloud").onClick(() => void this.runPush()));
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
      new GroupSelectModal(this.app, groups, "Config Sync: select groups to apply", (names) => {
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

  private async runPull(): Promise<void> {
    const sources = this.settings.externalSources;
    if (sources.length === 0) {
      new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
      return;
    }
    new SourceSelectModal(this.app, sources, (source) => {
      void this.pullFrom(source);
    }).open();
  }

  private async pullFrom(source: ExternalSource): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const reader = await this.createReader(source);
      const result = await importExternal(ctx, reader);
      new ReportModal(this.app, `Config Sync: Pull report (${source.name})`, [result]).open();
    } catch (e) {
      new Notice(`Config Sync pull failed: ${(e as Error).message}`, 10000);
    }
  }

  private async runPush(): Promise<void> {
    const sources = this.settings.externalSources;
    if (sources.length === 0) {
      new Notice("Config Sync: no remotes configured (Settings → Config Sync → Remotes)");
      return;
    }
    new SourceSelectModal(this.app, sources, (source) => {
      void this.pushTo(source);
    }).open();
  }

  private async pushTo(source: ExternalSource): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const writer = await this.createWriter(source);
      const result = await pushExternal(ctx, writer);
      new ReportModal(this.app, `Config Sync: Push report (${source.name})`, [result]).open();
    } catch (e) {
      new Notice(`Config Sync push failed: ${(e as Error).message}`, 10000);
    }
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async createReader(source: ExternalSource): Promise<ExternalStoreReader> {
    if (source.type === "local-path") {
      const { createLocalPathReader } = await import("./external/localPath");
      return createLocalPathReader(source.path, source.root);
    }
    const { createGitReader } = await import("./external/gitSource");
    const adapter = this.app.vault.adapter as unknown as { getBasePath(): string };
    return createGitReader(adapter.getBasePath(), source.remote, source.branch, source.root);
  }

  private async createWriter(source: ExternalSource): Promise<ExternalStoreWriter> {
    if (source.type === "local-path") {
      const { createLocalPathWriter } = await import("./external/localPath");
      return createLocalPathWriter(source.path, source.root);
    }
    const { createGitWriter } = await import("./external/gitSource");
    return createGitWriter(source.remote, source.branch, source.root);
  }

  async readGroupsFile(): Promise<SyncGroup[]> {
    return readGroups(await this.coreContext());
  }

  async writeGroupsFile(groups: SyncGroup[]): Promise<void> {
    await writeGroups(await this.coreContext(), groups);
  }

  async resolvedRootPath(): Promise<string> {
    return resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
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
