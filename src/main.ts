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
  captureWithActions, CaptureItem,
  deviceExcludedPluginIds,
  groupsForDevice,
  loadLock,
  loadManifest,
  pushExternal,
  readGroups,
  writeGroups,
} from "./core/ConfigSyncCore";
import { createInstaller } from "./core/installer";
import { retry, HttpStatusError, TimeoutError, isRetryableError } from "./core/async";
import { RunRecord, RunKind, summarizeRun, pruneHistory } from "./core/runHistory";

// Keychain id for the passphrase (SecretStorage ids: lowercase alphanumerics and dashes).
const PASSPHRASE_SECRET_ID = "config-sync-passphrase";

// Structural view of app.secretStorage (Obsidian 1.12 / API 1.11.4): the plugin feature-detects
// it at runtime and keeps compiling for minAppVersion 1.8.7, so it deliberately references its
// own interface instead of the obsidian SecretStorage type (spec
// 2026-07-27-passphrase-keychain-design.md).
interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}
import { BratIndex, parseBratRepoList, resolveBratIndex } from "./core/bratIndex";
import { type CatalogSection, corePluginFile, displayLabelForGroup, findGroupByName, listBetaSections, listCoreSections, listDiscovered, listOptionSections, listPluginSections, SELF_GROUP_NAME, setCorePluginIds } from "./core/catalog";
import { Availability, availabilityForGroup, desktopOnlyDrift, desktopOnlyPluginIds, scopedAwayMembers, memberForceOff } from "./core/availability";
import { listFilesRecursive, isJunkPath, FileIO } from "./core/io";
import { leftoverStoreRels, storeSelfCopyGroups } from "./core/leftover";
import { parseStoreLock, validateSyncManifest } from "./core/manifest";
import { basename, groupRealPath, groupStorePath, sidecarStoreSuffix } from "./core/pathing";
import {
  buildItemDefs,
  CompileError,
  CustomGroupConfig,
  emptyItemConfig,
  enablementScopes,
  groupOwners,
  ItemConfig,
  ItemDef,
  compileItems,
  RegistryEnv,
} from "./core/registry";
import { isLegacySettings, mergeLegacyAppSliceItems, SCHEMA_UPGRADE_NOTICE } from "./core/settingsMigration";
import { applySwitchList, captureSwitchList, localRealPath, parseSwitchList, readLocalSwitchList, subtractForceOff, SWITCH_LIST_GROUPS, switchDivergence, SwitchList, writeLocalSwitchList } from "./core/switchList";
import { applyTransform, captureTransform, isWholeFileEncrypted, scanSensitive, SensitiveScan } from "./core/modes";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { pluginRuntimeEnabled } from "./core/pluginState";
import { syncListDelta } from "./core/syncListDelta";
import { selfPaneState } from "./core/selfPane";
import { bucketCounts, checkRemote, diffRemote, GroupStatus, remoteDirectionCounts, RemoteCheck, remoteLockAhead, statusForGroups } from "./core/status";
import { GroupResult, Remote, RibbonButtons, RuleScope, StoreLock, SyncGroup } from "./core/types";
import { presentedState } from "./ui/panelModel";
import { ConflictModal } from "./ui/ConflictModal";
import { renderStatusBarItem, statusBarSegments } from "./ui/statusBar";
import { SYNC_CENTER_VIEW_TYPE, SelfSyncInfo, SyncCenterHost, SyncCenterView } from "./ui/SyncCenterView";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

// Settings schema v2 (spec 2026-07-25-unified-card-design.md §6, D13): the sync list is no
// longer a stored SyncGroup[] — it is COMPILED (registry.ts's compileItems) from `items` on every
// load/save. `groups`/`memberScopes`/`memberLocal`/`appJsonTabs` (v1/v3-era) are gone entirely;
// there is no migration path from them — settingsMigration.ts's load gate blocks any data.json
// that isn't already schemaVersion 2.
interface ConfigSyncSettings {
  schemaVersion: 2;
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  remotes: Remote[];
  ribbonButtons: RibbonButtons;
  statusInMenu: boolean;
  statusBarItem: boolean; // master toggle for the status-bar item
  statusBarRemote: boolean; // include per-remote ⇡ push / ⇣ pull segments
  ribbonDot: boolean; // legacy corner dot on the ribbon icon (off by default since the status bar took over)
  mobileStatusBar: boolean; // force-show Obsidian's status bar on phones (CSS class only)
  remoteAutoCheck: boolean;
  localPeriodicCheck: boolean;
  items: Record<string, ItemConfig>; // item id (registry.ts) -> its own config; compiled to SyncGroup[] on load
  // Advanced tab "Custom rules"/"Discovered files" (spec §6 addition): these have no ItemDef, so
  // they're stored as their own SyncGroup literals rather than an ItemConfig — compileItems
  // (registry.ts) appends them to the compiled list on every load/save, same as everything else.
  customGroups: CustomGroupConfig[];
  bratPluginIndex: BratIndex; // plugin id -> "owner/repo"; derived from BRAT's synced list, synced too
  runHistory: RunHistorySettings; // local-only record of past runs; never synced
}

interface RunHistorySettings {
  enabled: boolean;
  path: string; // "" = default {configDir}/plugins/config-sync/run-history.json
  maxCount: number; // 0 = unlimited
  maxDays: number; // 0 = keep forever
}

const DEFAULT_SETTINGS: ConfigSyncSettings = {
  schemaVersion: 2,
  pkmMode: "auto",
  rootPath: "",
  remotes: [],
  ribbonButtons: { sync: false },
  statusInMenu: true,
  statusBarItem: true,
  statusBarRemote: true,
  ribbonDot: false,
  mobileStatusBar: false,
  remoteAutoCheck: true,
  localPeriodicCheck: true,
  items: {},
  customGroups: [],
  bratPluginIndex: {},
  runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
};

// config-sync's own registry item id (registry.ts: community plugin ids are prefixed "community:")
// — used by the self-propagation adopt flow to enable syncing config-sync's own settings.
const SELF_ITEM_ID = "community:config-sync";

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string; isDesktopOnly?: boolean }>;
  enabledPlugins: Set<string>;
  plugins: Record<string, unknown>; // currently loaded instances — diverges from enabledPlugins

  disablePlugin(id: string): Promise<void>;
  enablePlugin(id: string): Promise<void>;
  enablePluginAndSave(id: string): Promise<void>;
  loadManifests(): Promise<void>;
}

// BRAT's runtime surface, feature-detected everywhere — its internals are not a public API.
interface BratInstance {
  settings?: { pluginList?: unknown };
  betaPlugins?: {
    addPlugin?(
      repositoryPath: string,
      updatePluginVersion: boolean,
      seeIfUpdatedOnly: boolean,
      reportIfNotUpdated: boolean,
      specifyVersion: string,
      forceReinstall: boolean,
      enableAfterInstall: boolean,
      tokenName: string
    ): Promise<boolean>;
  };
}

