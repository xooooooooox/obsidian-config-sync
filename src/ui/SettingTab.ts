import { App, DropdownComponent, ExtraButtonComponent, Notice, Platform, Plugin, PluginSettingTab, SearchComponent, Setting, setIcon, TextComponent, ToggleComponent } from "obsidian";
import { DeviceClass, FieldRule, Remote, RibbonKey, SyncGroup, SyncMode } from "../core/types";
import { SensitiveScan } from "../core/modes";
import { PkmMode } from "../core/pkm";
import { validateRemotes } from "../core/manifest";
import { keyMatchesAny } from "../core/sanitize";
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
import { commitDraft } from "./commitGroups";
import { sortBySensitiveFirst } from "./sensitiveSort";
import { classifyJsonKeys } from "./jsonView";

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
  readGroupsFile(): Promise<SyncGroup[]>;
  writeGroupsFile(groups: SyncGroup[]): Promise<void>;
  resolvedRootPath(): Promise<string>;
  detectedMode(): "ioto" | "default";
  listOptionSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listCoreSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listPluginSections(groups: SyncGroup[]): Promise<CatalogSection[]>;
  listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]>;
  installedPluginIds(): string[];
  detectSensitive(group: SyncGroup): Promise<SensitiveScan>;
  readItemFile(group: SyncGroup): Promise<string | null>;
  passphrase(): string | null;
  setPassphrase(v: string | null): void;
  displayName(group: string, storedLabel?: string): string;
}

const SENSITIVE_ENCRYPT_RE = /apikey|api_key|token|secret|password|credential/i;

