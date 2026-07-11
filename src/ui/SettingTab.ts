import { App, DropdownComponent, ExtraButtonComponent, Notice, Platform, Plugin, PluginSettingTab, SearchComponent, Setting, setIcon, TextComponent, ToggleComponent } from "obsidian";
import { DeviceClass, Remote, RibbonKey, SyncGroup } from "../core/types";
import { PkmMode } from "../core/pkm";
import { validateRemotes } from "../core/manifest";
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
import { FolderSelectModal } from "./FolderSelectModal";

export interface SettingsHost extends Plugin {
  settings: {
    pkmMode: PkmMode;
    rootPath: string;
    remotes: Remote[];
    ribbonButtons: Record<RibbonKey, boolean>;
    statusInMenu: boolean;
    remoteAutoCheck: boolean;
    localPeriodicCheck: boolean;
  };
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

interface RemoteDraft {
  name: string;
  type: "vault" | "git";
  storePath: string;
  url: string;
  branch: string;
  subdir: string;
}

function toDraft(r: Remote): RemoteDraft {
  return {
    name: r.name,
    type: r.type,
    storePath: r.type === "vault" ? r.storePath : "",
    url: r.type === "git" ? r.url : "",
    branch: r.type === "git" ? r.branch : "",
    subdir: r.type === "git" ? (r.subdir ?? "") : "",
  };
}

function toCandidate(d: RemoteDraft): unknown {
  if (d.type === "vault") return { name: d.name, type: d.type, storePath: d.storePath };
  const c: Record<string, string> = { name: d.name, type: d.type, url: d.url, branch: d.branch };
  if (d.subdir.trim() !== "") c.subdir = d.subdir.trim();
  return c;
}

type PanelTab = "general" | "obsidian" | "core" | "plugins" | "advanced" | "sources";

const TABS: { id: PanelTab; label: string; icon: string; desktopOnly?: true }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "obsidian", label: "Obsidian", icon: "gem" },
  { id: "core", label: "Core plugins", icon: "toy-brick" },
  { id: "plugins", label: "Community plugins", icon: "puzzle" },
  { id: "advanced", label: "Advanced", icon: "wrench" },
  { id: "sources", label: "Remotes", icon: "git-branch", desktopOnly: true },
];

