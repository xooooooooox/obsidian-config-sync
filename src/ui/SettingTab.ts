import { App, ButtonComponent, DropdownComponent, ExtraButtonComponent, Notice, Plugin, PluginSettingTab, SearchComponent, Setting, TextComponent, ToggleComponent } from "obsidian";
import { DeviceClass, ExternalSource, RibbonKey, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateExternalSources } from "../core/manifest";
import {
  CatalogItem,
  CatalogSection,
  defaultGroupForName,
  expectedPathForName,
  findGroupByName,
  groupForItem,
  joinLocation,
  reservedNames,
  splitLocation,
  toggleSection,
} from "../core/catalog";
import { confirmWarnings } from "./ConfirmModal";

export interface SettingsHost extends Plugin {
  settings: { pkmMode: PkmMode; rootPath: string; externalSources: ExternalSource[]; ribbonButtons: Record<RibbonKey, boolean> };
  saveSettings(): Promise<void>;
  refreshRibbons(): void;
  transportAvailable(): boolean;
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>;
  installedPluginIds(): string[];
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

type PanelTab = "general" | "obsidian" | "core" | "plugins" | "advanced" | "sources";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "obsidian", label: "Obsidian" },
  { id: "core", label: "Core plugins" },
  { id: "plugins", label: "Community plugins" },
  { id: "advanced", label: "Advanced" },
  { id: "sources", label: "Remotes" },
];