// app.internalPlugins is not part of the public API; this is the community-standard access path for core plugins.
interface InternalPluginsRegistry {
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string }; enable(): Promise<void> }>;
}

export default class ConfigSyncPlugin extends Plugin {
  settings: ConfigSyncSettings = DEFAULT_SETTINGS;
  private individualRibbons: HTMLElement[] = [];
  private mainRibbonEl: HTMLElement | null = null;
  private statusBarEl: HTMLElement | null = null;
  private lastResolvedRoot: string | null = null;
  private installFn: PluginInstallFn | null = null;
  private installPhase: ((phase: string) => void) | undefined = undefined; // active item's phase callback (installs are sequential)

  // Races a promise against a timer. requestUrl (and BRAT's addPlugin) can't be aborted, so a
  // timed-out call keeps running detached but its result is discarded — the caller unblocks.
  private withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new TimeoutError(label, ms)), ms);
      work.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          window.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
    });
  }
  localStatuses: GroupStatus[] | null = null;
  private presentedStatuses: GroupStatus[] | null = null;
  private lastGroups: SyncGroup[] | null = null;
  // Compiled engine state (spec §6): the sync list is DERIVED from settings.items, never stored
  // directly. Recomputed on load and after every settings save (see saveSettings/recompile).
  private registryDefs: ItemDef[] = [];
  private compiledGroups: SyncGroup[] = [];
  remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
  private storeEventTimer: number | null = null;
  private remoteAutoCheckStartupTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.migratePassphraseToKeychain();
    setCorePluginIds(this.coreRuntime().map((c) => c.id));
    await this.recompile();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.registerView(SYNC_CENTER_VIEW_TYPE, (leaf) => new SyncCenterView(leaf, this.syncCenterHost()));
    this.mainRibbonEl = this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => void this.openSyncMenu(evt));
    this.refreshRibbons();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("config-sync-statusbar", "mod-clickable");
    this.registerDomEvent(this.statusBarEl, "click", () => void this.openSyncCenter());
    this.updateStatusIndicators();
    this.applyMobileStatusBar();
    this.addCommand({ id: "sync", name: "Sync: open the sync panel", callback: () => void this.openSyncCenter() });

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

  // Builds the item registry from the running Obsidian's actual state (core plugin ids + which
  // of them already have a settings file, installed community/beta plugins) and compiles it
  // against settings.items into the SyncGroup[] the existing capture/apply engine consumes.
  // Called on load and after every settings save (see saveSettings) so compiledGroups never goes
  // stale. A path-collision CompileError is surfaced as a Notice and leaves the PREVIOUS compiled
  // groups in place — a bad edit must never silently wipe out the working sync list.
  private async recompile(): Promise<void> {
    const env = await this.registryEnv();
    this.registryDefs = buildItemDefs(env);
    // Defense-in-depth (final-review fix): captured explicitly so "keep the last-good compiled
    // list on failure" is provable rather than incidental (mid-session this already happened by
    // omission — the catch branch never reassigned this.compiledGroups — but that's fragile to a
    // future refactor that adds a second assignment inside the try block). At first-load failure
    // there is no last-good yet, so this.compiledGroups correctly stays the constructor's `[]` —
    // the Notice below (naming the offending group/item via e.message) is what has to make that
    // failure actionable instead.
    const lastGoodGroups = this.compiledGroups;
    try {
      const compiled = compileItems(this.registryDefs, this.settings);
      // Safety net: compileItems is expected to always emit well-formed groups, but validating
      // here (the same check every hand-written config-sync.json goes through) catches a
      // registry bug before it reaches the capture/apply engine instead of failing obscurely.
      this.compiledGroups = validateSyncManifest({ version: 1, groups: compiled }).groups;
    } catch (e) {
      this.compiledGroups = lastGoodGroups;
      const reason = e instanceof Error ? e.message : String(e);
      if (e instanceof CompileError) {
        new Notice(`Config Sync: ${reason}`, 10000);
        return;
      }
      console.error("Config Sync: compiled sync groups failed validation", e);
      new Notice(`Config Sync: compiled sync configuration is invalid (${reason})`, 10000);
    }
  }

  private async registryEnv(): Promise<RegistryEnv> {
    const io = this.app.vault.adapter;
    const configDir = this.app.vault.configDir;
    const cores = await Promise.all(
      this.coreRuntime().map(async (c) => ({ id: c.id, name: c.name, fileExists: await io.exists(`${configDir}/${corePluginFile(c.id)}`) }))
    );
    const betaIds = new Set(Object.keys(this.settings.bratPluginIndex));
    return { cores, plugins: this.pluginRuntime().map((p) => ({ id: p.id, name: p.name, desktopOnly: p.desktopOnly })), betaIds };
  }

  onunload(): void {
    if (this.storeEventTimer !== null) window.clearTimeout(this.storeEventTimer);
    if (this.remoteAutoCheckStartupTimer !== null) window.clearTimeout(this.remoteAutoCheckStartupTimer);
    document.body.removeClass("config-sync-mobile-statusbar");
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
      const scoped = groupsForDevice(manifest, device);
      this.localStatuses = await statusForGroups(ctx, scoped);
      // Presented buckets for the ribbon dot: version-ahead in-sync items count as to-capture,
      // matching the panel (0.23.4/0.23.5) — no crypto cost, just a lock read.
      let lock: StoreLock | null = null;
      try {
        lock = await loadLock(ctx);
      } catch {
        lock = null;
      }
      const host = this.pluginHost();
      this.presentedStatuses = this.localStatuses.map((st) => {
        const g = scoped.find((x) => x.name === st.group);
        const drift = g !== undefined ? availabilityForGroup(g, host, lock).drift : null;
        return { ...st, state: presentedState(st.state, drift) };
      });
      await this.backfillLabels(ctx);
    } catch (e) {
      console.error("Config Sync: status refresh failed", e);
    }
    this.updateStatusIndicators();
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
    this.updateStatusIndicators();
    this.notifySyncCenter();
  }

  private notifySyncCenter(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SYNC_CENTER_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SyncCenterView) view.notifyExternalChange();
    }
  }

  updateStatusIndicators(): void {
    const s = this.presentedStatuses ?? this.localStatuses ?? [];
    const { up, down } = bucketCounts(s);
    const remoteStates = [...this.remoteChecks.values()].map((v) => v.check.state);
    const el = this.mainRibbonEl;
    if (el !== null) {
      const remoteNewer = remoteStates.some((st) => st === "remote-newer");
      el.toggleClass("config-sync-dot-capture", this.settings.ribbonDot && up > 0);
      el.toggleClass("config-sync-dot-apply", this.settings.ribbonDot && up === 0 && (down > 0 || remoteNewer));
      // aria-label stays "Config Sync" from addRibbonIcon — no pending-count suffix.
    }
    const sb = this.statusBarEl;
    if (sb !== null) {
      sb.toggle(this.settings.statusBarItem);
      renderStatusBarItem(sb, statusBarSegments({ up, down }, remoteDirectionCounts(remoteStates), this.settings.statusBarRemote));
    }
  }

  applyMobileStatusBar(): void {
    document.body.toggleClass("config-sync-mobile-statusbar", Platform.isMobile && this.settings.mobileStatusBar);
  }

  private async openSyncMenu(evt: MouseEvent): Promise<void> {
    // Never block the menu on a full status scan (each encrypted-fields item costs a PBKDF2
    // derivation): show last-known counts instantly, refresh in the background.
    if (this.settings.statusInMenu) void this.refreshLocalStatus(); // never throws
    const s = this.localStatuses ?? [];
    const { up, down } = bucketCounts(s);
    const menu = new Menu();
    // Force a DOM menu: on macOS (nativeMenus default) the ribbon menu would render as a native OS
    // menu, which cannot show the built-in or iconize command icons. DOM mode renders them; no-op on
    // mobile, where menus are already DOM.
    menu.setUseNativeMenu(false);
    const parts: string[] = [];
    if (this.settings.statusInMenu && up > 0) parts.push(`↑${up}`);
    if (this.settings.statusInMenu && down > 0) parts.push(`↓${down}`);
    const syncTitle = parts.length > 0 ? `Sync Center (${parts.join(" ")})` : "Sync Center";
    menu.addItem((i) => i.setTitle(syncTitle).setIcon("refresh-cw").onClick(() => void this.openSyncCenter()));
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
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        const availability: Record<string, Availability> = {};
        for (const g of groups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        // The status bar prefers presentedStatuses, which only refreshLocalStatus() used to
        // update — so a Sync Center recompute could leave the status bar rendering a stale
        // snapshot indefinitely (center "in sync", bar "↓2"). Keep both snapshots in step with
        // THIS compute, and only then repaint the indicators.
        this.presentedStatuses = statuses.map((st) => ({ ...st, state: presentedState(st.state, availability[st.group]?.drift ?? null) }));
        this.updateStatusIndicators();
        return { groups, statuses, availability };
      },
      selfStatus: async (): Promise<SelfSyncInfo> => {
        const ctx = await this.coreContext();
        const local = this.compiledGroups; // the full compiled list; `devices` gates applicability, not membership
        const selfCopy = `${ctx.rootPath}/store/configdir/plugins/config-sync/data.json`;
        const storeGroups = (await ctx.io.exists(selfCopy)) ? storeSelfCopyGroups(await ctx.io.read(selfCopy), this.registryDefs) : [];
        const delta = syncListDelta(local, storeGroups);
        let capturedAt: string | null = null;
        const lockPath = `${ctx.rootPath}/store.lock.json`;
        if (await ctx.io.exists(lockPath)) {
          try {
            capturedAt = parseStoreLock(await ctx.io.read(lockPath)).capturedAt;
          } catch {
            capturedAt = null; // an unreadable lock must not break the pane
          }
        }
        if (local.length === 0) return { state: "coldstart", delta, itemCount: storeGroups.length, capturedAt, contentChanged: false, versionRefresh: null, flagsRefresh: null };
        const selfGroup = local.find((g) => g.name === SELF_GROUP_NAME);
        if (selfGroup === undefined) return { state: "insync", delta, itemCount: local.length, capturedAt, contentChanged: false, versionRefresh: null, flagsRefresh: null };
        const [st] = await statusForGroups(ctx, [selfGroup]);
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        const av = availabilityForGroup(selfGroup, this.pluginHost(), lock);
        const flagsRefreshCount = desktopOnlyDrift(this.compiledGroups, this.pluginHost(), lock);
        const decided = selfPaneState({ isColdStart: false, groupState: st?.state, drift: av.drift, flagsDrift: flagsRefreshCount > 0 });
        const versionRefresh =
          decided.versionRefresh && av.localVersion !== null && av.storeVersion !== null ? { local: av.localVersion, store: av.storeVersion } : null;
        return { state: decided.state, delta, itemCount: local.length, capturedAt, contentChanged: decided.contentChanged, versionRefresh, flagsRefresh: flagsRefreshCount > 0 ? flagsRefreshCount : null };
      },
      resolvedPath: (g) => g.path.replace("{configDir}", this.app.vault.configDir),
      displayName: (g) => this.displayName(g, this.lastGroups?.find((x) => x.name === g)?.label),
      diffPair: async (name, rel, dir) => {
        try {
          const group = this.compiledGroups.find((g) => g.name === name);
          if (group === undefined || isWholeFileEncrypted(group)) return null;
          const io = this.app.vault.adapter;
          const real = localRealPath(name, group.path, this.app.vault.configDir);
          const rootPath = await this.resolvedRootPath();
          const storeBase = `${rootPath}/store/${groupStorePath(group.path)}`;
          const localPath = group.type === "file" ? real : `${real}/${rel}`;
          const storePath = group.type === "file" ? storeBase : `${storeBase}/${rel}`;
          const local = (await io.exists(localPath)) ? await io.read(localPath) : null;
          const store = (await io.exists(storePath)) ? await io.read(storePath) : null;
          const serialize = (v: SwitchList): string => JSON.stringify(v, null, 2) + "\n";
          const exc = SWITCH_LIST_GROUPS.has(name) ? ((await this.augmentedSwitchExceptions(rootPath))[name] ?? []) : [];
          const cls: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
          if (dir === "capture") {
            let produced = local ?? "";
            if (group.type === "file" && local !== null) {
              if (SWITCH_LIST_GROUPS.has(name)) {
                const l = readLocalSwitchList(name, local);
                if (l !== null) produced = serialize(captureSwitchList(l, store !== null ? parseSwitchList(store) : null, exc));
              } else if (group.mode === "fields") {
                produced = (await captureTransform(group, local, this.passphrase(), cls, store)).content;
              }
            }
            return { base: store ?? "", produced };
          }
          let produced = store ?? "";
          if (group.type === "file" && store !== null) {
            if (SWITCH_LIST_GROUPS.has(name)) {
              const st = parseSwitchList(store);
              if (st !== null) {
                const localList = local !== null ? readLocalSwitchList(name, local) : null;
                const merged = applySwitchList(st, localList, exc);
                const fo = SWITCH_LIST_GROUPS.has(name) ? this.memberForceOffIds(name) : [];
                produced = writeLocalSwitchList(name, subtractForceOff(merged, fo), local);
              }
            } else if (group.mode === "fields") {
              const sidecarPath = `${storeBase}${sidecarStoreSuffix(cls)}`;
              const ownScope = (await io.exists(sidecarPath)) ? await io.read(sidecarPath) : null;
              produced = await applyTransform(group, store, local, this.passphrase(), cls, ownScope);
            }
          }
          return { base: local ?? "", produced };
        } catch {
          return null; // e.g. passphrase needed for field encryption — no diff available
        }
      },
      switchLocalDecisions: (name) => (SWITCH_LIST_GROUPS.has(name) ? this.memberLocalFor(name) : []),
      betaIds: () => new Set(Object.keys(this.settings.bratPluginIndex)),
      runHistoryEnabled: () => this.settings.runHistory.enabled,
      loadRunHistory: () => this.loadRunHistory(),
      appendRunHistory: (kind, remote, results) => this.appendRunHistory(kind, remote, results),
      clearRunHistory: () => this.clearRunHistory(),
      stopSyncing: (groupName, deleteStore) => this.stopSyncing(groupName, deleteStore),
      storeFileCount: (groupName) => this.storeFileCount(groupName),
      listLeftoverStoreFiles: () => this.listLeftoverStoreFiles(),
      deleteLeftoverStoreFiles: (rels) => this.deleteLeftoverStoreFiles(rels),
      appendActionHistory: (entry) => this.appendActionHistory(entry),
      switchDivergenceFor: async (name) => {
        if (!SWITCH_LIST_GROUPS.has(name)) return null;
        const group = findGroupByName(this.compiledGroups, name);
        if (group === undefined) return null;
        try {
          const ctx = await this.coreContext();
          const real = localRealPath(name, group.path, ctx.configDir);
          const store = `${ctx.rootPath}/store/${groupStorePath(group.path)}`;
          if (!(await ctx.io.exists(real)) || !(await ctx.io.exists(store))) return null;
          const local = readLocalSwitchList(name, await ctx.io.read(real));
          const stored = parseSwitchList(await ctx.io.read(store));
          if (local === null || stored === null) return null;
          return switchDivergence(local, stored, ctx.switchExceptions[name] ?? []);
        } catch {
          return null;
        }
      },
      addSwitchExceptions: async (name, ids) => {
        // Schema v2 (spec §6): per-element enablement scope now lives on each plugin's own
        // ItemConfig.enabledOn, not a group-keyed memberLocal map — pin every named id to "local"
        // ("this device manages its own on/off") on its item.
        const carrier = name === "community-plugins" ? "community-plugins.json" : name === "core-plugins" ? "core-plugins.json" : null;
        if (carrier === null) return; // e.g. enabled-css-snippets: governed by its own perItem map, not this mechanism
        const prefix = carrier === "core-plugins.json" ? "core:" : "community:";
        const nextItems = { ...this.settings.items };
        for (const id of ids) {
          const itemId = `${prefix}${id}`;
          nextItems[itemId] = { ...(nextItems[itemId] ?? emptyItemConfig()), enabledOn: "local" };
        }
        this.settings.items = nextItems;
        await this.saveSettings();
        void this.refreshLocalStatus();
      },
      adoptConfiguration: async () => {
        try {
          // config-sync's own registry item (registry.ts builds one for every installed plugin,
          // itself included) compiles to the same legacy group name (SELF_GROUP_NAME) the self-
          // propagation apply below expects — enable it so compileItems actually emits that group.
          if (this.settings.items[SELF_ITEM_ID]?.enabled !== true) {
            this.settings.items = { ...this.settings.items, [SELF_ITEM_ID]: { ...(this.settings.items[SELF_ITEM_ID] ?? emptyItemConfig()), enabled: true } };
            await this.saveSettings(); // recompiles — compiledGroups now carries SELF_GROUP_NAME
          }
          const ctx = await this.coreContext();
          const results = await applyWithActions(ctx, [{ name: SELF_GROUP_NAME, action: "none" }], this.installPlugin());
          if (results.some((r) => r.group === SELF_GROUP_NAME && r.status !== "error")) {
            await this.reloadSettings(); // the apply rewrote our own settings file — pick up the adopted contract
          }
          await this.refreshLocalStatus();
          return results;
        } catch (e) {
          new Notice(`Config Sync adopt failed: ${(e as Error).message}`, 10000);
          return null;
        }
      },
      captureItems: async (items: CaptureItem[], onProgress?: ProgressFn) => {
        try {
          const ctx = await this.coreContext();
          const results = await captureWithActions(ctx, items, onProgress);
          // Background: the panel reloads and rescans anyway — blocking here just pins the
          // progress bar at N/N through a second full scan.
          void this.refreshLocalStatus();
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
            // The apply just rewrote this plugin's own settings file on disk — reload and
            // recompile before refreshing status so the running plugin picks up the new
            // contract (including its sync list) immediately.
            await this.reloadSettings();
          }
          void this.refreshLocalStatus(); // background — see captureItems
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
        const reader = await this.createReader(remote);
        const entries = await diffRemote(ctx, reader);
        // A lock-only delta (version-refresh capture on the other side) is real pull payload
        // even when every store file matches — surface it so the hint isn't contradictory.
        let lockDiffers = false;
        try {
          const remoteLock = (await reader.listFiles()).includes("store.lock.json") ? await reader.readFile("store.lock.json") : null;
          const localLock = (await ctx.io.exists(`${ctx.rootPath}/store.lock.json`)) ? await ctx.io.read(`${ctx.rootPath}/store.lock.json`) : null;
          lockDiffers = remoteLockAhead(localLock, remoteLock);
        } catch {
          lockDiffers = false;
        }
        return { entries, lockDiffers };
      },
      pullFrom: async (remote) => {
        try {
          const ctx = await this.coreContext();
          const pending = await planImport(ctx, await this.createReader(remote));
          // Pull resolves file conflicts only; sync-list (definition) conflicts are no longer
          // applied by Pull, so they don't prompt — the list converges via adopt.
          const fileConflicts = pending.plan.conflicts.filter((c) => c.kind === "file");
          if (fileConflicts.length > 0) {
            const modalPending = { ...pending, plan: { ...pending.plan, conflicts: fileConflicts } };
            // Conflicted pull: pause for git-style resolution. Nothing has been written
            // (planImport is read-only); Cancel keeps it that way — all-or-nothing.
            const choices = await new Promise<("local" | "remote")[] | null>((resolve) => {
              new ConflictModal(
                this.app,
                modalPending,
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
            const results = await applyImport(ctx, modalPending, choices);
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

  private pluginRuntime(): { id: string; name: string; enabled: boolean; desktopOnly: boolean }[] {
    const reg = this.pluginRegistry();
    return Object.values(reg.manifests).map((m) => ({ id: m.id, name: m.name, enabled: pluginRuntimeEnabled(reg, m.id), desktopOnly: m.isDesktopOnly === true }));
  }

  private pkmProbe(): PkmProbe {
    const registry = this.pluginRegistry();
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      isPluginEnabled: (id) => pluginRuntimeEnabled(registry, id),
    };
  }

  // app.secretStorage shipped with Obsidian 1.12 — on an older install the property is simply
  // absent at runtime, and pre-1.12 installs take the localStorage fallback below.
  private secretStore(): SecretStore | null {
    return (this.app as unknown as { secretStorage?: SecretStore }).secretStorage ?? null;
  }

  passphraseKeychainBacked(): boolean {
    return this.secretStore() !== null;
  }

  // The passphrase lives encrypted in Obsidian's keychain when this install has one, and falls
  // back to plain per-vault localStorage on older installs (spec
  // 2026-07-27-passphrase-keychain-design.md). "" means "not set" in both stores — clearing
  // writes "" to the keychain because the public SecretStorage API has no delete.
  passphrase(): string | null {
    const ss = this.secretStore();
    if (ss !== null) {
      const v = ss.getSecret(PASSPHRASE_SECRET_ID);
      return v === null || v === "" ? null : v;
    }
    const v: unknown = this.app.loadLocalStorage("config-sync-passphrase");
    return typeof v === "string" && v !== "" ? v : null;
  }

  setPassphrase(v: string | null): void {
    const ss = this.secretStore();
    if (ss !== null) {
      ss.setSecret(PASSPHRASE_SECRET_ID, v ?? "");
      return;
    }
    this.app.saveLocalStorage("config-sync-passphrase", v === "" ? null : v);
  }

  // One-time move of a pre-1.12 plaintext passphrase into the keychain: runs only when this
  // install has a keychain AND a plaintext copy exists; an already-set keychain value wins, and
  // the plaintext copy is removed either way.
  private migratePassphraseToKeychain(): void {
    const ss = this.secretStore();
    if (ss === null) return;
    const plain: unknown = this.app.loadLocalStorage("config-sync-passphrase");
    if (typeof plain !== "string" || plain === "") return;
    const existing = ss.getSecret(PASSPHRASE_SECRET_ID);
    if (existing === null || existing === "") ss.setSecret(PASSPHRASE_SECRET_ID, plain);
    this.app.saveLocalStorage("config-sync-passphrase", null);
  }

  private pluginHost(): PluginHost {
    const registry = this.pluginRegistry();
    return {
      getInstalledPluginVersion: (id) => registry.manifests[id]?.version ?? null,
      isDesktopOnly: (id) => registry.manifests[id]?.isDesktopOnly === true,
      isPluginEnabled: (id) => pluginRuntimeEnabled(registry, id),
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
      // requestUrl has no timeout — a stalled download would hang the whole sequential
      // install run. Bound each attempt (30s) and retry idempotent downloads; a 4xx fails
      // fast (won't ever succeed), a timeout/5xx/network error retries before giving up.
      const catalogInstall = createInstaller(this.app.vault.adapter, this.app.vault.configDir, (url) =>
        retry(
          async () => {
            const res = await this.withTimeout(requestUrl({ url, throw: false }), 30_000, url);
            if (res.status >= 200 && res.status < 300) return res.arrayBuffer;
            throw new HttpStatusError(res.status);
          },
          { attempts: 3, retryable: isRetryableError, onAttempt: (n) => this.installPhase?.(`download failed — retrying (${n}/3)…`) }
        )
      );
      // Resolution order (spec C4): BRAT index → community catalog. An unmapped id gets one
      // last-chance index refresh before falling back to the catalog path.
      this.installFn = async (id: string, onPhase?: (phase: string) => void, targetVersion?: string): Promise<string> => {
        // Installs run strictly sequentially, so a single field safely carries the active
        // item's phase callback into the retry closures (catalog download / BRAT).
        this.installPhase = onPhase;
        if (this.settings.bratPluginIndex[id] === undefined) await this.refreshBratIndex();
        const repo = this.settings.bratPluginIndex[id];
        if (repo !== undefined) {
          // BRAT-managed plugins track their own beta channel — version-pinning applies to the
          // community-catalog path only (spec C).
          onPhase?.("downloading via BRAT…");
          return this.installViaBrat(id, repo);
        }
        onPhase?.("downloading from the community catalog…");
        return catalogInstall(id, targetVersion);
      };
    }
    return this.installFn;
  }

  // ── Run history (local-only, never synced) ──────────────────────────────────────────────
  private runHistoryPath(): string {
    const custom = this.settings.runHistory.path.trim();
    return custom !== "" ? custom : `${this.app.vault.configDir}/plugins/config-sync/run-history.json`;
  }

  async loadRunHistory(): Promise<RunRecord[]> {
    const path = this.runHistoryPath();
    if (!(await this.app.vault.adapter.exists(path))) return [];
    let records: RunRecord[];
    try {
      records = JSON.parse(await this.app.vault.adapter.read(path)) as RunRecord[];
    } catch {
      return []; // a corrupt history file must not break the panel
    }
    const { maxCount, maxDays } = this.settings.runHistory;
    return pruneHistory(records, maxCount, maxDays, Date.now());
  }

  async appendRunHistory(kind: RunKind, remote: string | null, results: GroupResult[]): Promise<void> {
    if (!this.settings.runHistory.enabled) return;
    const record = summarizeRun(Date.now(), kind, remote, results);
    const existing = await this.loadRunHistory();
    const { maxCount, maxDays } = this.settings.runHistory;
    const next = pruneHistory([record, ...existing], maxCount, maxDays, Date.now());
    await this.writeRunHistory(next);
  }

  async clearRunHistory(): Promise<void> {
    await this.writeRunHistory([]);
  }

  // Removal/cleanup actions (Stop syncing, delete leftover) — no GroupResults, always "ok".
  async appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void> {
    if (!this.settings.runHistory.enabled) return;
    const record: RunRecord = {
      at: Date.now(),
      kind: entry.kind,
      remote: null,
      status: "ok",
      changed: entry.changed,
      issues: 0,
      desc: entry.desc,
      results: [],
      removed: entry.removed,
      deletedFiles: entry.deletedFiles,
    };
    const { maxCount, maxDays } = this.settings.runHistory;
    await this.writeRunHistory(pruneHistory([record, ...(await this.loadRunHistory())], maxCount, maxDays, Date.now()));
  }

  private async writeRunHistory(records: RunRecord[]): Promise<void> {
    const path = this.runHistoryPath();
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent !== "" && !(await this.app.vault.adapter.exists(parent))) {
      await this.app.vault.adapter.mkdir(parent);
    }
    await this.app.vault.adapter.write(path, JSON.stringify(records, null, 2) + "\n");
  }

  private bratInstance(): BratInstance | null {
    const reg = (this.app as unknown as { plugins: { plugins: Record<string, unknown>; enabledPlugins: Set<string> } }).plugins;
    if (!pluginRuntimeEnabled(reg, "obsidian42-brat")) return null;
    return (reg.plugins["obsidian42-brat"] as BratInstance | undefined) ?? null;
  }

  private async installViaBrat(id: string, repo: string): Promise<string> {
    const beta = this.bratInstance()?.betaPlugins;
    if (beta === undefined || typeof beta.addPlugin !== "function") {
      throw new Error(`"${id}" is managed by BRAT (${repo}) — enable BRAT and retry, or run BRAT's update command`);
    }
    const addPlugin = beta.addPlugin.bind(beta);
    // addPlugin(repo, updatePluginFiles, seeIfUpdatedOnly, reportIfNotUpdated, specifyVersion,
    // forceReinstall, enableAfterInstall, secretName). Use BRAT's *install* path
    // (updatePluginFiles=false, forceReinstall=true) — the one BRAT's own "Add/Change version" UI
    // uses and that installs on mobile. The *update* path (updatePluginFiles=true) fails on mobile
    // with "JSON Parse error: Unexpected EOF" (a fetch there returns an empty body on mobile);
    // desktop can't reproduce it since both paths succeed there. forceReinstall keeps the
    // idempotent re-download the retry/timeout wrapper relies on; enableAfterInstall stays false —
    // enabling is config-sync's own On-apply decision.
    const ok = await retry(
      () => this.withTimeout(addPlugin(repo, false, false, false, "", true, false, ""), 30_000, repo),
      { attempts: 3, retryable: isRetryableError, onAttempt: (n) => this.installPhase?.(`BRAT install failed — retrying (${n}/3)…`) }
    );
    await this.pluginHost().reloadPluginManifests();
    const version = this.pluginHost().getInstalledPluginVersion(id);
    if (!ok || version === null) {
      throw new Error(`BRAT could not install ${repo} — see BRAT's log for the reason`);
    }
    return version;
  }

  // BRAT's repo list: live instance first, its data.json on disk second (BRAT disabled), [] when absent.
  private async bratRepos(): Promise<string[]> {
    const live = this.bratInstance()?.settings?.pluginList;
    if (Array.isArray(live)) return live.filter((r): r is string => typeof r === "string");
    const path = `${this.app.vault.configDir}/plugins/obsidian42-brat/data.json`;
    if (!(await this.app.vault.adapter.exists(path))) return [];
    return parseBratRepoList(await this.app.vault.adapter.read(path));
  }

  // Fill + prune the id→repo index (spec C1). Never runs during capture; triggered by the Beta
  // tab, its ↻ Re-scan, or an install for an unmapped id. Returns {resolved, total} for the UI.
  async refreshBratIndex(): Promise<{ resolved: number; total: number }> {
    const repos = await this.bratRepos();
    const next = await resolveBratIndex(this.settings.bratPluginIndex, repos, async (repo) => {
      try {
        const res = await requestUrl({ url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`, throw: true });
        return res.text;
      } catch {
        return null;
      }
    });
    if (JSON.stringify(next) !== JSON.stringify(this.settings.bratPluginIndex)) {
      this.settings.bratPluginIndex = next;
      await this.saveSettings();
    }
    return { resolved: Object.keys(next).length, total: repos.length };
  }

  displayName(group: string, storedLabel?: string): string {
    return displayLabelForGroup(group, this.pluginHost(), storedLabel);
  }

  // The plugin's own data.json must not be written through the raw adapter: Obsidian watches
  // the plugins folder and reloads Config Sync on an external write, wiping the Sync Center
  // mid-adopt/apply. Routing it through saveData (an internal save) writes the same file with
  // no reload. Everything else delegates to the vault adapter.
  private configIO(): FileIO {
    const a = this.app.vault.adapter;
    const selfData = `${this.app.vault.configDir}/plugins/config-sync/data.json`;
    return {
      read: (p) => a.read(p),
      write: async (p, data) => {
        if (p === selfData) {
          await this.saveData(JSON.parse(data));
          return;
        }
        await a.write(p, data);
      },
      exists: (p) => a.exists(p),
      remove: (p) => a.remove(p),
      rename: (p, np) => a.rename(p, np),
      rmdir: (p, r) => a.rmdir(p, r),
      mkdir: (p) => a.mkdir(p),
      list: (p) => a.list(p),
      stat: (p) => a.stat(p),
    };
  }

  // Carrier name -> registry carrier file (spec §3/§4, D4/D5): the two real switch-list groups
  // map onto their enablement carrier; anything else (e.g. enabled-css-snippets, a v3-era switch
  // list superseded by a plain perItem key on the compiled "appearance" group — see registry.ts)
  // has no items-backed carrier under schema v2.
  private carrierFor(group: string): "core-plugins.json" | "community-plugins.json" | null {
    if (group === "core-plugins") return "core-plugins.json";
    if (group === "community-plugins") return "community-plugins.json";
    return null;
  }

  private enablementScopesFor(group: string): Record<string, RuleScope> {
    const carrier = this.carrierFor(group);
    return carrier === null ? {} : enablementScopes(this.registryDefs, this.settings, carrier);
  }

  private memberScopesFor(group: string): Record<string, "desktop" | "mobile"> {
    const out: Record<string, "desktop" | "mobile"> = {};
    for (const [id, scope] of Object.entries(this.enablementScopesFor(group))) {
      if (scope === "desktop" || scope === "mobile") out[id] = scope;
    }
    return out;
  }

  private memberLocalFor(group: string): string[] {
    return Object.entries(this.enablementScopesFor(group))
      .filter(([, scope]) => scope === "local")
      .map(([id]) => id);
  }

  // The runtime mask per switch group = This-device ids (memberLocal) ∪ ids class-scoped away
  // from this device (memberScopes) ∪ auto-derived exclusions (community-plugins only:
  // desktop-only manifest ids on mobile, plus plugin groups with a non-matching devices class).
  // Masked ids pass through at capture, keep local state on apply, and are hidden from in-sync
  // comparison. The persisted settings are left untouched.
  private async augmentedSwitchExceptions(rootPath: string): Promise<Record<string, string[]>> {
    const device: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    const derived = deviceExcludedPluginIds(this.compiledGroups, device);
    if (Platform.isMobile) {
      const io = this.configIO();
      const lockPath = `${rootPath}/store.lock.json`;
      let lock: StoreLock | null = null;
      if (await io.exists(lockPath)) {
        try {
          lock = parseStoreLock(await io.read(lockPath));
        } catch {
          lock = null;
        }
      }
      for (const id of desktopOnlyPluginIds(this.compiledGroups, this.pluginHost(), lock)) derived.add(id);
    }
    const out: Record<string, string[]> = {};
    for (const name of SWITCH_LIST_GROUPS) {
      const scoped = scopedAwayMembers(this.memberScopesFor(name), Platform.isMobile);
      const auto = name === "community-plugins" ? derived : new Set<string>();
      const mask = [...new Set([...this.memberLocalFor(name), ...scoped, ...auto])];
      if (mask.length > 0) out[name] = mask;
    }
    return out;
  }

  // Force-off = user class scopes enforced on the wrong device class, minus This-device ids
  // (local wins). Auto-derived exclusions are never forced off — they keep local state.
  private memberForceOffIds(group: string): string[] {
    return memberForceOff(this.memberScopesFor(group), this.memberLocalFor(group), Platform.isMobile);
  }

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    const switchExceptions = await this.augmentedSwitchExceptions(rootPath);
    return {
      io: this.configIO(),
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: this.pluginHost(),
      passphrase: this.passphrase(),
      deviceClass: Platform.isMobile ? "mobile" : "desktop",
      switchExceptions,
      switchForceOff: (() => {
        const out: Record<string, string[]> = {};
        for (const name of SWITCH_LIST_GROUPS) {
          const f = this.memberForceOffIds(name);
          if (f.length > 0) out[name] = f;
        }
        return out;
      })(),
      // No fieldOverlay: compileItems (registry.ts) already merges every app-slice card's rules
      // into the compiled "app" group at settings-compile time — the v3-era runtime overlay
      // (appTabRules/appTabsNonDefault, src/core/appTabs.ts) is superseded and removed.
      groupsIO: {
        read: async () => this.compiledGroups,
        // Under schema v2 the sync list is DERIVED from settings.items/settings.customGroups, not
        // stored directly, so a raw group-list write has no durable home. The only remaining caller
        // is stopSyncing's fallback for a group with no known owner (the hidden aggregate carrier
        // groups) — kept in memory for the rest of the session, never a source of data loss, just
        // non-persistence across a reload.
        write: async (groups) => {
          this.compiledGroups = groups;
        },
      },
      now: () => new Date().toISOString(),
    };
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

  // ── Stop syncing + store leftover cleanup ───────────────────────────────────────────────
  private groupStoreAbs(ctx: CoreContext, group: SyncGroup): string {
    return `${ctx.rootPath}/store/${groupStorePath(group.path)}`;
  }

  // Returns the store paths it deleted (display form, no "store/" prefix) so the caller can
  // record them in run history; empty when deleteStore is false or there was no store data.
  async stopSyncing(groupName: string, deleteStore: boolean): Promise<string[]> {
    const group = this.compiledGroups.find((g) => g.name === groupName);
    let deleted: string[] = [];
    if (deleteStore && group !== undefined) {
      const ctx = await this.coreContext();
      const abs = this.groupStoreAbs(ctx, group);
      if (await ctx.io.exists(abs)) {
        const rel = `store/${groupStorePath(group.path)}`;
        if (group.type === "dir") {
          deleted = (await listFilesRecursive(ctx.io, abs)).filter((f) => !isJunkPath(f)).map((f) => f.slice(ctx.rootPath.length + 1).slice("store/".length));
          await ctx.io.rmdir(abs, true);
        } else {
          deleted = [rel.slice("store/".length)];
          await ctx.io.remove(abs);
        }
      }
    }
    // Durable: flip the owning item(s)' enabled flag (or, for a companion group, just that one
    // companion entry's enabled flag) in settings.items — or, for a custom group (Advanced tab
    // "Custom rules"/"Discovered files"), remove its settings.customGroups entry entirely, since
    // it has no "enabled" flag to flip — and save. saveSettings persists and recompiles, so the
    // group stays gone across the next settings save instead of being resurrected by an
    // in-memory-only groupsIO write (see coreContext()'s groupsIO comment). Any group name with no
    // known owner (e.g. a future/unrecognized group) falls back to the old in-memory write rather
    // than silently doing nothing.
    const owners = groupOwners(this.registryDefs, this.settings.customGroups)[groupName];
    if (owners !== undefined && owners.length > 0) {
      const nextItems = { ...this.settings.items };
      let nextCustomGroups = this.settings.customGroups;
      for (const owner of owners) {
        if (owner.custom === true) {
          nextCustomGroups = nextCustomGroups.filter((g) => g.name !== groupName);
          continue;
        }
        const cfg = nextItems[owner.itemId] ?? emptyItemConfig();
        nextItems[owner.itemId] =
          owner.companionPath !== undefined
            ? { ...cfg, companions: cfg.companions.map((c) => (c.path === owner.companionPath ? { ...c, enabled: false } : c)) }
            : { ...cfg, enabled: false };
      }
      this.settings.items = nextItems;
      this.settings.customGroups = nextCustomGroups;
      await this.saveSettings();
    } else {
      await this.writeGroupsFile(this.compiledGroups.filter((g) => g.name !== groupName));
    }
    return deleted;
  }

  async storeFileCount(groupName: string): Promise<number> {
    const group = this.compiledGroups.find((g) => g.name === groupName);
    if (group === undefined) return 0;
    const ctx = await this.coreContext();
    const abs = this.groupStoreAbs(ctx, group);
    if (!(await ctx.io.exists(abs))) return 0;
    if (group.type === "dir") return (await listFilesRecursive(ctx.io, abs)).filter((f) => !isJunkPath(f)).length;
    return 1;
  }

  async listLeftoverStoreFiles(): Promise<{ rel: string; name: string; path: string; size: number }[]> {
    const ctx = await this.coreContext();
    if (!(await ctx.io.exists(ctx.rootPath))) return [];
    const files = (await listFilesRecursive(ctx.io, ctx.rootPath)).filter((f) => !isJunkPath(f));
    const rels = files.map((f) => f.slice(ctx.rootPath.length + 1));
    // Files the store's own sync list defines but this device hasn't adopted yet are pending, not
    // leftover — union the local list with the store self-copy's list so a pull can't leave
    // just-arrived data looking like deletable junk.
    const selfCopy = `${ctx.rootPath}/store/configdir/plugins/config-sync/data.json`;
    const storeGroups = (await ctx.io.exists(selfCopy)) ? storeSelfCopyGroups(await ctx.io.read(selfCopy), this.registryDefs) : [];
    const out: { rel: string; name: string; path: string; size: number }[] = [];
    for (const lf of leftoverStoreRels(rels, [...this.compiledGroups, ...storeGroups])) {
      const st = await this.app.vault.adapter.stat(`${ctx.rootPath}/${lf.rel}`);
      out.push({ ...lf, size: st?.size ?? 0 });
    }
    return out;
  }

  async deleteLeftoverStoreFiles(rels: string[]): Promise<void> {
    const ctx = await this.coreContext();
    for (const rel of rels) {
      const abs = `${ctx.rootPath}/${rel}`;
      if (await ctx.io.exists(abs)) await ctx.io.remove(abs);
    }
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
    return listPluginSections(this.pluginRuntime(), groups, new Set(Object.keys(this.settings.bratPluginIndex)));
  }

  async listBetaSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listBetaSections(this.pluginRuntime(), groups, this.settings.bratPluginIndex);
  }

  // Local-only status for the Beta tab's map-note (no network): index size vs BRAT's list.
  async bratScanStatus(): Promise<{ resolved: number; total: number }> {
    const repos = await this.bratRepos();
    const resolved = Object.values(this.settings.bratPluginIndex).filter((r) => repos.includes(r)).length;
    return { resolved, total: repos.length };
  }

  installedPluginIds(): string[] {
    return Object.values(this.pluginRegistry().manifests).map((m) => m.id);
  }

  // The registry defs the unified-card renderer (SettingTab.ts) builds the Obsidian tab from —
  // the same list recompile() just derived (registryDefs), never rebuilt separately, so the
  // panel can never disagree with the compiled sync list about which cards exist.
  itemDefs(): ItemDef[] {
    return this.registryDefs;
  }

  async listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]> {
    return listDiscovered(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  // Basenames (no extension) of .css files actually present under snippets/ — feeds the
  // Appearance card's snippets companion member rows (spec §4/§5); reuses the same directory
  // scan snippetUniverse() already does for the old switch-list drawer.
  async listSnippetFiles(): Promise<string[]> {
    return (await this.snippetUniverse()).fromDir;
  }

  // Immediate child file/folder names of a companion path — plain (non-mapKey) companion member
  // listing (spec §4 "成员行"; task-7-brief.md). No per-member scope: an arbitrary "dir" SyncGroup
  // has no per-file carry-scope mechanism today (only the three named switch lists in
  // SWITCH_LIST_GROUPS do), so this is informational-only, unlike listSnippetFiles above.
  async listCompanionFiles(path: string): Promise<string[]> {
    const io = this.app.vault.adapter;
    const real = groupRealPath(path, this.app.vault.configDir);
    if (!(await io.exists(real))) return [];
    const listed = await io.list(real);
    return [...listed.files, ...listed.folders].map((p) => basename(p)).filter((n) => !isJunkPath(n));
  }

  private async snippetUniverse(): Promise<{ fromDir: string[]; store: string[]; local: string[]; storeFiles: string[] }> {
    const io = this.app.vault.adapter;
    const cfg = this.app.vault.configDir;
    const readArr = async (p: string): Promise<string[]> => {
      try {
        if (!(await io.exists(p))) return [];
        const parsed = parseSwitchList(await io.read(p));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    const files = (await io.exists(`${cfg}/snippets`)) ? (await io.list(`${cfg}/snippets`)).files : [];
    const fromDir = files.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
    const appList = (await io.exists(`${cfg}/appearance.json`)) ? readLocalSwitchList("enabled-css-snippets", await io.read(`${cfg}/appearance.json`)) : [];
    const local = Array.isArray(appList) ? appList : [];
    const root = await this.resolvedRootPath();
    const store = await readArr(`${root}/store/${groupStorePath("{configDir}/enabled-css-snippets.json")}`);
    const storeSnips = `${root}/store/${groupStorePath("{configDir}/snippets")}`;
    const storeFileList = (await io.exists(storeSnips)) ? (await io.list(storeSnips)).files : [];
    const storeFiles = storeFileList.filter((f) => f.endsWith(".css")).map((f) => basename(f).replace(/\.css$/, ""));
    return { fromDir, store, local, storeFiles };
  }

  async readItemFile(group: SyncGroup): Promise<string | null> {
    const io = this.app.vault.adapter;
    const real = localRealPath(group.name, group.path, this.app.vault.configDir);
    if (group.type !== "file" || !(await io.exists(real))) return null;
    try {
      const content = await io.read(real);
      if (group.name === "enabled-css-snippets") {
        const list = readLocalSwitchList(group.name, content);
        return list !== null ? JSON.stringify(list, null, 2) + "\n" : null;
      }
      return content;
    } catch {
      return null;
    }
  }

  async detectSensitive(group: SyncGroup): Promise<SensitiveScan> {
    const io = this.app.vault.adapter;
    const real = localRealPath(group.name, group.path, this.app.vault.configDir);
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
      if (group.name === "enabled-css-snippets") {
        const list = readLocalSwitchList(group.name, content);
        if (list === null) continue;
        content = JSON.stringify(list);
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

  // Schema v2 blocking gate (spec §6, D13): a data.json without schemaVersion 2 (the old
  // groups-based shape, or anything unversioned) is never migrated field-by-field — the plugin
  // starts fresh with defaults and asks the user to reconfigure. A fresh install (no data.json
  // yet) is NOT legacy; it just gets the defaults silently.
  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Record<string, unknown> | null;
    if (isLegacySettings(data)) {
      new Notice(SCHEMA_UPGRADE_NOTICE, 10000);
      this.settings = { ...DEFAULT_SETTINGS };
      return;
    }
    // Quick commands moved to the Ribbon Organizer plugin in 1.7.0; drop the stale key so the
    // next save cleans data.json.
    if (data !== null) delete data.quickCommands;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data as Partial<ConfigSyncSettings> | null);
    // v2 shape revision (spec 2026-07-26-ui-feedback-round2-design.md §2.3): merge legacy
    // editor/files-links/other + appJson into items.app before anything compiles the settings
    // that just loaded. `data` may still carry the pre-merge `appJson` key even though it's no
    // longer part of ConfigSyncSettings — Object.assign copied it onto this.settings above.
    if (mergeLegacyAppSliceItems(this.settings)) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    await this.recompile();
  }

  // Reloads settings from disk and recompiles immediately — the shared shape for "something just
  // rewrote our own data.json externally and compiledGroups must reflect it right now" (a
  // self-group apply, see adoptConfiguration/applyItems). loadSettings() alone leaves
  // compiledGroups stale until the next unrelated saveSettings() or a restart.
  private async reloadSettings(): Promise<void> {
    await this.loadSettings();
    await this.recompile();
  }
}
