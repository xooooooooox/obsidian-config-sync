import { Notice, Platform, Plugin } from "obsidian";
import {
  CoreContext,
  ExternalStoreReader,
  PluginHost,
  apply,
  checkApply,
  createStarterManifest as coreCreateStarterManifest,
  groupsForDevice,
  importExternal,
  loadManifest,
  publish,
  readGroups,
  revertLastApply,
  writeGroups,
} from "./core/ConfigSyncCore";
import { listOptionSections, type CatalogItem } from "./core/catalog";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { ExternalSource, SyncGroup } from "./core/types";
import { GroupSelectModal } from "./ui/GroupSelectModal";
import { confirmWarnings } from "./ui/ConfirmModal";
import { ReportModal } from "./ui/ReportModal";
import { SourceSelectModal } from "./ui/SourceSelectModal";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

interface ConfigSyncSettings {
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  externalSources: ExternalSource[];
}

const DEFAULT_SETTINGS: ConfigSyncSettings = { pkmMode: "auto", rootPath: "", externalSources: [] };

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string }>;
  enabledPlugins: Set<string>;
  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
}

export default class ConfigSyncPlugin extends Plugin {
  settings: ConfigSyncSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.addRibbonIcon("upload", "Config Sync: Publish", () => {
      void this.runPublish();
    });
    this.addRibbonIcon("folder-sync", "Config Sync: Apply", () => {
      void this.runApply();
    });
    this.addRibbonIcon("undo-2", "Config Sync: Revert last apply", () => {
      void this.runRevert();
    });
    if (Platform.isDesktop) {
      this.addRibbonIcon("folder-input", "Config Sync: Import from external source", () => {
        void this.runImport();
      });
    }
    this.addCommand({ id: "publish", name: "Publish (vault config → store)", callback: () => void this.runPublish() });
    this.addCommand({ id: "apply", name: "Apply (store → this device)", callback: () => void this.runApply() });
    this.addCommand({ id: "revert-last-apply", name: "Revert last apply", callback: () => void this.runRevert() });
    this.addCommand({
      id: "import-from-external",
      name: "Import from external source",
      checkCallback: (checking) => {
        if (!Platform.isDesktop) return false;
        if (!checking) void this.runImport();
        return true;
      },
    });
  }

  private pluginRegistry(): CommunityPluginRegistry {
    return (this.app as unknown as { plugins: CommunityPluginRegistry }).plugins;
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

  private async runPublish(): Promise<void> {
    try {
      const ctx = await this.coreContext();
      if ((await coreCreateStarterManifest(ctx)) === "created") {
        new Notice(`Config Sync: created starter groups file at ${ctx.rootPath}/config-sync.json — review it in settings`);
      }
      const results = await publish(ctx);
      new ReportModal(this.app, "Config Sync: Publish report", results).open();
    } catch (e) {
      new Notice(`Config Sync publish failed: ${(e as Error).message}`, 10000);
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

  private async runImport(): Promise<void> {
    const sources = this.settings.externalSources;
    if (sources.length === 0) {
      new Notice("Config Sync: no external sources configured (Settings → Config Sync)");
      return;
    }
    new SourceSelectModal(this.app, sources, (source) => {
      void this.importFrom(source);
    }).open();
  }

  private async importFrom(source: ExternalSource): Promise<void> {
    try {
      const ctx = await this.coreContext();
      const reader = await this.createReader(source);
      const result = await importExternal(ctx, reader);
      new ReportModal(this.app, `Config Sync: Import report (${source.name})`, [result]).open();
    } catch (e) {
      new Notice(`Config Sync import failed: ${(e as Error).message}`, 10000);
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

  async readGroupsFile(): Promise<SyncGroup[]> {
    return readGroups(await this.coreContext());
  }

  async writeGroupsFile(groups: SyncGroup[]): Promise<void> {
    await writeGroups(await this.coreContext(), groups);
  }

  async resolvedRootPath(): Promise<string> {
    return resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
  }

  async listOptionItems(groups: SyncGroup[]): Promise<CatalogItem[]> {
    const sections = await listOptionSections(this.app.vault.adapter, this.app.vault.configDir, groups);
    return sections.flatMap((s) => s.items);
  }

  listPluginItems(): unknown[] {
    return []; // superseded in Task 5; temporary to keep the build green
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