const SECTION_TAB: Record<"obsidian" | "core" | "plugins", string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  plugins: "Community plugins",
};

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: SourceDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private search = "";
  private searchInputEl: HTMLInputElement | null = null; // restore focus across search re-renders
  private expanded = new Set<string>(); // UI-transient: advanced rows expanded this session
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false;
    this.activeTab = "general";
    this.search = "";
    this.expanded.clear();
    this.rerender(0);
  }

  private refresh(): void {
    this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): void {
    const gen = ++this.renderGen;
    this.containerEl.empty();
    void this.render(this.containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.rerender(0);
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
    this.renderSearchBox(containerEl);
    if (this.search.trim() !== "") {
      await this.renderSearchResults(containerEl, gen);
    } else {
      this.renderTabNav(containerEl);
      await this.renderActiveTab(containerEl, gen);
    }
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
    if (this.search.trim() !== "" && this.searchInputEl !== null) {
      const el = this.searchInputEl;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  private renderSearchBox(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "config-sync-search" });
    const search = new SearchComponent(wrap);
    search.setPlaceholder("Search all settings…");
    search.setValue(this.search);
    this.searchInputEl = search.inputEl;
    search.onChange((v) => {
      this.search = v;
      this.refresh();
    });
  }

  private renderTabNav(containerEl: HTMLElement): void {
    const nav = containerEl.createDiv({ cls: "config-sync-tabs" });
    for (const tab of TABS) {
      const el = nav.createEl("button", { text: tab.label, cls: "config-sync-tab" });
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => this.switchTab(tab.id));
    }
  }

  private async renderActiveTab(containerEl: HTMLElement, gen: number): Promise<void> {
    switch (this.activeTab) {
      case "general":
        this.renderTransportStatus(containerEl);
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        this.renderRibbonToggles(containerEl);
        break;
      case "obsidian":
      case "core":
      case "plugins":
        if (this.renderGroupsReadError(containerEl)) break;
        await this.renderSections(containerEl, gen, this.activeTab);
        if (gen !== this.renderGen) return;
        this.renderGroupsError(containerEl);
        break;
      case "advanced":
        if (this.renderGroupsReadError(containerEl)) break;
        await this.renderAdvanced(containerEl, gen);
        if (gen !== this.renderGen) return;
        this.renderGroupsError(containerEl);
        break;
      case "sources":
        this.renderSources(containerEl);
        break;
    }
  }

  private async sectionsFor(tab: "obsidian" | "core" | "plugins"): Promise<CatalogSection[]> {
    if (tab === "obsidian") return this.host.listOptionSections(this.groups);
    if (tab === "core") return this.host.listCoreSections(this.groups);
    return this.host.listPluginSections(this.groups);
  }

  private async renderSections(containerEl: HTMLElement, gen: number, tab: "obsidian" | "core" | "plugins"): Promise<void> {
    const sections = await this.sectionsFor(tab);
    if (gen !== this.renderGen) return;
    for (const sec of sections) {
      const head = new Setting(containerEl).setName(sec.heading).setDesc(sec.description).setHeading();
      if (sec.allowSyncAll) this.addSyncAllToggle(head, sec);
      const listEl = containerEl.createDiv();
      for (const item of sec.items) this.renderChecklistRow(listEl, item);
    }
  }

  private addSyncAllToggle(head: Setting, sec: CatalogSection): void {
    const tickable = sec.items.filter((i) => i.disabledReason === null);
    const allOn = tickable.length > 0 && tickable.every((i) => findGroupByName(this.groups, i.name) !== undefined);
    head.addToggle((t) => {
      t.setValue(allOn)
        .setTooltip(allOn ? "Sync none" : "Sync all")
        .onChange(async (v) => {
          this.groups = toggleSection(this.groups, sec.items, v);
          await this.saveGroups();
          this.refresh();
        });
    });
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem): void {
    const group = findGroupByName(this.groups, item.name);
    const row = new Setting(listEl).setName(item.label);
    const parts: string[] = [];
    if (item.description !== null) parts.push(item.description);
    if (item.disabledReason !== null) parts.push(item.disabledReason);
    if (item.cautionReason !== null) parts.push(item.cautionReason);
    if (!item.exists && item.disabledReason === null && item.cautionReason === null) parts.push("(not present in this vault yet)");
    const expected = expectedPathForName(item.name);
    if (group !== undefined && expected !== null && group.path !== expected) parts.push("⚙ customized");
    row.setDesc(parts.join(" "));
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
            this.refresh();
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
              this.refresh();
              return;
            }
          }
          this.groups.push(groupForItem(item.name, item.path, item.type, item.description));
        } else {
          const idx = this.groups.findIndex((g) => g.name === item.name);
          if (idx >= 0) this.groups.splice(idx, 1);
        }
        await this.saveGroups();
        this.refresh();
      });
    });
  }

  private async renderSearchResults(containerEl: HTMLElement, gen: number): Promise<void> {
    const q = this.search.trim().toLowerCase();
    const tabs: ("obsidian" | "core" | "plugins")[] = ["obsidian", "core", "plugins"];
    const listEl = containerEl.createDiv();
    let any = false;
    for (const tab of tabs) {
      const sections = await this.sectionsFor(tab);
      if (gen !== this.renderGen) return;
      for (const sec of sections) {
        for (const item of sec.items) {
          const hay = `${item.name} ${item.label} ${item.path}`.toLowerCase();
          if (!hay.includes(q)) continue;
          any = true;
          const labelled: CatalogItem = { ...item, label: `${item.label} — ${SECTION_TAB[tab]} · ${sec.heading}` };
          this.renderChecklistRow(listEl, labelled);
        }
      }
    }
    if (!any) listEl.createEl("p", { text: "No matching settings.", cls: "config-sync-empty" });
    this.renderGroupsError(containerEl);
  }

  private renderTransportStatus(containerEl: HTMLElement): void {
    const remotes = this.host.settings.externalSources;
    const s = new Setting(containerEl).setName("Store transport");
    if (remotes.length === 0) {
      s.setDesc(
        "Store syncs via your note-sync tool (remotely-save / Obsidian Sync / …). Add a remote under Remotes for git or cross-vault sync."
      );
    } else {
      const list = remotes.map((r) => `${r.name} (${r.type})`).join(", ");
      s.setDesc(`Remotes: ${list}. Use Pull / Push to sync the store.`);
    }
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
            this.loaded = false;
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

  private renderRibbonToggles(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Ribbon buttons")
      .setDesc("The Config Sync ribbon icon always opens a menu of available actions. Optionally also show individual ribbon icons.")
      .setHeading();
    const defs: { key: RibbonKey; label: string; transport: boolean }[] = [
      { key: "capture", label: "Capture", transport: false },
      { key: "apply", label: "Apply", transport: false },
      { key: "revert", label: "Revert last apply", transport: false },
      { key: "pull", label: "Pull", transport: true },
      { key: "push", label: "Push", transport: true },
    ];
    for (const d of defs) {
      const s = new Setting(containerEl).setName(d.label);
      if (d.transport && !this.host.transportAvailable()) {
        s.setDesc("Shown on desktop once a remote is configured.");
      }
      s.addToggle((t) =>
        t.setValue(this.host.settings.ribbonButtons[d.key]).onChange(async (v) => {
          this.host.settings.ribbonButtons[d.key] = v;
          await this.host.saveSettings();
          this.host.refreshRibbons();
        })
      );
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

  private async renderAdvanced(containerEl: HTMLElement, gen: number): Promise<void> {
    const reserved = reservedNames(this.host.installedPluginIds());
    const managed = this.groups.filter((g) => reserved.has(g.name) && g.origin === undefined);
    const custom = this.groups.filter((g) => !reserved.has(g.name) && g.origin === undefined);

    const managedHead = new Setting(containerEl)
      .setName("Managed by pickers")
      .setHeading()
      .setDesc("Rules created from the other tabs. Expand a row to edit it, or reset it to the picker default.");
    if (managed.length > 0) {
      managedHead.addButton((b) => b.setButtonText("Reset all").onClick(async () => {
        for (let i = 0; i < this.groups.length; i++) {
          const g = this.groups[i];
          if (g === undefined || !reserved.has(g.name)) continue;
          const def = defaultGroupForName(g.name);
          if (def !== null) this.groups[i] = def;
        }
        await this.saveGroups();
        this.refresh();
      }));
    }
    const managedEl = containerEl.createDiv();
    for (const group of managed) this.renderRuleCard(managedEl, group, true);

    const discovered = await this.host.listDiscoveredFiles(this.groups);
    if (gen !== this.renderGen) return;
    const discoveredOn = this.groups.filter((g) => g.origin === "discovered");
    if (discovered.length > 0 || discoveredOn.length > 0) {
      new Setting(containerEl)
        .setName("Discovered files")
        .setHeading()
        .setDesc("Config files we found but couldn't classify. Turn one on to start syncing it.");
      const discEl = containerEl.createDiv();
      for (const group of discoveredOn) this.renderDiscoveredOnRow(discEl, group);
      for (const d of discovered) this.renderDiscoveredRow(discEl, d);
    }

    new Setting(containerEl)
      .setName("Custom rules")
      .setHeading()
      .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection (sanitize).");
    const customEl = containerEl.createDiv();
    for (const group of custom) this.renderRuleCard(customEl, group, false);
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add rule").onClick(() => {
        this.groups.push({ name: "", path: "", type: "file", devices: "all" });
        this.expanded.add("");
        this.refresh();
      })
    );
  }

  private renderDiscoveredRow(listEl: HTMLElement, d: { name: string; path: string }): void {
    const row = listEl.createDiv({ cls: "config-sync-row is-static" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(d.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(false).setTooltip("Sync this file").onChange(async (v) => {
      if (!v) return;
      this.groups.push({ name: d.name, path: d.path, type: "file", devices: "all", origin: "discovered" });
      try {
        await this.host.writeGroupsFile(this.groups);
        this.groupsErrorMsg = "";
      } catch (e) {
        this.groups.pop(); // roll back so no broken group persists in memory
        this.groupsErrorMsg = `Not saved: ${(e as Error).message}`;
      }
      this.refresh();
    });
  }

  private renderDiscoveredOnRow(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(group.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(true).setTooltip("Stop syncing this file").onChange(async (v) => {
      if (v) return;
      const idx = this.groups.findIndex((g) => g === group);
      if (idx >= 0) this.groups.splice(idx, 1);
      this.expanded.delete(group.name);
      await this.saveGroups();
      this.refresh();
    });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (isOpen) this.renderRuleForm(listEl, group, "discovered");
  }

  private renderRuleCard(listEl: HTMLElement, group: SyncGroup, managed: boolean): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: group.name === "" ? "(unnamed)" : group.name });
    row.createSpan({ cls: "config-sync-row-path", text: splitLocation(group.path).rel });
    if (managed) {
      const expected = expectedPathForName(group.name);
      if (expected !== null && group.path !== expected) {
        row.createSpan({ cls: "config-sync-badge", text: "⚙ customized", attr: { title: `was ${expected}` } });
      }
    }
    row.createDiv({ cls: "config-sync-rule-spacer" });
    if (managed) {
      new ButtonComponent(row)
        .setButtonText("Reset")
        .setTooltip("Restore to the picker default")
        .onClick(async () => {
          const def = defaultGroupForName(group.name);
          if (def === null) return;
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups[idx] = def;
          await this.saveGroups();
          this.refresh();
        });
    } else {
      new ExtraButtonComponent(row)
        .setIcon("trash")
        .setTooltip("Delete rule")
        .onClick(async () => {
          const idx = this.groups.findIndex((g) => g === group);
          if (idx >= 0) this.groups.splice(idx, 1);
          this.expanded.delete(group.name);
          await this.saveGroups();
          this.refresh();
        });
    }
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (isOpen) this.renderRuleForm(listEl, group, managed ? "managed" : "custom");
  }

  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "managed" | "custom" | "discovered"): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = (parent: HTMLElement, label: string): HTMLElement => {
      const f = parent.createDiv();
      f.createEl("label", { cls: "config-sync-form-label", text: label });
      return f;
    };

    if (mode !== "discovered") {
      const line1 = panel.createDiv({ cls: "config-sync-form-line1" + (mode === "custom" ? " has-name" : "") });
      if (mode === "custom") {
        const nameC = new TextComponent(field(line1, "Name"));
        nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(group.name).onChange((v) => {
          this.expanded.delete(group.name);
          group.name = v.trim();
          this.expanded.add(group.name);
          void this.saveGroups();
        });
        nameC.inputEl.addClass("config-sync-rule-name-input");
      }
      const loc = splitLocation(group.path);
      new DropdownComponent(field(line1, "Location"))
        .addOption("config", "Config folder")
        .addOption("vault", "Vault root")
        .setValue(loc.location)
        .onChange((v) => {
          group.path = joinLocation(v as "config" | "vault", splitLocation(group.path).rel);
          void this.saveGroups();
        });
      const pathC = new TextComponent(field(line1, "Path"));
      pathC.setPlaceholder("relative path").setValue(loc.rel).onChange((v) => {
        group.path = joinLocation(splitLocation(group.path).location, v.trim());
        void this.saveGroups();
      });
    }

    const line2 = panel.createDiv({ cls: "config-sync-form-line2" });
    new DropdownComponent(field(line2, "Type"))
      .addOption("file", "file")
      .addOption("dir", "dir")
      .setValue(group.type)
      .onChange(async (v) => {
        group.type = v as SyncGroup["type"];
        if (group.type !== "file") delete group.sanitize;
        await this.saveGroups();
        this.refresh();
      });
    new DropdownComponent(field(line2, "Devices"))
      .addOption("all", "all")
      .addOption("desktop", "desktop")
      .addOption("mobile", "mobile")
      .setValue(group.devices)
      .onChange(async (v) => {
        group.devices = v as DeviceClass;
        await this.saveGroups();
        this.refresh();
      });
    const sanC = new TextComponent(field(line2, "Sanitize"));
    sanC.setPlaceholder("globs, comma-separated").setValue(group.sanitize?.join(", ") ?? "").setDisabled(group.type !== "file").onChange((v) => {
      const patterns = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (patterns.length > 0) group.sanitize = patterns;
      else delete group.sanitize;
      void this.saveGroups();
    });
    const descC = new TextComponent(field(line2, "Description"));
    descC.setPlaceholder("optional").setValue(group.description ?? "").onChange((v) => {
      const d = v.trim();
      if (d !== "") group.description = d;
      else delete group.description;
      void this.saveGroups();
    });
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
      .setName("Remotes")
      .setHeading()
      .setDesc(
        "Places you Pull the store from and Push it to — another vault (local path) or a git repo. note-sync handles your own devices without a remote."
      );
    const listEl = containerEl.createDiv();
    this.sources.forEach((source, index) => this.renderSourceRow(listEl, source, index));
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.sourcesErrorEl.setText(this.sourcesErrorMsg);
    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Add remote").onClick(() => {
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
      d.addOption("local-path", "local-path").addOption("git", "git").setValue(source.type).onChange(async (v) => {
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
      b.setIcon("trash").setTooltip("Delete remote").onClick(async () => {
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
