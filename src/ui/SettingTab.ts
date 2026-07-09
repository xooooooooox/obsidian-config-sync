import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";
import { CatalogItem, findGroupByPath, groupForItem, joinLocation, splitLocation } from "../core/catalog";
import { confirmWarnings } from "./ConfirmModal";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionItems(groups: SyncGroup[]): Promise<CatalogItem[]>;
  listPluginItems(): unknown[];
}

interface SourceDraft {
  name: string;
  type: "local-path" | "git";
  path: string;
  remote: string;
  branch: string;
  root: string;
}

function toDraft(s: ExternalSource): SourceDraft {
  return {
    name: s.name,
    type: s.type,
    path: s.type === "local-path" ? s.path : "",
    remote: s.type === "git" ? s.remote : "",
    branch: s.type === "git" ? s.branch : "",
    root: s.root,
  };
}

function toCandidate(d: SourceDraft): unknown {
  return d.type === "local-path"
    ? { name: d.name, type: d.type, path: d.path, root: d.root }
    : { name: d.name, type: d.type, remote: d.remote, branch: d.branch, root: d.root };
}

type PanelTab = "general" | "obsidian" | "plugins" | "advanced" | "sources";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "obsidian", label: "Obsidian" },
  { id: "plugins", label: "Community plugins" },
  { id: "advanced", label: "Advanced" },
  { id: "sources", label: "External sources" },
];

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false; // Obsidian entry: reload drafts from file/settings
    this.activeTab = "general";
    this.rerender(0);
  }

  // Structural re-render that keeps drafts and restores the current scroll position.
  private refresh(): void {
    this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): void {
    const gen = ++this.renderGen;
    const { containerEl } = this;
    containerEl.empty();
    void this.render(containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.rerender(0); // a freshly opened tab starts at the top
  }

  private async render(containerEl: HTMLElement, gen: number, scrollTop: number): Promise<void> {
    if (gen !== this.renderGen) return;
    if (!this.loaded) {
      try {
        this.groups = await this.host.readGroupsFile();
        this.groupsReadError = null;
      } catch (e) {
        this.groups = [];
        this.groupsReadError = (e as Error).message;
      }
      if (gen !== this.renderGen) return;
      this.sources = this.host.settings.externalSources.map(toDraft);
      this.loaded = true;
    }
    this.renderTabNav(containerEl);
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        break;
      case "obsidian":
        if (!this.renderGroupsReadError(containerEl)) {
          await this.renderOptions(containerEl, gen);
          if (gen !== this.renderGen) return;
          this.renderGroupsError(containerEl);
        }
        break;
      case "plugins":
        if (!this.renderGroupsReadError(containerEl)) {
          this.renderPlugins(containerEl);
          this.renderGroupsError(containerEl);
        }
        break;
      case "advanced":
        if (!this.renderGroupsReadError(containerEl)) {
          this.renderAdvanced(containerEl);
          this.renderGroupsError(containerEl);
        }
        break;
      case "sources":
        this.renderSources(containerEl);
        break;
    }
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
    for (const tab of TABS) {
      const el = nav.createEl("button", { text: tab.label, cls: "config-sync-tab" });
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => {
        this.switchTab(tab.id);
      });
    }
  }

  private renderGroupsReadError(containerEl: HTMLElement): boolean {
    if (this.groupsReadError === null) return false;
    containerEl.createEl("p", {
      text: `Cannot read the sync configuration — fix <data folder>/config-sync.json manually and reopen this tab: ${this.groupsReadError}`,
      cls: "mod-warning",
    });
    return true;
  }

  private renderGroupsError(containerEl: HTMLElement): void {
    this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.groupsErrorEl.setText(this.groupsErrorMsg);
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    new Setting(containerEl)
      .setName("PKM mode")
      .setDesc("Adjusts the recommended storage location to match how your vault is organized. Auto detects IOTO vaults.")
      .addDropdown((d) =>
        d
          .addOption("auto", `Auto (detected: ${detected === "ioto" ? "IOTO" : "default"})`)
          .addOption("ioto", "IOTO")
          .addOption("default", "Default")
          .setValue(this.host.settings.pkmMode)
          .onChange(async (v) => {
            this.host.settings.pkmMode = v as PkmMode;
            await this.host.saveSettings();
            this.loaded = false; // effective root may change — reload drafts
            this.refresh();
          })
      );
  }

  private async renderDataFolder(containerEl: HTMLElement, gen: number): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
    if (gen !== this.renderGen) return;
    new Setting(containerEl)
      .setName("Data folder")
      .setDesc(
        `Where synced settings are stored inside your vault, so your note-sync app (e.g. remotely-save) carries them to your other devices. Leave empty to use the recommended location (currently: ${resolved}).`
      )
      .addText((t) => {
        t.setPlaceholder(resolved);
        t.setValue(this.host.settings.rootPath);
        t.onChange(async (v) => {
          const trimmed = v.trim();
          if (trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
            new Notice(`Config Sync: invalid data folder "${trimmed}" — must be a vault-relative path`);
            return;
          }
          this.host.settings.rootPath = trimmed;
          await this.host.saveSettings();
        });
        t.inputEl.addEventListener("blur", () => {
          this.loaded = false;
          this.refresh();
        });
      });
  }

  private async renderOptions(containerEl: HTMLElement, gen: number): Promise<void> {
    new Setting(containerEl)
      .setName("Obsidian")
      .setHeading()
      .setDesc("Choose which Obsidian settings follow you across devices.");
    const items = await this.host.listOptionItems(this.groups);
    if (gen !== this.renderGen) return;
    const listEl = containerEl.createDiv();
    for (const item of items) {
      this.renderChecklistRow(listEl, item, item.description !== null ? item.label : null);
    }
  }

  private renderPlugins(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Community plugins")
      .setHeading()
      .setDesc("Sync a plugin's settings to your other devices. The plugin itself still installs from the community store or BRAT.");
    const listEl = containerEl.createDiv();
    for (const p of this.host.listPluginItems() as { id: string; name: string; dataPath: string; disabledReason: string | null }[]) {
      this.renderChecklistRow(
        listEl,
        {
          name: p.dataPath,
          label: p.name,
          description: `Settings of ${p.id}.`,
          path: p.dataPath,
          type: "file",
          exists: true,
          disabledReason: p.disabledReason,
          cautionReason: null,
        },
        `${p.name} plugin settings`
      );
    }
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem, groupDescription: string | null): void {
    const group = findGroupByPath(this.groups, item.path);
    const row = new Setting(listEl).setName(item.label);
    const descParts: string[] = [];
    if (item.description !== null) descParts.push(item.description);
    if (item.disabledReason !== null) descParts.push(item.disabledReason);
    if (item.cautionReason !== null) descParts.push(item.cautionReason);
    if (!item.exists && item.disabledReason === null) descParts.push("(not present in this vault yet)");
    row.setDesc(descParts.join(" "));
    if (group !== undefined && item.disabledReason === null) {
      row.addDropdown((d) =>
        d
          .addOption("all", "all devices")
          .addOption("desktop", "desktop only")
          .addOption("mobile", "mobile only")
          .setValue(group.devices)
          .onChange(async (v) => {
            group.devices = v as DeviceClass;
            await this.saveGroups();
            this.refresh(); // keep every view of this group consistent
          })
      );
    }
    row.addToggle((t) => {
      t.setValue(group !== undefined);
      t.setDisabled(item.disabledReason !== null);
      t.onChange(async (v) => {
        if (v) {
          if (item.cautionReason !== null) {
            const ok = await confirmWarnings(this.app, "Sync a device-specific file?", [item.cautionReason]);
            if (!ok) {
              this.refresh(); // groups unchanged — the re-render restores the toggle
              return;
            }
          }
          this.groups.push(groupForItem(item.name, item.path, item.type, groupDescription));
        } else {
          const idx = this.groups.findIndex((g) => g.path === item.path);
          if (idx >= 0) this.groups.splice(idx, 1);
        }
        await this.saveGroups();
        this.refresh();
      });
    });
  }

  private renderAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Advanced")
      .setHeading()
      .setDesc("Custom sync rules for anything not listed elsewhere — files at the vault root, extra folders, or per-key credential protection (sanitize).");
    const listEl = containerEl.createDiv();
    this.groups.forEach((group, index) => {
      this.renderGroupRow(listEl, group, index);
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.refresh();
      })
    );
  }

  private renderGroupRow(listEl: HTMLElement, group: SyncGroup, index: number): void {
    const row = new Setting(listEl);
    row.addText((t) =>
      t.setPlaceholder("name").setValue(group.name).onChange((v) => {
        group.name = v.trim();
        void this.saveGroups();
      })
    );
    row.addText((t) =>
      t.setPlaceholder("description (optional)").setValue(group.description ?? "").onChange((v) => {
        const trimmed = v.trim();
        if (trimmed !== "") group.description = trimmed;
        else delete group.description;
        void this.saveGroups();
      })
    );
    const loc = splitLocation(group.path);
    row.addDropdown((d) =>
      d
        .addOption("config", "Config folder")
        .addOption("vault", "Vault root")
        .setValue(loc.location)
        .onChange((v) => {
          group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
          void this.saveGroups();
        })
    );
    row.addText((t) =>
      t.setPlaceholder("relative path, e.g. plugins/x/data.json").setValue(loc.rel).onChange((v) => {
        group.path = joinLocation(splitLocation(group.path).location, v.trim());
        void this.saveGroups();
      })
    );
    row.addDropdown((d) =>
      d
        .addOption("file", "file")
        .addOption("dir", "dir")
        .setValue(group.type)
        .onChange(async (v) => {
          group.type = v as SyncGroup["type"];
          if (group.type !== "file") delete group.sanitize;
          await this.saveGroups();
          this.refresh();
        })
    );
    row.addDropdown((d) =>
      d
        .addOption("all", "all")
        .addOption("desktop", "desktop")
        .addOption("mobile", "mobile")
        .setValue(group.devices)
        .onChange(async (v) => {
          group.devices = v as DeviceClass;
          await this.saveGroups();
          this.refresh(); // keep picker rows for the same group consistent
        })
    );
    row.addText((t) => {
      t.setPlaceholder("sanitize globs, comma-separated");
      t.setValue(group.sanitize?.join(", ") ?? "");
      t.setDisabled(group.type !== "file");
      t.onChange((v) => {
        const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
        if (patterns.length > 0) group.sanitize = patterns;
        else delete group.sanitize;
        void this.saveGroups();
      });
    });
    row.addExtraButton((b) =>
      b.setIcon("trash").setTooltip("Delete rule").onClick(async () => {
        this.groups.splice(index, 1);
        await this.saveGroups();
        this.refresh();
      })
    );
  }

  private async saveGroups(): Promise<void> {
    try {
      await this.host.writeGroupsFile(this.groups);
      this.groupsErrorMsg = "";
    } catch (e) {
      this.groupsErrorMsg = `Not saved: ${(e as Error).message}`;
    }
    this.groupsErrorEl?.setText(this.groupsErrorMsg);
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("External sources")
      .setHeading()
      .setDesc("Pull the synced settings of another vault into this one (e.g. from your main vault into a published copy).");
    const listEl = containerEl.createDiv();
    this.sources.forEach((source, index) => {
      this.renderSourceRow(listEl, source, index);
    });
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.sourcesErrorEl.setText(this.sourcesErrorMsg);
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add source").onClick(() => {
        this.sources.push({ name: "", type: "local-path", path: "", remote: "", branch: "", root: "" });
        this.refresh();
      })
    );
  }

  private renderSourceRow(listEl: HTMLElement, source: SourceDraft, index: number): void {
    const row = new Setting(listEl);
    row.addText((t) =>
      t.setPlaceholder("name").setValue(source.name).onChange((v) => {
        source.name = v.trim();
        void this.saveSources();
      })
    );
    row.addDropdown((d) =>
      d
        .addOption("local-path", "local-path")
        .addOption("git", "git")
        .setValue(source.type)
        .onChange(async (v) => {
          source.type = v as SourceDraft["type"];
          await this.saveSources();
          this.refresh();
        })
    );
    if (source.type === "local-path") {
      row.addText((t) =>
        t.setPlaceholder("/absolute/path/to/source-vault").setValue(source.path).onChange((v) => {
          source.path = v.trim();
          void this.saveSources();
        })
      );
    } else {
      row.addText((t) =>
        t.setPlaceholder("git remote url").setValue(source.remote).onChange((v) => {
          source.remote = v.trim();
          void this.saveSources();
        })
      );
      row.addText((t) =>
        t.setPlaceholder("branch").setValue(source.branch).onChange((v) => {
          source.branch = v.trim();
          void this.saveSources();
        })
      );
    }
    row.addText((t) =>
      t.setPlaceholder("root, e.g. 0-Extra/config-sync").setValue(source.root).onChange((v) => {
        source.root = v.trim();
        void this.saveSources();
      })
    );
    row.addExtraButton((b) =>
      b.setIcon("trash").setTooltip("Delete source").onClick(async () => {
        this.sources.splice(index, 1);
        await this.saveSources();
        this.refresh();
      })
    );
  }

  private async saveSources(): Promise<void> {
    try {
      this.host.settings.externalSources = validateExternalSources(this.sources.map(toCandidate));
      await this.host.saveSettings();
      this.sourcesErrorMsg = "";
    } catch (e) {
      this.sourcesErrorMsg = `Not saved: ${(e as Error).message}`;
    }
    this.sourcesErrorEl?.setText(this.sourcesErrorMsg);
  }
}
