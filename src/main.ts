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
  groupsForDevice,
  loadLock,
  loadManifest,
  pushExternal,
  readGroups,
  revertLastApply,
  writeGroups,
} from "./core/ConfigSyncCore";
import { createInstaller } from "./core/installer";
import { retry, HttpStatusError, TimeoutError, isRetryableError } from "./core/async";
import { RunRecord, RunKind, summarizeRun, pruneHistory } from "./core/runHistory";
import { BratIndex, parseBratRepoList, resolveBratIndex } from "./core/bratIndex";
import { type CatalogSection, displayLabelForGroup, ensureSelfPresets, findGroupByName, groupForItem, listBetaSections, listCoreSections, listDiscovered, listOptionSections, listPluginSections, SELF_GROUP_NAME, setCorePluginIds } from "./core/catalog";
import { Availability, availabilityForGroup } from "./core/availability";
import { listFilesRecursive, isJunkPath, FileIO } from "./core/io";
import { leftoverStoreRels } from "./core/leftover";
import { ManifestValidationError, migrateLegacyManifest, parseStoreLock, validateSyncManifest } from "./core/manifest";
import { groupRealPath, groupStorePath } from "./core/pathing";
import { applySwitchList, captureSwitchList, parseSwitchList, SWITCH_LIST_GROUPS, switchDivergence, SwitchList } from "./core/switchList";
import { applyTransform, captureTransform, scanSensitive, SensitiveScan } from "./core/modes";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { pluginRuntimeEnabled } from "./core/pluginState";
import { bucketCounts, checkRemote, diffRemote, GroupStatus, RemoteCheck, remoteLockAhead, statusForGroups } from "./core/status";
import { GroupResult, Remote, RibbonButtons, StoreLock, SyncGroup } from "./core/types";
import { presentedState } from "./ui/panelModel";
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
  switchExceptions: Record<string, string[]>; // group name -> excepted plugin/core ids (device-local)
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
  pkmMode: "auto",
  rootPath: "",
  remotes: [],
  ribbonButtons: { sync: false, revert: false },
  statusInMenu: true,
  remoteAutoCheck: true,
  localPeriodicCheck: true,
  groups: [],
  switchExceptions: {},
  bratPluginIndex: {},
  runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
};

