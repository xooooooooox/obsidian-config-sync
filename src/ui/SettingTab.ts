import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DeviceClass, ExternalSource, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[] };
  saveSettings(): Promise<void>;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
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

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false; // Obsidian entry: reload drafts from file/settings
    this.refresh();
  }

  // Internal re-render that keeps in-progress drafts.
  private refresh(): void {
    const { containerEl } = this;
    containerEl.empty();
    void this.render(containerEl);
  }

  private async render(containerEl: HTMLElement): Promise<void> {
    if (!this.loaded) {
      try {
        this.groups = await this.host.readGroupsFile();
        this.groupsReadError = null;
      } catch (e) {
        this.groups = [];
        this.groupsReadError = (e as Error).message;
      }
      this.sources = this.host.settings.externalSources.map(toDraft);
      this.loaded = true;
    }
    this.renderPkmMode(containerEl);
    await this.renderDataFolder(containerEl);
    this.renderGroups(containerEl);
    this.renderSources(containerEl);
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    new Setting(containerEl)
      .setName("PKM mode")
      .setDesc("Determines the default data folder. Auto detects IOTO through the ioto-update plugin.")
      .addDropdown((d) =>
        d
          .addOption("auto", `Auto (detected: ${detected === "ioto" ? "IOTO" : "default"})`)
          .addOption("ioto", "IOTO")
          .addOption("default", "Default")
          .setValue(this.host.settings.pkmMode)
          .onChange(async (v) => {
            this.host.settings.pkmMode = v as PkmMode;
            await this.host.saveSettings();
            this.refresh(); // update the data-folder placeholder
          })
      );
  }

  private async renderDataFolder(containerEl: HTMLElement): Promise<void> {
    const resolved = await this.host.resolvedRootPath();
    new Setting(containerEl)
      .setName("Data folder")
      .setDesc(`Vault-relative folder holding config-sync.json and store/. Leave empty to follow the PKM mode default (currently: ${resolved}).`)
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
      });
  }

  private renderGroups(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync groups")
      .setHeading()
      .setDesc("Saved to <data folder>/config-sync.json when valid. The file can also be edited directly (JSON Schema referenced).");
    if (this.groupsReadError !== null) {
      containerEl.createEl("p", {
        text: `Cannot read the groups file — fix it manually and reopen this tab: ${this.groupsReadError}`,
        cls: "mod-warning",
      });
      return;
    }
    const listEl = containerEl.createDiv();
    this.groups.forEach((group, index) => {
      this.renderGroupRow(listEl, group, index);
    });
    this.groupsErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add group").onClick(() => {
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
      t.setPlaceholder("{configDir}/…").setValue(group.path).onChange((v) => {
        group.path = v.trim();
        void this.saveGroups();
      })
    );
    row.addDropdown((d) =>
      d.addOption("file", "file").addOption("dir", "dir").setValue(group.type).onChange((v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        void this.saveGroups();
        this.refresh(); // enable/disable the sanitize field
      })
    );
    row.addDropdown((d) =>
      d.addOption("all", "all").addOption("desktop", "desktop").addOption("mobile", "mobile")
        .setValue(group.devices)
        .onChange((v) => {
          group.devices = v as DeviceClass;
          void this.saveGroups();
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
      b.setIcon("trash").setTooltip("Delete group").onClick(() => {
        this.groups.splice(index, 1);
        void this.saveGroups();
        this.refresh();
      })
    );
  }

  private async saveGroups(): Promise<void> {
    try {
      await this.host.writeGroupsFile(this.groups);
      this.groupsErrorEl?.setText("");
    } catch (e) {
      this.groupsErrorEl?.setText(`Not saved: ${(e as Error).message}`);
    }
  }

  private renderSources(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("External sources")
      .setHeading()
      .setDesc("Import sources for this vault (used by the desktop-only Import command). Stored in plugin settings, never in the store.");
    const listEl = containerEl.createDiv();
    this.sources.forEach((source, index) => {
      this.renderSourceRow(listEl, source, index);
    });
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
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
      d.addOption("local-path", "local-path").addOption("git", "git").setValue(source.type).onChange((v) => {
        source.type = v as SourceDraft["type"];
        void this.saveSources();
        this.refresh(); // switch the conditional fields
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
      b.setIcon("trash").setTooltip("Delete source").onClick(() => {
        this.sources.splice(index, 1);
        void this.saveSources();
        this.refresh();
      })
    );
  }

  private async saveSources(): Promise<void> {
    try {
      this.host.settings.externalSources = validateExternalSources(this.sources.map(toCandidate));
      await this.host.saveSettings();
      this.sourcesErrorEl?.setText("");
    } catch (e) {
      this.sourcesErrorEl?.setText(`Not saved: ${(e as Error).message}`);
    }
  }
}