function defaultFieldsFromDetection(keys: string[]): FieldRule[] {
  return keys.map((pattern) => ({ pattern, action: SENSITIVE_ENCRYPT_RE.test(pattern) ? "encrypt" : "strip" }));
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

// Single source of truth for General's Settings: used both to render (data-search-anchor
// attached to each Setting) and to build the search index, so the two can't drift.
interface GeneralSettingDef {
  name: string;
  desc: string;
  anchorId: string;
}

const GENERAL_SETTINGS: GeneralSettingDef[] = [
  { name: "PKM mode", desc: "Adjusts the recommended storage location to match how your vault is organized. Auto detects IOTO vaults.", anchorId: "general-pkm-mode" },
  {
    name: "Data folder",
    // Rendered desc appends a computed "(currently: <resolved path>)" suffix that depends on an
    // async host.resolvedRootPath() call; this static text is the search-index copy only.
    desc: "Where your synced settings live inside this vault. Your regular vault sync (e.g. remotely-save) carries this folder to your other devices.",
    anchorId: "general-data-folder",
  },
  { name: "Sync menu shows change counts", desc: "Counts changed items when the menu opens. Turn off if opening the menu feels slow.", anchorId: "general-status-in-menu" },
  { name: "Check remotes automatically", desc: "Checks each remote's last capture shortly after startup and every few hours.", anchorId: "general-remote-auto-check" },
  {
    name: "Periodic local check",
    desc: "Re-scans for local changes every 5 minutes while the window is focused, keeping the ribbon dot fresh.",
    anchorId: "general-local-periodic-check",
  },
  {
    name: "Ribbon buttons",
    desc: "The Config Sync ribbon icon always opens a menu of available actions. Optionally also show individual ribbon icons.",
    anchorId: "general-ribbon-buttons",
  },
  { name: "Passphrase", desc: "Needed for Encrypt modes. Enter the same passphrase on each device; it is never stored in the store or synced.", anchorId: "general-passphrase" },
];

interface SearchHit {
  scope: "general" | "obsidian" | "core" | "plugins" | "advanced" | "sources";
  kind: "setting" | "item" | "rule" | "discovered" | "remote";
  name: string;
  desc: string;
  anchorId: string;
  item?: CatalogItem;
}

const SCOPE_LABEL: Record<SearchHit["scope"], string> = {
  general: "General",
  obsidian: "Obsidian",
  core: "Core",
  plugins: "Community",
  advanced: "Advanced",
  sources: "Remotes",
};

export class ConfigSyncSettingTab extends PluginSettingTab {
  private groups: SyncGroup[] = [];
  private sources: RemoteDraft[] = [];
  private groupsReadError: string | null = null;
  private loaded = false;
  private renderGen = 0;
  private activeTab: PanelTab = "general";
  private search = "";
  private searchScope: SearchHit["scope"] | "all" = "all";
  private bodyEl: HTMLElement | null = null;
  private expanded = new Set<string>(); // UI-transient: advanced rows expanded this session
  private advOpen = new Set<string>(); // UI-transient: which rows have the Advanced sub-section open
  private jsonOpen = new Set<string>(); // UI-transient: which rows have the View data.json body open
  private groupsErrorEl: HTMLElement | null = null;
  private sourcesErrorEl: HTMLElement | null = null;
  private groupsErrorMsg = "";
  private sourcesErrorMsg = "";
  private saveErrorFor = "";
  private detections = new Map<string, SensitiveScan>(); // group name -> live scan, filled in as reads complete
  private passphraseStatusEl: HTMLElement | null = null;
  private sortedSections = new Set<string>(); // tabs that already re-rendered once to settle sensitive-first ordering

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    this.loaded = false;
    this.activeTab = "general";
    this.search = "";
    this.searchScope = "all";
    this.expanded.clear();
    this.sortedSections.clear();
    void this.rerender(0);
  }

  private refresh(): void {
    void this.rerender(this.containerEl.scrollTop);
  }

  private rerender(scrollTop: number): Promise<void> {
    const gen = ++this.renderGen;
    this.bodyEl = null;
    this.containerEl.empty();
    return this.render(this.containerEl, gen, scrollTop);
  }

  private switchTab(tab: PanelTab): void {
    this.activeTab = tab;
    this.saveErrorFor = "";
    this.sortedSections.delete(tab);
    void this.rerender(0);
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
    this.bodyEl = containerEl.createDiv({ cls: "config-sync-settings-body" });
    await this.renderBody(this.bodyEl, gen);
    if (gen !== this.renderGen) return;
    containerEl.scrollTop = scrollTop;
  }

  private async renderBody(bodyEl: HTMLElement, gen: number): Promise<void> {
    if (gen !== this.renderGen) return;
    bodyEl.empty();
    if (this.search.trim() !== "") {
      await this.renderSearchResults(bodyEl, gen);
    } else {
      this.renderTabNav(bodyEl);
      await this.renderActiveTab(bodyEl, gen);
    }
  }

  private renderSearchBox(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: "config-sync-search" });
    const search = new SearchComponent(wrap);
    search.setPlaceholder("Search all settings…");
    search.setValue(this.search);
    search.onChange((v) => {
      this.search = v;
      this.searchScope = "all";
      const body = this.bodyEl;
      if (body === null) return;
      void this.renderBody(body, this.renderGen);
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
    if (this.activeTab === "sources" && Platform.isMobile) this.activeTab = "general";
    switch (this.activeTab) {
      case "general":
        this.renderPkmMode(containerEl);
        await this.renderDataFolder(containerEl, gen);
        this.renderStatusToggles(containerEl);
        this.renderRibbonToggles(containerEl);
        this.renderPassphrase(containerEl);
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
      const items = sortBySensitiveFirst(sec.items, (i) => {
        const s = this.detections.get(i.name);
        return (s?.keys.length ?? 0) > 0 || (s?.blob ?? false);
      });
      for (const item of items) this.renderChecklistRow(listEl, item);
    }
  }

  private addSyncAllToggle(head: Setting, sec: CatalogSection): void {
    const tickable = sec.items.filter((i) => i.disabledReason === null);
    const allOn = tickable.length > 0 && tickable.every((i) => findGroupByName(this.groups, i.name) !== undefined);
    head.addToggle((t) => {
      t.setValue(allOn)
        .setTooltip(allOn ? "Sync none" : "Sync all")
        .onChange(async (v) => {
          await this.commitGroups((draft) => {
            const next = toggleSection(draft, sec.items, v);
            draft.length = 0;
            draft.push(...next);
          });
          this.refresh();
        });
    });
  }

  private renderChecklistRow(listEl: HTMLElement, item: CatalogItem): void {
    const wrap = listEl.createDiv({ cls: "config-sync-item-wrap" });
    this.renderItemInto(wrap, item);
  }

  // Rebuilds one item's row (chevron + Setting + mode segment + expansion) in place. Mode-segment
  // clicks and expansion mutations call this on their own wrap instead of a full refresh(),
  // so the rest of the panel (scroll position, other rows) doesn't jolt.
  private renderItemInto(wrap: HTMLElement, item: CatalogItem): void {
    wrap.empty();
    const group = findGroupByName(this.groups, item.name);
    const row = new Setting(wrap).setName(item.label);
    row.settingEl.setAttribute("data-search-anchor", `item-${item.name}`);
    let syncExpansion = (): void => undefined;
    if (group !== undefined) {
      const grp = group;
      const chevron = createSpan({ cls: "config-sync-row-chevron" });
      // Toggle by adding/removing the drawer in place — no header rebuild, so expand/collapse
      // doesn't jitter the row.
      syncExpansion = (): void => {
        const open = this.expanded.has(grp.name);
        setIcon(chevron, open ? "chevron-down" : "chevron-right");
        const existing = row.settingEl.querySelector(":scope > .config-sync-item-exp");
        if (open && existing === null) this.renderItemExpansion(row.settingEl, wrap, grp, item);
        else if (!open && existing !== null) existing.remove();
      };
      chevron.addEventListener("click", () => {
        if (this.expanded.has(grp.name)) this.expanded.delete(grp.name);
        else this.expanded.add(grp.name);
        syncExpansion();
      });
      row.settingEl.prepend(chevron); // native chevron icon, inline left of the name
    }
    const parts: string[] = [];
    if (item.description !== null) parts.push(item.description);
    if (item.disabledReason !== null) parts.push(item.disabledReason);
    if (!item.exists && item.disabledReason === null && item.cautionReason === null) parts.push("(not present in this vault yet)");
    row.setDesc(parts.join(" "));
    // Badge order matches the design: ⚠ keys → ⚙ custom location → device-specific. The detect
    // badge is async, so a placeholder holds its slot before the later badges are appended.
    const detectHolder = row.nameEl.createSpan({ cls: "config-sync-detect-holder" });
    if (group !== undefined && this.isCustomized(group)) {
      row.nameEl.createSpan({ cls: "config-sync-cust", text: "⚙ custom location" });
    }
    if (item.cautionReason !== null) {
      const devBadge = row.nameEl.createSpan({ cls: "config-sync-devbadge", text: "device-specific" });
      devBadge.setAttribute("title", item.cautionReason);
      devBadge.setAttribute("aria-label", item.cautionReason);
    }
    if (group !== undefined && item.disabledReason === null) {
      row.addDropdown((d) =>
        d
          .addOption("all", "all devices")
          .addOption("desktop", "desktop only")
          .addOption("mobile", "mobile only")
          .setValue(group.devices)
          .onChange(async (v) => {
            await this.commitGroups((draft) => {
              const g = draft.find((x) => x.name === item.name);
              if (g !== undefined) g.devices = v as DeviceClass;
            }, item.name);
            this.refresh();
          })
      );
    }
    if (group !== undefined && item.disabledReason === null) {
      this.renderModeSegment(row.controlEl, group, () => this.renderItemInto(wrap, item));
    }
    row.addToggle((t) => {
      t.setValue(group !== undefined);
      t.setDisabled(item.disabledReason !== null);
      t.onChange(async (v) => {
        if (v && item.cautionReason !== null) {
          const ok = await confirmWarnings(this.app, "Sync a device-specific file?", [item.cautionReason]);
          if (!ok) {
            this.refresh();
            return;
          }
        }
        await this.commitGroups((draft) => {
          if (v) draft.push(groupForItem(item.name, item.path, item.type, item.description, item.label));
          else {
            const idx = draft.findIndex((g) => g.name === item.name);
            if (idx >= 0) draft.splice(idx, 1);
          }
        }, item.name);
        this.refresh();
      });
    });
    if (item.disabledReason === null && item.exists) {
      const probe = group ?? groupForItem(item.name, item.path, item.type, null);
      this.renderDetection(detectHolder, probe, item.name);
    }
    if (this.saveErrorFor === item.name) {
      wrap.createDiv({ cls: "config-sync-save-error mod-warning", text: `couldn't save this change — ${this.groupsErrorMsg}. The change was reverted.` });
    }
    syncExpansion(); // renders the drawer if this row is already expanded (e.g. after a content re-render)
  }

  // Fields to protect / Data file / Advanced — a synced row's expansion, opened via its chevron.
  private renderItemExpansion(parent: HTMLElement, wrap: HTMLElement, group: SyncGroup, item: CatalogItem): void {
    const exp = parent.createDiv({ cls: "config-sync-item-exp" });
    if (group.mode === "fields") {
      exp.createDiv({ cls: "config-sync-explabel", text: "Fields to protect" });
      this.renderFieldsEditor(exp.createDiv(), group, () => this.renderItemInto(wrap, item));
    }
    this.renderDataFileSegment(exp, group, item, wrap);
    this.renderAdvancedSegment(exp, group, item, wrap);
  }

  private renderDataFileSegment(exp: HTMLElement, group: SyncGroup, item: CatalogItem, wrap: HTMLElement): void {
    const isOpen = this.jsonOpen.has(group.name);
    const label = exp.createDiv({ cls: "config-sync-explabel" });
    label.appendText("Data file ");
    const link = label.createSpan({ cls: "config-sync-link", text: isOpen ? "View data.json ▾" : "View data.json ▸" });
    link.addEventListener("click", () => {
      if (isOpen) this.jsonOpen.delete(group.name);
      else this.jsonOpen.add(group.name);
      this.renderItemInto(wrap, item);
    });
    if (!isOpen) return;
    const body = exp.createDiv({ cls: "config-sync-jsonbody" });
    void (async () => {
      const raw = await this.host.readItemFile(group);
      this.renderJsonPreview(body, raw, group, item, wrap);
    })();
  }

  // Read-only pretty-printed JSON of the item's live file: top-level keys are colored by rule
  // state (teal encrypt / red strip / amber detected / blue none) and clicking an un-ruled key
  // adds it as a rule. Values are shown as-is (local file, local render).
  private renderJsonPreview(body: HTMLElement, raw: string | null, group: SyncGroup, item: CatalogItem, wrap: HTMLElement): void {
    body.empty();
    if (raw === null) {
      body.createDiv({ cls: "config-sync-json-empty", text: "no local file to preview" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const detectedKeys = this.detections.get(group.name)?.keys ?? [];
    const stateByKey = new Map<string, string>();
    for (const kc of classifyJsonKeys(raw, group.fields ?? [], detectedKeys)) stateByKey.set(kc.key, kc.state);
    const pre = body.createEl("pre", { cls: "config-sync-json-pre" });
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      pre.setText(raw); // not a JSON object — show the file text verbatim
    } else {
      const addRule = (key: string): void => {
        void (async () => {
          const action = SENSITIVE_ENCRYPT_RE.test(key) ? "encrypt" : "strip";
          await this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === group.name);
            if (g === undefined) return;
            if ((g.mode ?? "plain") !== "fields") g.mode = "fields";
            g.fields = [...(g.fields ?? []), { pattern: key, action }];
          }, group.name);
          this.expanded.add(group.name);
          this.renderItemInto(wrap, item);
        })();
      };
      for (const line of JSON.stringify(parsed, null, 2).split("\n")) {
        const m = /^(\s{2})"([^"]+)":\s?(.*)$/.exec(line); // top-level key line (exactly two-space indent)
        const key = m?.[2];
        if (m !== null && key !== undefined && stateByKey.has(key)) {
          const state = stateByKey.get(key) ?? "none";
          pre.createSpan({ text: m[1] });
          const kspan = pre.createSpan({ cls: `config-sync-json-key config-sync-json-${state}`, text: `"${key}"` });
          if (state === "none" || state === "detected") kspan.addEventListener("click", () => addRule(key));
          pre.appendText(": ");
          const rest = m[3] ?? "";
          const comma = rest.endsWith(",");
          const val = comma ? rest.slice(0, -1) : rest;
          if (/^".*"$/.test(val)) pre.createSpan({ cls: "config-sync-json-val", text: val });
          else if (/^-?\d/.test(val)) pre.createSpan({ cls: "config-sync-json-num", text: val });
          else pre.appendText(val);
          if (comma) pre.appendText(",");
        } else {
          pre.appendText(line);
        }
        pre.appendText("\n");
      }
    }
    const legend = body.createDiv({ cls: "config-sync-json-legend" });
    legend.appendText("click a key to add a rule · ");
    legend.createSpan({ cls: "config-sync-json-encrypt", text: "teal=encrypt" });
    legend.appendText(" · ");
    legend.createSpan({ cls: "config-sync-json-strip", text: "red=strip" });
    legend.appendText(" · ");
    legend.createSpan({ cls: "config-sync-json-detected", text: "amber=detected" });
  }

  // Advanced: a default-collapsed sub-section holding the item's Location + Path override and
  // (for managed items) a reset link.
  private renderAdvancedSegment(exp: HTMLElement, group: SyncGroup, item: CatalogItem, wrap: HTMLElement): void {
    const isOpen = this.advOpen.has(group.name);
    const header = exp.createDiv({ cls: "config-sync-adv-header" });
    setIcon(header.createSpan({ cls: "config-sync-adv-chev" }), isOpen ? "chevron-down" : "chevron-right");
    header.createSpan({ cls: "config-sync-explabel", text: "Advanced" });
    header.addEventListener("click", () => {
      if (isOpen) this.advOpen.delete(group.name);
      else this.advOpen.add(group.name);
      this.renderItemInto(wrap, item);
    });
    if (!isOpen) return;
    const adv = exp.createDiv({ cls: "config-sync-adv" });
    const loc = splitLocation(group.path);
    new DropdownComponent(this.formField(adv, "Location"))
      .addOption("config", "Config folder")
      .addOption("vault", "Vault root")
      .setValue(loc.location)
      .onChange((v) => {
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g !== undefined) g.path = joinLocation(v as "config" | "vault", splitLocation(g.path).rel);
        }, group.name);
      });
    new TextComponent(this.formField(adv, "Path")).setValue(loc.rel).onChange((v) => {
      void this.commitGroups((draft) => {
        const g = draft.find((x) => x.name === group.name);
        if (g !== undefined) g.path = joinLocation(splitLocation(g.path).location, v.trim());
      }, group.name);
    });
    const reserved = reservedNames(this.host.installedPluginIds());
    if (reserved.has(group.name)) {
      const reset = adv.createSpan({ cls: "config-sync-link config-sync-reset-link", text: "↺ Reset this item to its default rule" });
      reset.addEventListener("click", () => {
        void (async () => {
          const def = defaultGroupForName(group.name);
          if (def === null) return;
          await this.commitGroups((draft) => {
            const idx = draft.findIndex((g) => g.name === group.name);
            if (idx >= 0) draft[idx] = def;
          }, group.name);
          this.renderItemInto(wrap, item);
        })();
      });
    }
  }

  // Kicks off an async scan of the item's live file(s) and patches the row in place once it
  // resolves, instead of blocking the tab or forcing a full re-render for every item. Runs for
  // every eligible catalog item (not just synced ones) so unsynced-but-sensitive files surface
  // a warning before the user turns sync on. Cached by cacheKey (the catalog item's stable name,
  // even when group is a throwaway probe built from groupForItem).
  private renderDetection(holder: HTMLElement, group: SyncGroup, cacheKey: string): void {
    const cached = this.detections.get(cacheKey);
    if (cached !== undefined) {
      this.applyDetection(holder, cached);
      if (cached.keys.length > 0 || cached.blob) this.settleSensitiveOrder();
      return;
    }
    void (async () => {
      let scan: SensitiveScan;
      try {
        scan = await this.host.detectSensitive(group);
      } catch {
        return;
      }
      this.detections.set(cacheKey, scan);
      if (holder.isConnected) this.applyDetection(holder, scan);
      if (scan.keys.length > 0 || scan.blob) this.settleSensitiveOrder();
    })();
  }

  // Sensitive-first ordering in renderSections is computed from whatever's cached in
  // this.detections at render time; scans that resolve after that render leave the section
  // temporarily mis-sorted. Re-render the active tab once per visit when that happens so
  // ordering settles — guarded by sortedSections (cleared on tab switch / panel open) to avoid
  // looping: the resulting re-render reads the now-cached scan directly (renderDetection's cache
  // hit branch above), so it never re-enters the async fetch path for the same item.
  private settleSensitiveOrder(): void {
    if (this.sortedSections.has(this.activeTab)) return;
    this.sortedSections.add(this.activeTab);
    this.refresh();
  }

  private applyDetection(holder: HTMLElement, scan: SensitiveScan): void {
    holder.empty();
    if (scan.keys.length === 0 && !scan.blob) return;
    const badgeText = scan.blob ? "⚠ opaque blob" : `⚠ ${scan.keys.length} keys`;
    const badge = holder.createSpan({ cls: "config-sync-detect-badge", text: badgeText });
    badge.setAttribute("aria-label", scan.blob ? "opaque encrypted blob" : `${scan.keys.length} sensitive-looking keys`);
  }

  // True only when the item's storage location (Location/Type/Path) differs from its default —
  // the "⚙ custom location" state. Mode, devices, and field rules are everyday configuration
  // and deliberately do NOT count as customization here.
  private isCustomized(group: SyncGroup): boolean {
    const expected = expectedPathForName(group.name);
    const pathCustom = expected !== null && group.path !== expected;
    const def = defaultGroupForName(group.name);
    const typeCustom = def !== null && group.type !== def.type;
    return pathCustom || typeCustom;
  }

  private renderModeSegment(controlEl: HTMLElement, group: SyncGroup, afterChange: () => void): void {
    const seg = controlEl.createDiv({ cls: "config-sync-seg" });
    const modes: { id: SyncMode; label: string }[] = [
      { id: "plain", label: "Plain" },
      { id: "fields", label: "Fields" },
      { id: "encrypted", label: "Encrypt" },
    ];
    const current = group.mode ?? "plain";
    for (const m of modes) {
      if (m.id === "fields" && group.type !== "file") continue;
      const on = current === m.id;
      const btn = seg.createEl("button", {
        cls: `config-sync-seg-btn is-mode${on ? " is-on" : ""}`,
        text: m.label,
      });
      btn.addEventListener("click", () => {
        void (async () => {
          let fieldsForNewMode: FieldRule[] | undefined;
          if (m.id === "fields" && group.fields === undefined) {
            const scan = this.detections.get(group.name) ?? (await this.host.detectSensitive(group));
            this.detections.set(group.name, scan);
            if (scan.keys.length > 0) fieldsForNewMode = defaultFieldsFromDetection(scan.keys);
          }
          await this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === group.name);
            if (g === undefined) return;
            if (m.id === "plain") {
              delete g.mode;
              delete g.fields;
            } else if (m.id === "encrypted") {
              g.mode = "encrypted";
              delete g.fields;
            } else {
              g.mode = "fields";
              if (g.fields === undefined && fieldsForNewMode !== undefined) g.fields = fieldsForNewMode;
            }
          }, group.name);
          if (m.id === "fields") this.expanded.add(group.name);
          afterChange();
        })();
      });
    }
  }

  private renderFieldsEditor(hostEl: HTMLElement, group: SyncGroup, afterChange: () => void): void {
    const panel = hostEl.createDiv({ cls: "config-sync-fields-editor" });
    const detectedKeys = this.detections.get(group.name)?.keys ?? [];
    const rules = group.fields ?? [];
    for (const rule of rules) {
      const isDetected = detectedKeys.some((k) => keyMatchesAny(k, [rule.pattern]));
      const fr = panel.createDiv({ cls: "config-sync-fieldrow" });
      fr.createSpan({ cls: "config-sync-fkey", text: rule.pattern });
      fr.createSpan({ cls: `config-sync-ftag${isDetected ? " is-detected" : ""}`, text: isDetected ? "detected" : "manual" });
      fr.createDiv({ cls: "config-sync-rule-spacer" });
      const act = fr.createDiv({ cls: "config-sync-act" });
      const actions: { id: FieldRule["action"]; label: string }[] = [
        { id: "strip", label: "Strip" },
        { id: "encrypt", label: "Encrypt" },
      ];
      for (const a of actions) {
        const on = rule.action === a.id;
        const btn = act.createEl("button", {
          cls: `config-sync-act-btn is-${a.id}${on ? " is-on" : ""}`,
          text: a.label,
        });
        btn.addEventListener("click", () => {
          void (async () => {
            const ruleIndex = rules.indexOf(rule);
            await this.commitGroups((draft) => {
              const g = draft.find((x) => x.name === group.name);
              const r = g?.fields?.[ruleIndex];
              if (r !== undefined) r.action = a.id;
            }, group.name);
            afterChange();
          })();
        });
      }
      new ExtraButtonComponent(fr).setIcon("x").setTooltip("Remove rule").onClick(() => {
        void (async () => {
          const ruleIndex = rules.indexOf(rule);
          await this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === group.name);
            if (g === undefined || g.fields === undefined) return;
            g.fields = g.fields.filter((_, i) => i !== ruleIndex);
            if (g.fields.length === 0) delete g.fields;
          }, group.name);
          afterChange();
        })();
      });
    }
    const addRow = panel.createDiv({ cls: "config-sync-addrow" });
    const input = addRow.createEl("input", { cls: "config-sync-addrow-input", attr: { placeholder: "Add key pattern… e.g. *Token*" } });
    const addBtn = addRow.createEl("button", { cls: "config-sync-addrow-btn", text: "Add" });
    addBtn.addEventListener("click", () => {
      void (async () => {
        const pattern = input.value.trim();
        if (pattern === "") return;
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.fields = [...(g.fields ?? []), { pattern, action: "strip" as const }];
        }, group.name);
        afterChange();
      })();
    });
  }

  // Builds the full-vault search index: General settings (static registry), the three picker
  // tabs' items (unchanged actionable-row behavior), Advanced rule/discovered cards, and remotes
  // (desktop only). Unfiltered by query — callers substring-match against name+desc(+path).
  private async buildSearchIndex(gen: number): Promise<SearchHit[] | null> {
    const hits: SearchHit[] = [];
    for (const s of GENERAL_SETTINGS) {
      hits.push({ scope: "general", kind: "setting", name: s.name, desc: s.desc, anchorId: s.anchorId });
    }
    const tabs: ("obsidian" | "core" | "plugins")[] = ["obsidian", "core", "plugins"];
    for (const tab of tabs) {
      const sections = await this.sectionsFor(tab);
      if (gen !== this.renderGen) return null;
      for (const sec of sections) {
        for (const item of sec.items) {
          hits.push({
            scope: tab,
            kind: "item",
            name: item.label,
            desc: `${item.name} ${item.description ?? ""} ${item.path}`,
            anchorId: `item-${item.name}`,
            item: { ...item, label: `${item.label} — ${SECTION_TAB[tab]} · ${sec.heading}` },
          });
        }
      }
    }
    const reserved = reservedNames(this.host.installedPluginIds());
    for (const g of this.groups) {
      if (g.origin === "discovered") {
        hits.push({
          scope: "advanced",
          kind: "discovered",
          name: this.host.displayName(g.name, g.label),
          desc: splitLocation(g.path).rel,
          anchorId: `advanced-rule-${g.name}`,
        });
        continue;
      }
      if (g.origin !== undefined || reserved.has(g.name)) continue;
      hits.push({
        scope: "advanced",
        kind: "rule",
        name: this.host.displayName(g.name, g.label),
        desc: "Custom rule",
        anchorId: `advanced-rule-${g.name}`,
      });
    }
    if (Platform.isDesktop) {
      for (const r of this.sources) {
        hits.push({
          scope: "sources",
          kind: "remote",
          name: r.name === "" ? "(unnamed)" : r.name,
          desc: r.type === "vault" ? r.storePath : `${r.url}#${r.branch}`,
          anchorId: `remote-${r.name}`,
        });
      }
    }
    return hits;
  }

  private async renderSearchResults(containerEl: HTMLElement, gen: number): Promise<void> {
    const q = this.search.trim().toLowerCase();
    const index = await this.buildSearchIndex(gen);
    if (index === null) return;
    const matches = index.filter((h) => `${h.name} ${h.desc}`.toLowerCase().includes(q));

    const scopes: SearchHit["scope"][] = ["general", "obsidian", "core", "plugins", "advanced", "sources"];
    const visibleScopes = Platform.isMobile ? scopes.filter((s) => s !== "sources") : scopes;
    const countFor = (scope: SearchHit["scope"] | "all"): number =>
      scope === "all" ? matches.length : matches.filter((h) => h.scope === scope).length;

    if (this.searchScope !== "all" && !visibleScopes.includes(this.searchScope)) this.searchScope = "all";

    const pillsEl = containerEl.createDiv({ cls: "config-sync-scope-pills" });
    const addPill = (scope: SearchHit["scope"] | "all", label: string): void => {
      const count = countFor(scope);
      const pill = pillsEl.createEl("button", {
        cls: `config-sync-fpill${this.searchScope === scope ? " is-active" : ""}${count === 0 ? " is-disabled" : ""}`,
        text: `${label} ${count}`,
      });
      if (count === 0) {
        pill.setAttr("disabled", "true");
        return;
      }
      pill.addEventListener("click", () => {
        this.searchScope = scope;
        this.refresh();
      });
    };
    addPill("all", "All");
    for (const scope of visibleScopes) addPill(scope, SCOPE_LABEL[scope]);

    const filtered = this.searchScope === "all" ? matches : matches.filter((h) => h.scope === this.searchScope);
    const listEl = containerEl.createDiv();
    if (filtered.length === 0) {
      listEl.createEl("p", { text: "No matching settings.", cls: "config-sync-empty" });
    } else {
      for (const hit of filtered) this.renderSearchHit(listEl, hit);
    }
    this.renderGroupsError(containerEl);
  }

  private scopeTab(scope: SearchHit["scope"]): PanelTab {
    return scope === "general" ? "general" : scope === "advanced" ? "advanced" : scope === "sources" ? "sources" : scope;
  }

  private renderSearchHit(listEl: HTMLElement, hit: SearchHit): void {
    const row = listEl.createDiv({ cls: "config-sync-hit" });
    const main = row.createDiv({ cls: "config-sync-hit-main" });
    main.createDiv({ cls: "config-sync-hit-name", text: hit.name });
    if (hit.desc.trim() !== "") main.createDiv({ cls: "config-sync-hit-desc", text: hit.desc });
    row.createSpan({ cls: "config-sync-scopetag", text: SCOPE_LABEL[hit.scope] });
    row.createSpan({ cls: "config-sync-hit-go", text: "›" });
    row.addEventListener("click", () => this.jumpTo(hit));
  }

  private jumpTo(hit: SearchHit): void {
    void (async () => {
      this.search = "";
      this.searchScope = "all";
      this.activeTab = this.scopeTab(hit.scope);
      this.sortedSections.delete(this.activeTab);
      if (hit.kind === "item" && hit.item !== undefined) this.expanded.add(hit.item.name);
      await this.rerender(0);
      const target = this.containerEl.querySelector(`[data-search-anchor="${CSS.escape(hit.anchorId)}"]`);
      if (target === null) return;
      target.scrollIntoView({ block: "center" });
      target.addClass("config-sync-search-highlight");
      window.setTimeout(() => target.removeClass("config-sync-search-highlight"), 1500);
    })();
  }

  private anchor(setting: Setting, anchorId: string): Setting {
    setting.settingEl.setAttribute("data-search-anchor", anchorId);
    return setting;
  }

  // Looks up a General Setting's name/desc/anchorId from the GENERAL_SETTINGS registry, so
  // render call sites and the search index can't drift. Throws on a miss so a future desync
  // between a render call site and the registry fails loudly in dev instead of silently.
  private generalSetting(anchorId: string): GeneralSettingDef {
    const def = GENERAL_SETTINGS.find((s) => s.anchorId === anchorId);
    if (def === undefined) throw new Error(`Config Sync: no GENERAL_SETTINGS entry for anchorId "${anchorId}"`);
    return def;
  }

  private renderPkmMode(containerEl: HTMLElement): void {
    const detected = this.host.detectedMode();
    const def = this.generalSetting("general-pkm-mode");
    this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(def.desc),
      "general-pkm-mode"
    ).addDropdown((d) =>
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
    const def = this.generalSetting("general-data-folder");
    this.anchor(
      new Setting(containerEl).setName(def.name).setDesc(
        `${def.desc} Leave empty for the recommended location (currently: ${resolved}).`
      ),
      "general-data-folder"
    ).addText((t) => {
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
    const statusInMenu = this.generalSetting("general-status-in-menu");
    this.anchor(
      new Setting(containerEl)
        .setName(statusInMenu.name)
        .setDesc(statusInMenu.desc),
      "general-status-in-menu"
    ).addToggle((t) =>
      t.setValue(this.host.settings.statusInMenu).onChange(async (v) => {
        this.host.settings.statusInMenu = v;
        await this.host.saveSettings();
      })
    );
    const remoteAutoCheck = this.generalSetting("general-remote-auto-check");
    this.anchor(
      new Setting(containerEl)
        .setName(remoteAutoCheck.name)
        .setDesc(remoteAutoCheck.desc),
      "general-remote-auto-check"
    ).addToggle((t) =>
      t.setValue(this.host.settings.remoteAutoCheck).onChange(async (v) => {
        this.host.settings.remoteAutoCheck = v;
        await this.host.saveSettings();
      })
    );
    const localPeriodicCheck = this.generalSetting("general-local-periodic-check");
    this.anchor(
      new Setting(containerEl)
        .setName(localPeriodicCheck.name)
        .setDesc(localPeriodicCheck.desc),
      "general-local-periodic-check"
    ).addToggle((t) =>
      t.setValue(this.host.settings.localPeriodicCheck).onChange(async (v) => {
        this.host.settings.localPeriodicCheck = v;
        await this.host.saveSettings();
      })
    );
  }

  private renderRibbonToggles(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-ribbon-buttons");
    this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(def.desc)
        .setHeading(),
      "general-ribbon-buttons"
    );
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

  private renderPassphrase(containerEl: HTMLElement): void {
    const def = this.generalSetting("general-passphrase");
    const setting = this.anchor(
      new Setting(containerEl)
        .setName(def.name)
        .setDesc(def.desc),
      "general-passphrase"
    );
    let draft = "";
    setting.addText((t) => {
      t.inputEl.type = "password";
      t.setValue("").onChange((v) => {
        draft = v;
      });
    });
    setting.addButton((b) =>
      b.setButtonText("Set").onClick(() => {
        this.host.setPassphrase(draft === "" ? null : draft);
        this.updatePassphraseStatus();
      })
    );
    this.passphraseStatusEl = setting.descEl.createDiv({ cls: "config-sync-passphrase-status" });
    this.updatePassphraseStatus();
  }

  private updatePassphraseStatus(): void {
    if (this.passphraseStatusEl === null) return;
    this.passphraseStatusEl.setText(this.host.passphrase() !== null ? "set on this device" : "not set");
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
    // Row-pinned (inline) errors are shown on their card; only surface page-level errors here.
    this.groupsErrorEl.setText(this.saveErrorFor === "" ? this.groupsErrorMsg : "");
  }

  private async renderAdvanced(containerEl: HTMLElement, gen: number): Promise<void> {
    const reserved = reservedNames(this.host.installedPluginIds());
    const managed = this.groups.filter((g) => reserved.has(g.name) && g.origin === undefined);
    const custom = this.groups.filter((g) => !reserved.has(g.name) && g.origin === undefined);
    const customized = managed.filter((g) => this.isCustomized(g));

    if (customized.length > 0) {
      new Setting(containerEl)
        .setName(`${customized.length} items use a customized rule`)
        .setDesc(`${customized.map((g) => this.host.displayName(g.name, g.label)).join(", ")} — edit each on its own tab.`)
        .addButton((b) =>
          b.setButtonText("Reset all to defaults").onClick(async () => {
            await this.commitGroups((draft) => {
              for (let i = 0; i < draft.length; i++) {
                const g = draft[i];
                if (g === undefined || !reserved.has(g.name) || g.origin !== undefined) continue;
                const def = defaultGroupForName(g.name);
                if (def !== null) draft[i] = def;
              }
            });
            this.refresh();
          })
        );
    }

    new Setting(containerEl)
      .setName("Custom rules")
      .setHeading()
      .setDesc("Your own rules for anything not listed elsewhere — vault-root files, extra folders, or per-key credential protection (sanitize).");
    const customEl = containerEl.createDiv();
    for (const group of custom) this.renderRuleCard(customEl, group);
    const addRule = containerEl.createEl("button", { cls: "config-sync-add-row", text: "+ Add rule" });
    addRule.addEventListener("click", () => {
      this.groups.push({ name: "", path: "", type: "file", devices: "all" });
      this.expanded.add("");
      this.refresh();
    });

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
  }

  private renderDiscoveredRow(listEl: HTMLElement, d: { name: string; path: string }): void {
    const row = listEl.createDiv({ cls: "config-sync-row is-static" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(d.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(false).setTooltip("Sync this file").onChange(async (v) => {
      if (!v) return;
      await this.commitGroups((draft) => {
        draft.push({ name: d.name, path: d.path, type: "file", devices: "all", origin: "discovered" });
      }, d.name);
      this.refresh();
    });
  }

  private renderDiscoveredOnRow(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: splitLocation(group.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ToggleComponent(row).setValue(true).setTooltip("Stop syncing this file").onChange(async (v) => {
      if (v) return;
      await this.commitGroups((draft) => {
        const idx = draft.findIndex((g) => g.name === group.name);
        if (idx >= 0) draft.splice(idx, 1);
      }, group.name);
      this.expanded.delete(group.name);
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

  private renderRuleCard(listEl: HTMLElement, group: SyncGroup): void {
    const isOpen = this.expanded.has(group.name);
    const row = listEl.createDiv({ cls: "config-sync-row" + (isOpen ? " is-open" : "") });
    row.setAttribute("data-search-anchor", `advanced-rule-${group.name}`);
    row.createSpan({ cls: "config-sync-row-chevron", text: isOpen ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-card-title", text: group.name === "" ? "(unnamed)" : this.host.displayName(group.name, group.label) });
    row.createSpan({ cls: "config-sync-row-path", text: splitLocation(group.path).rel });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    new ExtraButtonComponent(row)
      .setIcon("trash")
      .setTooltip("Delete rule")
      .onClick(async () => {
        await this.commitGroups((draft) => {
          const idx = draft.findIndex((g) => g.name === group.name);
          if (idx >= 0) draft.splice(idx, 1);
        }, group.name);
        this.expanded.delete(group.name);
        this.refresh();
      });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, .clickable-icon, input, select") !== null) return;
      if (isOpen) this.expanded.delete(group.name);
      else this.expanded.add(group.name);
      this.refresh();
    });
    if (this.saveErrorFor === group.name) {
      listEl.createDiv({ cls: "config-sync-save-error mod-warning", text: `couldn't save this change — ${this.groupsErrorMsg}. The change was reverted.` });
    }
    if (isOpen) this.renderRuleForm(listEl, group, "custom");
  }

  private formField(parent: HTMLElement, label: string): HTMLElement {
    const f = parent.createDiv();
    f.createEl("label", { cls: "config-sync-form-label", text: label });
    return f;
  }

  private renderRuleForm(listEl: HTMLElement, group: SyncGroup, mode: "custom" | "discovered"): void {
    const panel = listEl.createDiv({ cls: "config-sync-expand" });
    const field = this.formField.bind(this);
    let currentName = group.name;

    if (mode !== "discovered") {
      const line1 = panel.createDiv({ cls: "config-sync-form-line1" + (mode === "custom" ? " has-name" : "") });
      if (mode === "custom") {
        const nameC = new TextComponent(field(line1, "Name"));
        nameC.setPlaceholder("name (a-z, 0-9, -, _)").setValue(group.name).onChange(async (v) => {
          const newName = v.trim();
          const from = currentName;
          const ok = await this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === from);
            if (g !== undefined) g.name = newName;
          }, from);
          if (ok) {
            this.expanded.delete(from);
            this.expanded.add(newName);
            currentName = newName;
          }
        });
        nameC.inputEl.addClass("config-sync-rule-name-input");
      }
      const loc = splitLocation(group.path);
      new DropdownComponent(field(line1, "Location"))
        .addOption("config", "Config folder")
        .addOption("vault", "Vault root")
        .setValue(loc.location)
        .onChange((v) => {
          void this.commitGroups((draft) => {
            const g = draft.find((x) => x.name === currentName);
            if (g !== undefined) g.path = joinLocation(v as "config" | "vault", splitLocation(g.path).rel);
          }, currentName);
        });
      const pathC = new TextComponent(field(line1, "Path"));
      pathC.setPlaceholder("relative path").setValue(loc.rel).onChange((v) => {
        void this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === currentName);
          if (g !== undefined) g.path = joinLocation(splitLocation(g.path).location, v.trim());
        }, currentName);
      });
    }

    const line2 = panel.createDiv({ cls: "config-sync-form-line2" });
    new DropdownComponent(field(line2, "Type"))
      .addOption("file", "file")
      .addOption("dir", "dir")
      .setValue(group.type)
      .onChange(async (v) => {
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g === undefined) return;
          g.type = v as SyncGroup["type"];
          if (g.type !== "file") {
            delete g.mode;
            delete g.fields;
          }
        }, group.name);
        this.refresh();
      });
    new DropdownComponent(field(line2, "Devices"))
      .addOption("all", "all")
      .addOption("desktop", "desktop")
      .addOption("mobile", "mobile")
      .setValue(group.devices)
      .onChange(async (v) => {
        await this.commitGroups((draft) => {
          const g = draft.find((x) => x.name === group.name);
          if (g !== undefined) g.devices = v as DeviceClass;
        }, group.name);
        this.refresh();
      });
    this.renderModeSegment(field(line2, "Mode"), group, () => this.refresh());
    const descC = new TextComponent(field(line2, "Description"));
    descC.setPlaceholder("optional").setValue(group.description ?? "").onChange((v) => {
      const d = v.trim();
      void this.commitGroups((draft) => {
        const g = draft.find((x) => x.name === currentName);
        if (g === undefined) return;
        if (d !== "") g.description = d;
        else delete g.description;
      }, currentName);
    });
    if (group.mode === "fields") {
      this.renderFieldsEditor(panel.createDiv(), group, () => this.refresh());
    }
    this.renderDetectionNote(panel, group);
  }

  // Advanced-tab rule cards have no CatalogItem, so detection state isn't pre-fetched by
  // renderChecklistRow; kick off a scan here too (cached in the same map, keyed by group name).
  private renderDetectionNote(panel: HTMLElement, group: SyncGroup): void {
    const cached = this.detections.get(group.name);
    const noteEl = panel.createDiv({ cls: "config-sync-expand-note" });
    const show = (scan: SensitiveScan): void => {
      if (scan.keys.length === 0 && !scan.blob) return;
      noteEl.setText(scan.blob ? "⚠ opaque encrypted blob" : `⚠ Detected: ${scan.keys.join(", ")}`);
    };
    if (cached !== undefined) {
      show(cached);
      return;
    }
    void (async () => {
      let scan: SensitiveScan;
      try {
        scan = await this.host.detectSensitive(group);
      } catch {
        return;
      }
      this.detections.set(group.name, scan);
      if (noteEl.isConnected) show(scan);
    })();
  }

  private async commitGroups(mutator: (draft: SyncGroup[]) => void, culprit?: string): Promise<boolean> {
    // A blank "+ Add rule" placeholder (empty name) is in-memory only — never write it, so a
    // half-created rule can't fail validation and block every other save.
    const res = await commitDraft(this.groups, mutator, (g) => this.host.writeGroupsFile(g.filter((x) => x.name.trim() !== "")));
    if (res.ok) {
      this.groups = res.groups;
      this.groupsErrorMsg = "";
      this.saveErrorFor = "";
    } else {
      this.groupsErrorMsg = res.error;
      this.saveErrorFor = culprit !== undefined && culprit !== "" ? culprit : "";
    }
    // When the error is pinned to a specific row (inline), don't also show it at the page bottom.
    this.groupsErrorEl?.setText(this.saveErrorFor === "" ? this.groupsErrorMsg : "");
    return res.ok;
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
    row.setAttribute("data-search-anchor", `remote-${draft.name}`);
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
      this.sourcesErrorMsg = (e as Error).message;
    }
    this.sourcesErrorEl?.setText(this.sourcesErrorMsg);
  }
}