// app.plugins is not part of the public API; this is the community-standard access path.
interface CommunityPluginRegistry {
  manifests: Record<string, { id: string; name: string; version: string }>;
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
    const s = this.presentedStatuses ?? this.localStatuses ?? [];
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
    // Never block the menu on a full status scan (each encrypted-fields item costs a PBKDF2
    // derivation): show last-known counts instantly, refresh in the background.
    if (this.settings.statusInMenu) void this.refreshLocalStatus(); // never throws
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
      diffPair: async (name, rel, dir) => {
        try {
          const group = this.settings.groups.find((g) => g.name === name);
          if (group === undefined || group.mode === "encrypted") return null;
          const io = this.app.vault.adapter;
          const real = groupRealPath(group.path, this.app.vault.configDir);
          const storeBase = `${await this.resolvedRootPath()}/store/${groupStorePath(group.path)}`;
          const localPath = group.type === "file" ? real : `${real}/${rel}`;
          const storePath = group.type === "file" ? storeBase : `${storeBase}/${rel}`;
          const local = (await io.exists(localPath)) ? await io.read(localPath) : null;
          const store = (await io.exists(storePath)) ? await io.read(storePath) : null;
          const serialize = (v: SwitchList): string => JSON.stringify(v, null, 2) + "\n";
          const exc = SWITCH_LIST_GROUPS.has(name) ? (this.settings.switchExceptions[name] ?? []) : [];
          if (dir === "capture") {
            let produced = local ?? "";
            if (group.type === "file" && local !== null) {
              if (SWITCH_LIST_GROUPS.has(name)) {
                const l = parseSwitchList(local);
                if (l !== null) produced = serialize(captureSwitchList(l, store !== null ? parseSwitchList(store) : null, exc));
              } else if (group.mode === "fields") {
                produced = (await captureTransform(group, local, this.passphrase())).content;
              }
            }
            return { base: store ?? "", produced };
          }
          let produced = store ?? "";
          if (group.type === "file" && store !== null) {
            if (SWITCH_LIST_GROUPS.has(name)) {
              const st = parseSwitchList(store);
              if (st !== null) produced = serialize(applySwitchList(st, local !== null ? parseSwitchList(local) : null, exc));
            } else if (group.mode === "fields") {
              produced = await applyTransform(group, store, local, this.passphrase());
            }
          }
          return { base: local ?? "", produced };
        } catch {
          return null; // e.g. passphrase needed for field encryption — no diff available
        }
      },
      switchLocalDecisions: (name) => (SWITCH_LIST_GROUPS.has(name) ? this.settings.switchExceptions[name] ?? [] : []),
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
        const group = findGroupByName(this.settings.groups, name);
        if (group === undefined) return null;
        try {
          const ctx = await this.coreContext();
          const real = groupRealPath(group.path, ctx.configDir);
          const store = `${ctx.rootPath}/store/${groupStorePath(group.path)}`;
          if (!(await ctx.io.exists(real)) || !(await ctx.io.exists(store))) return null;
          const local = parseSwitchList(await ctx.io.read(real));
          const stored = parseSwitchList(await ctx.io.read(store));
          if (local === null || stored === null) return null;
          return switchDivergence(local, stored, this.settings.switchExceptions[name] ?? []);
        } catch {
          return null;
        }
      },
      addSwitchExceptions: async (name, ids) => {
        const current = this.settings.switchExceptions[name] ?? [];
        const merged = [...new Set([...current, ...ids])].sort();
        this.settings.switchExceptions = { ...this.settings.switchExceptions, [name]: merged };
        await this.saveSettings();
        void this.refreshLocalStatus();
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
            // The apply just rewrote this plugin's own settings file on disk — reload before
            // refreshing status so the running plugin picks up the new contract immediately.
            await this.loadSettings();
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
    return Object.values(reg.manifests).map((m) => ({ id: m.id, name: m.name, enabled: pluginRuntimeEnabled(reg, m.id) }));
  }

  private pkmProbe(): PkmProbe {
    const registry = this.pluginRegistry();
    return {
      io: this.app.vault.adapter,
      configDir: this.app.vault.configDir,
      isPluginEnabled: (id) => pluginRuntimeEnabled(registry, id),
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
    // enableAfterInstall stays false: enabling is config-sync's own On-apply decision.
    // addPlugin re-downloads and rewrites files (idempotent), so bound + retry it too — a
    // stalled BRAT download would otherwise hang the whole run like a bare requestUrl.
    const ok = await retry(
      () => this.withTimeout(addPlugin(repo, true, false, false, "", false, false, ""), 30_000, repo),
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

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    return {
      io: this.configIO(),
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: this.pluginHost(),
      passphrase: this.passphrase(),
      switchExceptions: this.settings.switchExceptions,
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

  // ── Stop syncing + store leftover cleanup ───────────────────────────────────────────────
  private groupStoreAbs(ctx: CoreContext, group: SyncGroup): string {
    return `${ctx.rootPath}/store/${groupStorePath(group.path)}`;
  }

  // Returns the store paths it deleted (display form, no "store/" prefix) so the caller can
  // record them in run history; empty when deleteStore is false or there was no store data.
  async stopSyncing(groupName: string, deleteStore: boolean): Promise<string[]> {
    const group = this.settings.groups.find((g) => g.name === groupName);
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
    await this.writeGroupsFile(this.settings.groups.filter((g) => g.name !== groupName));
    return deleted;
  }

  async storeFileCount(groupName: string): Promise<number> {
    const group = this.settings.groups.find((g) => g.name === groupName);
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
    const out: { rel: string; name: string; path: string; size: number }[] = [];
    for (const lf of leftoverStoreRels(rels, this.settings.groups)) {
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
    return listPluginSections(this.app.vault.adapter, this.app.vault.configDir, this.pluginRuntime(), groups, new Set(Object.keys(this.settings.bratPluginIndex)));
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

  async listDiscoveredFiles(groups: SyncGroup[]): Promise<{ name: string; path: string }[]> {
    return listDiscovered(this.app.vault.adapter, this.app.vault.configDir, groups);
  }

  // Rows for the switch-list "Local decisions" editor: union of local list ∪ store copy ∪
  // runtime (installed plugins / core registry), each with a display name and a state hint.
  async switchListRows(groupName: string): Promise<{ id: string; name: string; hint: string }[]> {
    const io = this.app.vault.adapter;
    const file = groupName === "community-plugins" ? "community-plugins.json" : "core-plugins.json";
    const readList = async (path: string): Promise<SwitchList | null> => {
      try {
        return (await io.exists(path)) ? parseSwitchList(await io.read(path)) : null;
      } catch {
        return null;
      }
    };
    const idsOf = (l: SwitchList | null): string[] => (l === null ? [] : Array.isArray(l) ? l : Object.keys(l));
    const onIn = (l: SwitchList | null, id: string): boolean =>
      l !== null && (Array.isArray(l) ? l.includes(id) : l[id] === true);
    const local = await readList(`${this.app.vault.configDir}/${file}`);
    const root = await this.resolvedRootPath();
    const store = await readList(`${root}/store/${groupStorePath(`{configDir}/${file}`)}`);
    const runtime = groupName === "community-plugins" ? this.pluginRuntime() : this.coreRuntime();
    const nameOf = new Map(runtime.map((r) => [r.id, r.name]));
    const ids = [...new Set([...idsOf(local), ...idsOf(store), ...runtime.map((r) => r.id)])];
    return ids
      .map((id) => ({
        id,
        name: nameOf.get(id) ?? id,
        hint: `${onIn(local, id) ? "on here" : "off here"} · ${store === null ? "no store copy" : onIn(store, id) ? "store has on" : "store has off"}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })); // sort by DISPLAY name — id order looked random in the UI
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