const SECTION_TAB: Record<"obsidian" | "core" | "plugins", string> = {
  obsidian: "Obsidian",
  core: "Core plugins",
  plugins: "Community plugins",
};

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: RemoteDraft[] = [];
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
      this.sources = this.host.settings.remotes.map(toDraft);
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
      if (tab.desktopOnly === true && Platform.isMobile) continue;
      const el = nav.createEl("button", { cls: "config-sync-tab" });
      setIcon(el.createSpan({ cls: "config-sync-tab-icon" }), tab.icon);
      el.createSpan({ cls: "config-sync-tab-label", text: tab.label });
      if (tab.id === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => this.switchTab(tab.id));
    }
  }

  private async renderActiveTab(containerEl: HTMLElement, gen: number): Promise<void> {
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        this.renderStatusToggles(containerEl);
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
        `Where your synced settings live inside this vault. Your regular vault sync (e.g. remotely-save) carries this folder to your other devices. Leave empty for the recommended location (currently: ${resolved}).`
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

  private renderStatusToggles(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync menu shows change counts")
      .setDesc("Counts changed groups when the menu opens. Turn off if opening the menu feels slow.")
      .addToggle((t) =>
        t.setValue(this.host.settings.statusInMenu).onChange(async (v) => {
          this.host.settings.statusInMenu = v;
          await this.host.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Check remotes automatically")
      .setDesc("Checks each remote's last capture shortly after startup and every few hours.")
      .addToggle((t) =>
        t.setValue(this.host.settings.remoteAutoCheck).onChange(async (v) => {
          this.host.settings.remoteAutoCheck = v;
          await this.host.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Periodic local check")
      .setDesc("Re-scans for local changes every 5 minutes while the window is focused, keeping the ribbon dot fresh.")
      .addToggle((t) =>
        t.setValue(this.host.settings.localPeriodicCheck).onChange(async (v) => {
          this.host.settings.localPeriodicCheck = v;
          await this.host.saveSettings();
        })
      );
  }

  private renderRibbonToggles(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Ribbon buttons")
      .setDesc("The Config Sync ribbon icon always opens a menu of available actions. Optionally also show individual ribbon icons.")
      .setHeading();
    const defs: { key: RibbonKey; label: string }[] = [
      { key: "sync", label: "Sync" },
      { key: "revert", label: "Revert last apply" },
    ];
    for (const d of defs) {
      const s = new Setting(containerEl).setName(d.label);
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
      managedHead.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("Reset all to picker defaults").onClick(async () => {
        for (let i = 0; i < this.groups.length; i++) {
          const g = this.groups[i];
          if (g === undefined || !reserved.has(g.name) || g.origin !== undefined) continue;
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
    const addRule = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add rule" });
    addRule.addEventListener("click", () => {
      this.groups.push({ name: "", path: "", type: "file", devices: "all" });
      this.expanded.add("");
      this.refresh();
    });
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
      new ExtraButtonComponent(row)
        .setIcon("rotate-ccw")
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

  private formField(parent: HTMLElement, label: string): HTMLElement {
    const f = parent.createDiv();
    f.createEl("label", { cls: "config-sync-form-label", text: label });
    return f;
  }

  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "managed" | "custom" | "discovered"): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = this.formField.bind(this);

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
      .setDesc("Sync your settings with another vault or a git repository. Your own devices don't need a remote — your regular vault sync already carries the settings.");
    const listEl = containerEl.createDiv({ cls: "config-sync-sources" });
    this.sources.forEach((draft, index) => this.renderRemoteRow(listEl, draft, index));
    this.sourcesErrorEl = containerEl.createEl("p", { cls: "mod-warning" });
    this.sourcesErrorEl.setText(this.sourcesErrorMsg);
    const addBtn = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add remote" });
    addBtn.addEventListener("click", () => {
      this.sources.push({ name: "", type: "vault", storePath: "", url: "", branch: "", subdir: "" });
      this.expanded.add("remote:");
      this.refresh();
    });
  }

  private renderRemoteRow(listEl: HTMLElement, draft: RemoteDraft, index: number): void {
    const key = `remote:${draft.name}`;
    const isOpen = this.expanded.has(key);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: draft.name === "" ? "(unnamed)" : draft.name });
    row.createSpan({ cls: "config-sync-row-type", text: draft.type });
    row.createSpan({
      cls: "config-sync-row-path",
      text: draft.type === "vault" ? draft.storePath : draft.url === "" ? "" : `${draft.url}#${draft.branch}`,
    });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ExtraButtonComponent(row)
      .setIcon("trash")
      .setTooltip("Delete remote")
      .onClick(async () => {
        this.sources.splice(index, 1);
        this.expanded.delete(key);
        await this.saveRemotes();
        this.refresh();
      });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select, .checkbox-container") !== null) return;
      if (isOpen) this.expanded.delete(key);
      else this.expanded.add(key);
      this.refresh();
    });
    if (isOpen) this.renderRemoteForm(listEl, draft);
  }

  private renderRemoteForm(listEl: HTMLElement, draft: RemoteDraft): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = this.formField.bind(this);
    const line1 = panel.createDiv({ cls: "config-sync-form-line1" });
    new DropdownComponent(field(line1, "Type"))
      .addOption("vault", "Another vault")
      .addOption("git", "Git repository")
      .setValue(draft.type)
      .onChange(async (v) => {
        draft.type = v as RemoteDraft["type"];
        await this.saveRemotes();
        this.refresh();
      });
    const nameC = new TextComponent(field(line1, "Name"));
    nameC.setPlaceholder("name").setValue(draft.name).onChange((v) => {
      this.expanded.delete(`remote:${draft.name}`);
      draft.name = v.trim();
      this.expanded.add(`remote:${draft.name}`);
      void this.saveRemotes();
    });
    nameC.inputEl.addClass("config-sync-rule-name-input");

    if (draft.type === "vault") {
      const line2 = panel.createDiv({ cls: "config-sync-remote-path" });
      const pathField = field(line2, "Store path");
      const pathC = new TextComponent(pathField);
      pathC.setPlaceholder("/path/to/other-vault/…/config-sync").setValue(draft.storePath).onChange((v) => {
        draft.storePath = v.trim();
        void this.saveRemotes();
      });
      if (Platform.isDesktop) {
        new ExtraButtonComponent(line2).setIcon("folder-open").setTooltip("Browse…").onClick(() => void this.browseStorePath(draft));
      }
    } else {
      const line2 = panel.createDiv({ cls: "config-sync-remote-git" });
      new TextComponent(field(line2, "URL")).setPlaceholder("git@host:me/config.git").setValue(draft.url).onChange((v) => {
        draft.url = v.trim();
        void this.saveRemotes();
      });
      new TextComponent(field(line2, "Branch")).setPlaceholder("main").setValue(draft.branch).onChange((v) => {
        draft.branch = v.trim();
        void this.saveRemotes();
      });
      new TextComponent(field(line2, "Folder in repo (optional)")).setPlaceholder("empty = repo root").setValue(draft.subdir).onChange((v) => {
        draft.subdir = v.trim();
        void this.saveRemotes();
      });
    }
  }

  private async browseStorePath(draft: RemoteDraft): Promise<void> {
    try {
      const { pickFolder } = await import("../external/pickFolder");
      const picked = await pickFolder();
      if (picked === null) return;
      const { findStoreDirs } = await import("../external/localPath");
      const dirs = await findStoreDirs(picked);
      const apply = (p: string): void => {
        draft.storePath = p;
        void this.saveRemotes();
        this.refresh();
      };
      const first = dirs[0];
      if (dirs.length === 1 && first !== undefined) {
        apply(first);
      } else if (dirs.length === 0) {
        apply(picked);
        new Notice("No store found here yet — Pull needs the other vault to Capture first; Push will initialize a store at this path.");
      } else {
        new FolderSelectModal(this.app, dirs, apply).open();
      }
    } catch (e) {
      new Notice(`Config Sync: ${(e as Error).message}`);
    }
  }

  private async saveRemotes(): Promise<void> {
    try {
      this.host.settings.remotes = validateRemotes(this.sources.map(toCandidate));
      await this.host.saveSettings();
      this.sourcesErrorMsg = "";
    } catch (e) {
      this.sourcesErrorMsg = `Not saved: ${(e as Error).message}`;
    }
    this.sourcesErrorEl?.setText(this.sourcesErrorMsg);
  }
}
