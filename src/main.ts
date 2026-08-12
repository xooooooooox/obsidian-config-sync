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
  backfillLockLabels,
  captureWithActions, CaptureItem,
  deviceExcludedPluginIds,
  excludeOptedOutItems,
  groupsForDevice,
  loadLock,
  loadManifest,
  lockPath,
  pushExternal,
  readCarrierSwitchLists,
  readGroups,
  writeGroups,
} from "./core/ConfigSyncCore";
import { createInstaller } from "./core/installer";
import { classifyRemoteFailure } from "./core/remoteFailure";
// Keychain id for the passphrase (SecretStorage ids: lowercase alphanumerics and dashes).
import { PASSPHRASE_SECRET_ID } from "./core/secrets";
import { resolveGitToken } from "./external/gitToken";
import { ReaderCache, remoteReaderKey } from "./external/readerCache";
import { retry, HttpStatusError, TimeoutError, isRetryableError } from "./core/async";
import { RunRecord, RunKind, summarizeRun, pruneHistory } from "./core/runHistory";

// Structural view of app.secretStorage, from when the plugin still compiled for minAppVersion
// 1.8.7 and feature-detected the API at runtime (spec 2026-07-27-passphrase-keychain-design.md).
// The floor is now 1.11.4, so the property is always present; the detection below and its
// localStorage fallback are legacy. The git-token path uses the typed SecretStorage directly.
interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}
import { BratIndex, parseBratRepoList, resolveBratIndex } from "./core/bratIndex";
import { type CatalogSection, corePluginFile, displayLabelForGroup, findGroupByName, listBetaSections, listCoreSections, listDiscovered, listOptionSections, listPluginSections, SELF_GROUP_NAME, SELF_ITEM_ID, SELF_ITEM_REF, SELF_ITEM_SECTION, setCorePluginIds } from "./core/catalog";
import { Availability, availabilityForGroup, desktopOnlyDrift, desktopOnlyPluginIds, forcedRunsOn, membersExcludedByClass, memberForceOff, preferStoredRunsOn } from "./core/availability";
import { listFilesRecursive, isJunkPath, FileIO } from "./core/io";
import { leftoverStoreRels, storeSelfCopyGroups, selfListGroups } from "./core/leftover";
import { parseStoreLock, STORE_LOCK_FUTURE_MESSAGE, validateSyncManifest } from "./core/manifest";
import { lockRefFor, rekeyRefList } from "./core/itemKeys";
import { lockStoredLabel, resolveHostStoredLabel } from "./core/lockLabels";
import { basename, groupRealPath, groupStorePath, sidecarStoreSuffix } from "./core/pathing";
import {
  buildItemDefs,
  CompileError,
  defsForForeignItems,
  emptyItem,
  emptyItemMap,
  ENABLEMENT_LISTS,
  enablementSharing,
  groupOwners,
  GroupDisplayParts,
  defForRef,
  defRef,
  isEnablementList,
  Item,
  itemAt,
  ItemDef,
  itemForGroupName,
  ItemMap,
  ItemSettingsFile,
  itemWithDevice,
  compileItems,
  parentCardLabel,
  RegistryEnv,
  structuralLocalElements,
  withItem,
  withoutItem,
} from "./core/registry";
import { classifySettings, CURRENT_SCHEMA, SCHEMA_FUTURE_NOTICE, SCHEMA_UPGRADE_NOTICE, withDefaults } from "./core/settingsMigration";
import { deviceOptOutsFor, migrateV2Settings } from "./core/v2Migration";
import { applySwitchList, captureSwitchList, EnablementList, isSwitchListGroup, localRealPath, parseSwitchList, readLocalSwitchList, subtractForceOff, switchDivergence, SwitchList, switchListMemberOn, writeLocalSwitchList } from "./core/switchList";
import { applyTransform, captureTransform, isWholeFileEncrypted, scanSensitive, SensitiveScan } from "./core/modes";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { pluginRuntimeEnabled } from "./core/pluginState";
import { syncListDelta } from "./core/syncListDelta";
import { selfPaneState } from "./core/selfPane";
import { applyUpdates, baselineRefs, Ledger, LEDGER_VERSION, parseLedger, pruneLedger, rekeyLedger } from "./core/ledger";
import { bucketCounts, checkRemote, diffRemote, GroupStatus, remoteDirectionCounts, RemoteCheck, remoteLockAhead, remoteLockLabels, statusForGroups } from "./core/status";
import { asRunsOn, DeviceClass, EVERYWHERE, FileSharing, GroupResult, itemRef, ItemRef, parseItemRef, Remote, RibbonButtons, RunsOn, Sharing, sharingClass, StorageSection, StoreLock, SyncGroup, THIS_DEVICE } from "./core/types";
import { MemberDecision, memberDecisionsFromSharing, statusBarStatuses } from "./ui/panelModel";
import { defaultSettingsFile, deriveMode, fileRuleLegalForMode, pruneSettingsFile } from "./ui/itemCard";
import { ConflictModal } from "./ui/ConflictModal";
import { renderStatusBarItem, statusBarSegments } from "./ui/statusBar";
import { SYNC_CENTER_VIEW_TYPE, SelfSyncInfo, SyncCenterHost, SyncCenterView } from "./ui/SyncCenterView";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

// Settings schema v3 (spec 2026-08-11-v3-one-vocabulary-design.md §2). The sync list is not a
// stored SyncGroup[] — it is COMPILED (registry.ts's compileItems) from `items` on every
// load/save. Structure carries the taxonomy: `items` nests by section, and `custom` is one of
// those sections rather than a second data shape. The literal type is deliberate: it is the one
// place a schema bump must be acknowledged in the type system, and it must move together with
// settingsMigration.ts's CURRENT_SCHEMA (which DEFAULT_SETTINGS below reads, so the two can never
// disagree about what this build writes).
interface ConfigSyncSettings {
  schemaVersion: 3;

  // Transport wiring — the locked-local preset (catalog.ts's selfPresetRules); never travels.
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  remotes: Remote[];
  // Items this device decides for itself (was localMembers). ItemRefs, because a flat list needs
  // the one-string form of what the document nests.
  thisDeviceItems: ItemRef[];

  // The sync contract.
  items: ItemMap;

  // Preferences.
  ribbonButtons: RibbonButtons;
  statusInMenu: boolean;
  statusBarItem: boolean; // master toggle for the status-bar item
  statusBarRemote: boolean; // include per-remote ⇡ push / ⇣ pull segments
  ribbonDot: boolean; // legacy corner dot on the ribbon icon (off by default since the status bar took over)
  mobileStatusBar: boolean; // force-show Obsidian's status bar on phones (CSS class only)
  remoteAutoCheck: boolean;
  localPeriodicCheck: boolean;
  bratIndex: BratIndex; // plugin id -> "owner/repo"; derived from BRAT's synced list, synced too
  runHistory: RunHistorySettings; // local-only record of past runs; never synced
}

interface RunHistorySettings {
  enabled: boolean;
  path: string; // "" = default {configDir}/plugins/config-sync/run-history.json
  maxCount: number; // 0 = unlimited
  maxDays: number; // 0 = keep forever
}

const DEFAULT_SETTINGS: ConfigSyncSettings = {
  schemaVersion: CURRENT_SCHEMA,
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
  items: emptyItemMap(),
  bratIndex: {},
  runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
  thisDeviceItems: [],
};

// How long the §4.1 refusal notice stays ON SCREEN — and, for exactly that long, how long the same
// message stays quiet after being raised (schemaStopped). One literal, one rule: never two copies
// of the same sentence at once. A run of keystrokes in a settings text field therefore raises it
// once, while a gesture made after it has faded gets its own answer; the refusal itself is never
// suppressed, only the repeat of the message.
const REFUSAL_NOTICE_MS = 10000;

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
  plugins: Record<string, { enabled: boolean; instance?: { id: string; name: string }; enable(): Promise<void>; disable(): Promise<void> }>;
}

// app.vault's internal config loader; not part of the public API. setupConfig() rebuilds `config`
// as a fresh object from app.json + appearance.json (deleted keys handled) — the deterministic
// replacement for "reload the app" (spec 2026-08-06-batch2-scroll-and-appearance-hotapply-design.md).
interface VaultInternal {
  config: { cssTheme?: string; enabledCssSnippets?: string[] };
  setupConfig(): Promise<void>;
}

// app.customCss's internal surface: the in-memory enabled-snippets Set nothing else reconciles
// from config, plus the snippet/theme appliers that read it.
interface CustomCssInternal {
  enabledSnippets: Set<string>;
  readSnippets(): Promise<void>;
  loadSnippets(): Promise<void>;
  setTheme(cssTheme: string): void;
}

// app's internal appearance appliers; not part of the public API.
interface AppInternal {
  customCss: CustomCssInternal;
  updateTheme(): void;
  updateFontFamily(): void;
  updateFontSize(): void;
  updateAccentColor(): void;
}

// app.setting's internal surface (the Settings modal manager) — not part of the public API.
// The Sync Center's More bridge uses this to open the plugin's own Settings tab (the same entry
// point Obsidian's plugin list gear icon uses); SettingTab.display() then consumes
// pendingSettingsDeepLink to scroll to/expand the specific item's card once it lands there.
// activeTab is read by openSettingsAt to avoid re-opening a tab open() already activated (root
// cause of C-#11 — see there).
interface AppWithSetting {
  setting: { open(): void; openTabById(id: string): void; activeTab: { id: string } | null };
}

export default class ConfigSyncPlugin extends Plugin {
  // withDefaults, not DEFAULT_SETTINGS itself: this value is live from construction until the
  // first loadSettings, and handing out the module constant would let anything that writes before
  // then rewrite the defaults for the rest of the session. Same hazard the nested fill closes one
  // layer down — this is the layer above it.
  settings: ConfigSyncSettings = withDefaults(DEFAULT_SETTINGS, null);
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
  // The most recently loaded store.lock.json — the last-resort source for a not-installed
  // group's display name (see displayName/displayParts).
  private lastLock: StoreLock | null = null;
  // Compiled engine state (spec §6): the sync list is DERIVED from settings.items, never stored
  // directly. Recomputed on load and after every settings save (see saveSettings/recompile).
  private registryDefs: ItemDef[] = [];
  private compiledGroups: SyncGroup[] = [];
  remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
  private storeEventTimer: number | null = null;
  private remoteAutoCheckStartupTimer: number | null = null;
  // Per-refresh reader cache (#3): a compare (deepDiff) reuses the reader refreshRemoteChecks
  // already built for the same remote in this generation, instead of cloning the store again.
  private readerCache = new ReaderCache<ExternalStoreReader>(() => Date.now());
  // Live progress for a global refresh (#3/#4b, option 2): non-null only while refreshRemoteChecks
  // is running, so the Sync Center can paint a working state before the first clone completes.
  private remoteRefreshProgress: { total: number; done: number } | null = null;
  // R10: two overlapping refreshes shared one remoteRefreshProgress (done could pass total, and
  // the first finisher nulled progress out from under the still-running second). A second call
  // while one is in flight returns the SAME promise instead of starting a parallel run.
  private remoteRefreshRun: Promise<void> | null = null;
  // Startup lock-label heal (backfillLockLabels) runs once per plugin load, not on every
  // refreshLocalStatus — refreshLocalStatus fires on a timer, on layout ready, and after nearly
  // every write, so gating on this flag is what keeps the heal to a single attempt per load.
  private lockLabelsHealed = false;
  // Parsed once per plugin load instead of per read: isDeviceOptedOut runs per ROW per render
  // (~108 rows in a real vault), and a JSON.parse each time is exactly the kind of per-row cost
  // this panel has regressed on before. This process is the only writer of the key, so the cache
  // can only go stale if something outside the plugin edits localStorage — and every write here
  // refreshes it (saveDeviceOptOutGroups).
  private deviceOptOutsCache: string[] | null = null;
  // The §4.1 stop state (spec 2026-08-11-data-model-hardening.md, invariant II.3): non-null when
  // the data.json on disk was written by a newer Config Sync. While it is set, this build owns
  // nothing here — it neither resets the document nor writes over it, and every mutating entry
  // point refuses. Cleared by the next load that finds a document this build understands.
  private schemaStop: { found: number } | null = null;
  // Whether the last compile produced `compiledGroups` from the document, rather than leaving the
  // previous list (or none) in place after a CompileError. Read by saveBaselines — see its note.
  // Starts false: nothing has compiled yet at construction, and a baseline written before the first
  // compile would be keyed against nothing.
  private compileSucceeded = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.migratePassphraseToKeychain();
    setCorePluginIds(this.coreRuntime().map((c) => c.id));
    if (await this.recompile()) this.rekeyDeviceStores();
    this.addSettingTab(new ConfigSyncSettingTab(this.app, this));
    this.registerView(SYNC_CENTER_VIEW_TYPE, (leaf) => new SyncCenterView(leaf, this.syncCenterHost()));
    this.mainRibbonEl = this.addRibbonIcon("refresh-cw", "Config Sync", (evt) => void this.openSyncMenu(evt));
    this.refreshRibbons();
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("config-sync-statusbar", "mod-clickable");
    this.registerDomEvent(this.statusBarEl, "click", () => void this.openSyncCenter());
    this.updateStatusIndicators();
    this.applyMobileStatusBar();
    this.addCommand({ id: "sync", name: "Open Sync Center", callback: () => void this.openSyncCenter() });

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
  // Returns whether the compile SUCCEEDED — not a courtesy, a precondition (final-review I1). The
  // §4 re-key keys every baseline against `compiledGroups`, and a failed compile leaves that list
  // empty (or last-good), so the re-key would resolve nothing and file every companion and custom
  // rule under `legacy/…` — then stamp the ledger's new version, so it is never retried. One bad
  // custom rule name is enough to get there, and the user sees only a generic Notice.
  private async recompile(): Promise<boolean> {
    const env = await this.registryEnv();
    // defsForForeignItems, not a bare buildItemDefs: settings.items can carry a selected-but-
    // uninstalled plugin (e.g. install-on-apply's pending target), which env.plugins doesn't see
    // yet — without the synthesized def that item would have no group to compile into.
    this.registryDefs = defsForForeignItems(buildItemDefs(env), this.settings.items, env.betaIds);
    // Defense-in-depth (final-review fix): captured explicitly so "keep the last-good compiled
    // list on failure" is provable rather than incidental (mid-session this already happened by
    // omission — the catch branch never reassigned this.compiledGroups — but that's fragile to a
    // future refactor that adds a second assignment inside the try block). At first-load failure
    // there is no last-good yet, so this.compiledGroups correctly stays the constructor's `[]` —
    // the Notice below (naming the offending group/item via e.message) is what has to make that
    // failure actionable instead.
    const lastGoodGroups = this.compiledGroups;
    this.compileSucceeded = false;
    try {
      const compiled = compileItems(this.registryDefs, this.settings);
      // Safety net: compileItems is expected to always emit well-formed groups, but validating
      // here (the same check every hand-written config-sync.json goes through) catches a
      // registry bug before it reaches the capture/apply engine instead of failing obscurely.
      this.compiledGroups = validateSyncManifest({ version: 1, groups: compiled }).groups;
      this.compileSucceeded = true;
      return true;
    } catch (e) {
      this.compiledGroups = lastGoodGroups;
      const reason = e instanceof Error ? e.message : String(e);
      if (e instanceof CompileError) {
        new Notice(`Config Sync: ${reason}`, 10000);
        return false;
      }
      console.error("Config Sync: compiled sync groups failed validation", e);
      new Notice(`Config Sync: your sync setup has an invalid rule (${reason}) — fix it under Settings → Advanced.`, 10000);
      return false;
    }
  }

  private async registryEnv(): Promise<RegistryEnv> {
    const io = this.app.vault.adapter;
    const configDir = this.app.vault.configDir;
    const cores = await Promise.all(
      this.coreRuntime().map(async (c) => ({ id: c.id, name: c.name, fileExists: await io.exists(`${configDir}/${corePluginFile(c.id)}`) }))
    );
    const betaIds = new Set(Object.keys(this.settings.bratIndex));
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
      // C-#45: an opted-out group never runs a real comparison on this device (spec §4) — dropped
      // the same way groupsForDevice's own device-class filter already drops a scope-mismatched
      // group, before status/ledger/the ribbon count ever see it.
      const optedOut = this.deviceOptedOutRefs();
      const scoped = groupsForDevice(manifest, device).filter((g) => g.ref === undefined || !optedOut.has(g.ref));
      const ledger = this.loadBaselines();
      const { statuses, updates } = await statusForGroups(ctx, scoped, ledger);
      this.localStatuses = statuses;
      this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), baselineRefs(scoped)));
      // Presented buckets for the ribbon dot: version-ahead in-sync items count as to-capture,
      // matching the panel (0.23.4/0.23.5) — no crypto cost, just a lock read.
      let lock: StoreLock | null = null;
      try {
        lock = await loadLock(ctx);
      } catch {
        lock = null;
      }
      const host = this.pluginHost();
      // Startup heal (backfillLockLabels, spec 2026-08-08-c-livetest-batch6-remote-labels.md):
      // a fresh device with no local store yet is a no-op (lock === null) — the flag still
      // flips so a later pull's lock never gets a second heal attempt bolted onto this same load.
      // `optedOut` (C-#45 spec §4): the heal must not resurrect/write a lock entry this device
      // deliberately never captures.
      // §4.2b: the stop state writes NOTHING to either side, and this heal is the one remaining
      // store write on the startup path — cosmetic labels, but an exception here is the kind that
      // grows. Read straight off the field instead of through schemaStopped(): this runs on a
      // timer with no user gesture behind it, and a notice would fire again every refresh cycle.
      // `lockLabelsHealed` stays false while stopped, so a load that clears the stop state still
      // gets its one heal.
      // §4.3 (round-4 review N1): this is the fourth writer of store.lock.json, and it fires at
      // startup with no user action — the version of the lock it would replace is checked inside
      // backfillLockLabels, which refuses to mutate a lock from a newer build at all (see its own
      // doc comment). A future lock therefore produces no change and no write here.
      if (!this.lockLabelsHealed && this.schemaStop === null) {
        this.lockLabelsHealed = true;
        if (lock !== null && backfillLockLabels(manifest.groups, host, lock, await readCarrierSwitchLists(ctx, manifest.groups), optedOut)) {
          try {
            await ctx.io.write(lockPath(ctx), JSON.stringify(lock, null, 2) + "\n");
          } catch (e) {
            console.error("Config Sync: lock label heal failed to persist", e);
          }
        }
      }
      this.presentedStatuses = statusBarStatuses(
        this.localStatuses,
        (name) => {
          const g = scoped.find((x) => x.name === name);
          return g !== undefined ? availabilityForGroup(g, host, lock) : undefined;
        },
        Platform.isMobile
      );
    } catch (e) {
      console.error("Config Sync: status refresh failed", e);
    }
    this.updateStatusIndicators();
    this.notifySyncCenter();
  }

  async refreshRemoteChecks(): Promise<void> {
    if (this.remoteRefreshRun !== null) return this.remoteRefreshRun;
    this.remoteRefreshRun = this.doRefreshRemoteChecks().finally(() => {
      this.remoteRefreshRun = null;
    });
    return this.remoteRefreshRun;
  }

  private async doRefreshRemoteChecks(): Promise<void> {
    if (!Platform.isDesktop) return;
    // Exactly one bump per refresh (#3): every reader createReader builds in the loop below is
    // cached under this generation, so a same-cycle deepDiff({ reuse: true }) can reuse it
    // instead of cloning the remote store again.
    this.readerCache.bumpGeneration();
    let localLock: StoreLock | null = null;
    try {
      localLock = await loadLock(await this.coreContext());
    } catch {
      localLock = null;
    }
    this.remoteRefreshProgress = { total: this.settings.remotes.length, done: 0 };
    this.notifySyncCenter(); // paint the working state before the first clone — no silent gap
    for (const remote of this.settings.remotes) {
      try {
        const reader = await this.createReader(remote);
        // The same ignore list `remoteLockAhead` gets for this remote: one that never exchanges the
        // self item must not have its direction decided by the self lock entry — the two sides
        // diverge there by design, and no Pull could ever clear the arrow.
        const ignore = remote.excludeSelf === true ? [SELF_ITEM_REF] : [];
        this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader, ignore, this.compiledGroups), at: Date.now() });
      } catch (e) {
        this.remoteChecks.set(remote.name, { check: { state: "unknown", remoteCapturedAt: null }, at: Date.now() });
        console.error(`Config Sync: remote check failed for ${remote.name}`, e);
      }
      if (this.remoteRefreshProgress !== null) this.remoteRefreshProgress.done++;
      this.notifySyncCenter();
    }
    this.remoteRefreshProgress = null;
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
        const groupsForThisClass = groupsForDevice(manifest, device);
        // C-#24 root cause: groupsForDevice drops a scope-mismatched group before it ever reaches
        // statusForGroups — comparing its content across device classes would be meaningless (the
        // store copy may belong to a different device's rule entirely), so it correctly never runs
        // capture/apply/status for these. But that same drop used to make the item invisible in the
        // Sync Center, not merely mislabeled — no row, no availability entry, nothing for the fate
        // layer to read. These groups still get a row here: a synthetic, never-comparison-run
        // "in-sync" status so computeFateInput's excludedHere (SyncCenterView.ts) can author the
        // honest sentence instead of the row vanishing.
        const excludedGroups = manifest.groups.filter((g) => g.devices !== "all" && g.devices !== device);
        // C-#45 (spec 2026-08-10-c-livetest-batch22-device-optout.md §4): a device-opted-out group
        // IS this device's class (groupsForDevice never drops it) — a run must still skip it, so
        // it's split out of the real run set the SAME way excludedGroups is, and gets the SAME
        // synthetic-neutral-status treatment (batch-11 precedent) so rowFate's excluded branch
        // (optedOutHere) can speak instead of a real — and here, meaningless, since this device
        // never captures/applies it — comparison running.
        const optedOutRefs = this.deviceOptedOutRefs();
        const isOptedOut = (g: SyncGroup): boolean => g.ref !== undefined && optedOutRefs.has(g.ref);
        const groups = groupsForThisClass.filter((g) => !isOptedOut(g));
        const optedOutGroups = groupsForThisClass.filter(isOptedOut);
        this.lastGroups = [...groups, ...excludedGroups, ...optedOutGroups];
        const ledger = this.loadBaselines();
        const { statuses, updates } = await statusForGroups(ctx, groups, ledger);
        this.localStatuses = statuses;
        this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), baselineRefs(groups)));
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        this.lastLock = lock;
        const availability: Record<string, Availability> = {};
        for (const g of groups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        for (const g of excludedGroups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        for (const g of optedOutGroups) availability[g.name] = availabilityForGroup(g, this.pluginHost(), lock);
        // Keep the status bar's snapshot in step with THIS compute (it used to be refreshed
        // only by refreshLocalStatus), and count with the center's own lens — main-section
        // rows only (statusBarStatuses) — so the bar can never disagree with the pills. Excluded
        // groups (class rule AND device opt-out) stay out of this count (always-neutral, never
        // up/down either way) — unrelated surface, out of C-#24's scope.
        this.presentedStatuses = statusBarStatuses(statuses, (name) => availability[name], Platform.isMobile);
        this.updateStatusIndicators();
        const excludedStatuses: GroupStatus[] = excludedGroups.map((g) => ({ group: g.name, state: "in-sync" }));
        const optedOutStatuses: GroupStatus[] = optedOutGroups.map((g) => ({ group: g.name, state: "in-sync" }));
        return {
          groups: [...groups, ...excludedGroups, ...optedOutGroups],
          statuses: [...statuses, ...excludedStatuses, ...optedOutStatuses],
          availability,
        };
      },
      selfStatus: async (): Promise<SelfSyncInfo> => {
        const ctx = await this.coreContext();
        // Membership truth (delta / coldstart / itemCount) uses the same compile as the store
        // side (selfListGroups): items whose plugin isn't installed here stay members instead of
        // ghosting into delta.added forever (2026-07-28 phone find).
        const betaIds = new Set(Object.keys(this.settings.bratIndex));
        let localList: SyncGroup[];
        try {
          localList = selfListGroups(this.registryDefs, this.settings.items, betaIds);
        } catch {
          localList = this.compiledGroups; // best-effort fallback for any failure; in practice CompileError, which recompile() already surfaced as a Notice
        }
        const selfCopy = `${ctx.rootPath}/store/configdir/plugins/config-sync/data.json`;
        const selfCopyExists = await ctx.io.exists(selfCopy);
        const storeGroups = selfCopyExists ? storeSelfCopyGroups(await ctx.io.read(selfCopy), this.registryDefs, betaIds) : [];
        const delta = syncListDelta(localList, storeGroups);
        let capturedAt: string | null = null;
        const lockPath = `${ctx.rootPath}/store.lock.json`;
        const lockExists = await ctx.io.exists(lockPath);
        if (lockExists) {
          try {
            capturedAt = parseStoreLock(await ctx.io.read(lockPath), this.compiledGroups).capturedAt;
          } catch {
            capturedAt = null; // an unreadable lock must not break the pane
          }
        }
        const storePresent = lockExists || selfCopyExists;
        if (localList.length === 0) return { state: "coldstart", delta, itemCount: storeGroups.length, capturedAt, storePresent, contentChanged: false, versionRefresh: null, updateAvailable: null, flagsRefresh: null };
        const selfGroup = this.compiledGroups.find((g) => g.name === SELF_GROUP_NAME);
        if (selfGroup === undefined) return { state: "insync", delta, itemCount: localList.length, capturedAt, storePresent, contentChanged: false, versionRefresh: null, updateAvailable: null, flagsRefresh: null };
        const selfLedger = this.loadBaselines();
        const { statuses: selfStatuses, updates: selfUpdates } = await statusForGroups(ctx, [selfGroup], selfLedger);
        const [st] = selfStatuses;
        this.saveBaselines(applyUpdates(selfLedger, selfUpdates));
        let lock: StoreLock | null = null;
        try {
          lock = await loadLock(ctx);
        } catch {
          lock = null;
        }
        const av = availabilityForGroup(selfGroup, this.pluginHost(), lock);
        const flagsRefreshCount = desktopOnlyDrift(this.compiledGroups, this.pluginHost(), lock);
        const decided = selfPaneState({ isColdStart: false, groupState: st?.state, drift: av.drift, flagsDrift: flagsRefreshCount > 0 });
        if (decided.state === "insync") this.setColdStartDismissed(false);
        const versionRefresh =
          decided.versionRefresh && av.localVersion !== null && av.storeVersion !== null ? { local: av.localVersion, store: av.storeVersion } : null;
        const updateAvailable =
          decided.versionBehind && av.localVersion !== null && av.storeVersion !== null ? { local: av.localVersion, store: av.storeVersion } : null;
        return { state: decided.state, delta, itemCount: localList.length, capturedAt, storePresent, contentChanged: decided.contentChanged, versionRefresh, updateAvailable, flagsRefresh: flagsRefreshCount > 0 ? flagsRefreshCount : null };
      },
      coldStartDismissed: () => this.coldStartDismissed(),
      setColdStartDismissed: (v) => this.setColdStartDismissed(v),
      resolvedPath: (g) => g.path.replace("{configDir}", this.app.vault.configDir),
      displayName: (g, storedLabel) => this.displayName(g, resolveHostStoredLabel(g, storedLabel, this.lastGroups, this.lastLock, (n) => this.groupRef(n))),
      displayParts: (g, storedLabel) => this.displayParts(g, resolveHostStoredLabel(g, storedLabel, this.lastGroups, this.lastLock, (n) => this.groupRef(n))),
      localLockLabel: (g) => lockStoredLabel(this.lastLock, this.groupRef(g)),
      companionParentOf: (g) => this.companionParentOf(g),
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
          const exc = isSwitchListGroup(name) ? ((await this.augmentedSwitchExceptions(rootPath))[name] ?? []) : [];
          const cls: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
          if (dir === "capture") {
            let produced = local ?? "";
            if (group.type === "file" && local !== null) {
              if (isSwitchListGroup(name)) {
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
            if (isSwitchListGroup(name)) {
              const st = parseSwitchList(store);
              if (st !== null) {
                const localList = local !== null ? readLocalSwitchList(name, local) : null;
                const merged = applySwitchList(st, localList, exc);
                const fo = this.memberForceOffIds(name);
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
      switchMemberDecisions: (name) => (isSwitchListGroup(name) ? this.memberDecisionsFor(name) : []),
      isDesktopOnlyPlugin: (id) => {
        const manifest = this.pluginRegistry().manifests[id];
        return manifest === undefined ? null : manifest.isDesktopOnly === true;
      },
      betaIds: () => new Set(Object.keys(this.settings.bratIndex)),
      runHistoryEnabled: () => this.settings.runHistory.enabled,
      loadRunHistory: () => this.loadRunHistory(),
      appendRunHistory: (kind, remote, results) => this.appendRunHistory(kind, remote, results),
      clearRunHistory: () => this.clearRunHistory(),
      stopSyncing: (groupName, deleteStore) => this.stopSyncing(groupName, deleteStore),
      deviceOptedOut: (groupName) => this.isDeviceOptedOut(groupName),
      setDeviceOptOut: (groupName, on) => this.setDeviceOptOut(groupName, on),
      storeFileCount: (groupName) => this.storeFileCount(groupName),
      listLeftoverStoreFiles: () => this.listLeftoverStoreFiles(),
      deleteLeftoverStoreFiles: (rels) => this.deleteLeftoverStoreFiles(rels),
      appendActionHistory: (entry) => this.appendActionHistory(entry),
      switchDivergenceFor: async (name) => {
        if (!isSwitchListGroup(name)) return null;
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
          const masked = ctx.switchExceptions[name] ?? [];
          return { ...switchDivergence(local, stored, masked), masked };
        } catch {
          return null;
        }
      },
      addSwitchExceptions: (name, ids) => this.addSwitchExceptions(name, ids),
      setMemberDevice: (list, elementId, device) => this.setMemberDevice(list, elementId, device),
      clearMemberLocal: (list, elementId) => this.clearMemberLocal(list, elementId),
      setItemSyncEnabled: (ref, enabled) => this.setItemSyncEnabled(ref, enabled),
      runsOnFor: (list, elementId, locallyOn) => this.runsOnFor(list, elementId, locallyOn),
      setRunsOn: (list, elementId, rule) => this.setRunsOn(list, elementId, rule),
      itemFileSharing: (ref) => this.itemFileSharing(ref),
      itemFileSharingMenuLegal: (ref) => this.itemFileSharingMenuLegal(ref),
      setItemFileSharing: (ref, sharing) => this.setItemFileSharing(ref, sharing),
      setCustomItemDevice: (name, device) => this.setCustomItemDevice(name, device),
      openSettingsAt: (ref) => this.openSettingsAt(ref),
      itemRefForGroup: (name) => this.itemRefForGroup(name),
      schemaStop: () => this.schemaStop,
      settingsWritable: () => this.settingsWritable(),
      adoptConfiguration: async () => {
        // §4.1: adopt is the one entry point that rewrites this device's own data.json wholesale —
        // the very document the stop state is protecting.
        if (this.schemaStopped()) return null;
        try {
          // config-sync's own registry item (registry.ts builds one for every installed plugin,
          // itself included) compiles to the same legacy group name (SELF_GROUP_NAME) the self-
          // propagation apply below expects — enable it so compileItems actually emits that group.
          const selfItem = itemAt(this.settings.items, SELF_ITEM_SECTION, SELF_ITEM_ID);
          if (selfItem?.enabled !== true) {
            this.settings.items = withItem(this.settings.items, SELF_ITEM_SECTION, SELF_ITEM_ID, { ...(selfItem ?? emptyItem()), enabled: true });
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
        if (this.schemaStopped()) return null; // §4.1
        try {
          const ctx = await this.coreContext();
          // C-#45 (spec §4): runner-level guard, not just the UI's own stageable:false — an
          // opted-out group cannot enter a capture payload even if a stale selection sneaks one
          // in, and the tail heal (backfillLockLabels, threaded through here) must not write its
          // lock entry either.
          const optedOut = this.deviceOptedOutRefs();
          const results = await captureWithActions(ctx, excludeOptedOutItems(items, optedOut, (n) => this.groupRef(n)), onProgress, optedOut);
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
        if (this.schemaStopped()) return null; // §4.1
        try {
          const ctx = await this.coreContext();
          // C-#45 (spec §4): same runner-level guard as captureItems — apply never installs/
          // writes an opted-out group even given a stale selection.
          const results = await applyWithActions(ctx, excludeOptedOutItems(items, this.deviceOptedOutRefs(), (n) => this.groupRef(n)), this.installPlugin(), onProgress);
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
      remoteRefreshProgress: () => this.remoteRefreshProgress,
      readerGeneration: () => this.readerCache.generation(),
      deepDiff: async (remote, onPhase) => {
        const ctx = await this.coreContext();
        onPhase?.("fetch");
        const reader = await this.createReader(remote, { reuse: true });
        onPhase?.("compare");
        const entries = await diffRemote(ctx, reader, { excludeSelf: remote.excludeSelf === true });
        // A lock-only delta (version-refresh capture on the other side) is real pull payload
        // even when every store file matches — surface it so the hint isn't contradictory.
        let lockDiffers = false;
        let remoteLabels: Record<string, string> = {};
        try {
          const remoteLock = (await reader.listFiles()).includes("store.lock.json") ? await reader.readFile("store.lock.json") : null;
          const localLock = (await ctx.io.exists(`${ctx.rootPath}/store.lock.json`)) ? await ctx.io.read(`${ctx.rootPath}/store.lock.json`) : null;
          lockDiffers = remoteLockAhead(localLock, remoteLock, remote.excludeSelf === true ? [SELF_ITEM_REF] : [], this.compiledGroups);
          // Parsed separately from remoteLockAhead's own (tolerant) parse above — a malformed
          // remote lock must still leave lockDiffers at whatever remoteLockAhead just decided,
          // not get reset by a JSON.parse throw here.
          if (remoteLock !== null) {
            try {
              remoteLabels = remoteLockLabels(JSON.parse(remoteLock), lockRefFor(this.compiledGroups));
            } catch {
              remoteLabels = {};
            }
          }
        } catch {
          lockDiffers = false;
        }
        return { entries, lockDiffers, remoteLabels };
      },
      pullFrom: async (remote) => {
        if (this.schemaStopped()) return null; // §4.1
        try {
          const ctx = await this.coreContext();
          const pending = await planImport(ctx, await this.createReader(remote), { excludeSelf: remote.excludeSelf === true });
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
          const message = (e as Error).message;
          // The §4.3 refusal already says what to do (update Config Sync) — appending the
          // check-your-URL advice would send the user after a problem they do not have. Same
          // reasoning as the no-token case, which is likewise our own refusal, not a transport
          // failure.
          const advice = classifyRemoteFailure(message) === "no-token" || message === STORE_LOCK_FUTURE_MESSAGE ? "" : " — check the remote's URL or path and try again.";
          new Notice(`Config Sync pull failed: ${message}${advice}`, 10000);
          return null;
        }
      },
      pushTo: async (remote) => {
        if (this.schemaStopped()) return null; // §4.1
        try {
          const ctx = await this.coreContext();
          const results = await pushExternal(ctx, await this.createWriter(remote), { excludeSelf: remote.excludeSelf === true });
          await this.refreshRemoteChecks();
          return results;
        } catch (e) {
          const message = (e as Error).message;
          const advice = classifyRemoteFailure(message) === "no-token" || message === STORE_LOCK_FUTURE_MESSAGE ? "" : " — check the remote's URL or path and try again."; // see pullFrom
          new Notice(`Config Sync push failed: ${message}${advice}`, 10000);
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
    if (rb.sync) add("refresh-cw", "Config Sync: Open Sync Center", () => void this.openSyncCenter());
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

  private loadBaselines(): Ledger {
    return parseLedger(this.app.loadLocalStorage("config-sync-baselines"));
  }

  // §4.2b (review M4): a baseline is the fingerprint of a group this device believes it syncs, and
  // that belief comes from `compiledGroups` — compiled from a document this build cannot read. Two
  // devices never see each other's baselines, so this is not "something another device can see";
  // it is refused for the other half of the rule: writing it records a fiction, and direction
  // (`local-changed`/`store-newer`) is decided from it afterwards. Silent, like the other
  // status-path refusals: this runs on a timer with no user gesture behind it. The device's own
  // scratch preferences that read nothing from the document — the passphrase above, the cold-start
  // dismissal below, clearing the run history on request — are deliberately NOT refused.
  //
  // Two more preconditions, both from final-review N1, and both here rather than at the call sites
  // because this is the ONE writer every baseline write goes through — the status refresh, the Sync
  // Center's compute, the self pane and the §4 re-key alike. Gating the re-key alone left the status
  // path free to do the same damage by a different road: with `compiledGroups` empty after a failed
  // compile, its prune keeps nothing and persists an EMPTY ledger, and every item then reads as
  // never-synced, whose default direction is APPLY — exactly what the re-key's gate was filed for.
  //
  // 1. The compile must have SUCCEEDED. A baseline is keyed by, and pruned against, the compiled
  //    list; a list this build could not produce is not evidence about anything. (The pruning
  //    itself predates this branch — what was new is that the empty list became reachable once the
  //    re-key stopped running first.)
  // 2. The ledger must be the version this build writes. A writer that does not understand the file
  //    it is rewriting declines — the same rule as the store-lock gate and the label heal. That is
  //    the half that makes the property hold no matter which writer runs first next time: a v1
  //    ledger is left exactly as found, retryable, instead of being overwritten in a shape whose own
  //    reader (`parseLedger`, which reads `groups` for a v1 document) would answer empty.
  private saveBaselines(ledger: Ledger): void {
    if (this.schemaStop !== null || !this.compileSucceeded || ledger.version !== LEDGER_VERSION) return;
    this.app.saveLocalStorage("config-sync-baselines", JSON.stringify(ledger));
  }

  private coldStartDismissed(): boolean {
    return this.app.loadLocalStorage("config-sync-coldstart-dismissed") === "1";
  }

  private setColdStartDismissed(v: boolean): void {
    this.app.saveLocalStorage("config-sync-coldstart-dismissed", v ? "1" : null);
  }

  // This device's own identity (C-#45). Since the opt-out list stopped being keyed by it (spec
  // 2026-08-11-data-model-hardening.md §2) the only reader left is that move's migration, which
  // needs it to tell this device's entry from the other devices' in the old shared map. MUST live
  // in localStorage, never data.json: data.json travels wholesale (git-tracked vaults,
  // remotely-save, manual copies), and a value trusted from an inherited data.json would let a
  // bootstrapped machine silently claim the source machine's identity — and with it that machine's
  // opt-outs (fix-round 1, reviewer-caught CRITICAL — the settings-field version this replaced had
  // exactly that hole). localStorage is per-vault, per-device, invisible to vault-wide sync
  // (ledger.ts's own header comment; same primitive as
  // `passphrase`/`loadBaselines`/`coldStartDismissed` above) — a wholesale copy leaves it empty on
  // the new machine, so it generates and persists its own id there instead; the collision class is
  // structurally closed, not merely mitigated. Deliberately NOT globalThis.crypto.randomUUID():
  // this id is an opaque local label, never a secret or a security boundary, so
  // Date.now()+Math.random() is ample entropy for distinguishing a user's own handful of devices,
  // and avoids a new obsidianmd/no-global-this lint warning.
  private deviceId(): string {
    const existing: unknown = this.app.loadLocalStorage("config-sync-device-id");
    if (typeof existing === "string" && existing !== "") return existing;
    const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.app.saveLocalStorage("config-sync-device-id", fresh);
    return fresh;
  }

  // The group names THIS device has opted out of (spec 2026-08-11-data-model-hardening.md §2,
  // C-#52). It lives next to the device id above because it lives BY it: a datum true only of this
  // device, and defined by this device's identity, belongs in the same store as the identity
  // itself. As a data.json field (`deviceOptOuts`, group name -> device ids) it rode the self
  // item's whole-document propagation, and the live failure that followed was inevitable — a pull
  // replaced the store copy with another device's, adopt landed that copy here, and this device's
  // own entry was gone. The device-id keying disappeared with the move: a document that only ever
  // describes one device has no need to say which one.
  //
  // Anything but a JSON array of strings reads as "nothing opted out": the value is a plain
  // localStorage entry a user (or a half-finished write) can leave in any shape, and a device that
  // cannot read its own opt-out list must still sync, not fail to load. Parsed at most once per
  // load (deviceOptOutsCache) — this is read per row per render.
  private deviceOptOutGroups(): string[] {
    if (this.deviceOptOutsCache !== null) return this.deviceOptOutsCache;
    const raw: unknown = this.app.loadLocalStorage("config-sync-device-optouts");
    let parsed: unknown = null;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const names = Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    this.deviceOptOutsCache = names;
    return names;
  }

  // The localStorage half of §5's `deviceOptOuts → dropped` row, run once by the v2 → v3 migration.
  // v2 carried a fleet-shared map (group name -> the device ids that opted it out) purely so a
  // device still on a build that read it would not lose its own entry; 2.21.0 moved the authority
  // to localStorage and absorbed the map on every load. A device that jumps straight from 2.20.0
  // to v3 has never run that absorb, so dropping the field without it would silently resume
  // syncing items that device deliberately opted out of. A union, never a replacement: a choice
  // made on this device is never thrown away by a map that predates it, which also makes running
  // it twice a no-op. Writes nothing when there is nothing to add.
  private absorbCarriedDeviceOptOuts(carried: unknown): void {
    // Checked before deviceId(), which GENERATES and persists an id when the vault has none: a
    // document with no opt-outs in it must not be what mints this device's identity.
    if (typeof carried !== "object" || carried === null || Object.keys(carried).length === 0) return;
    const fromDocument = deviceOptOutsFor(carried, this.deviceId());
    if (fromDocument.length === 0) return;
    const names = new Set(this.deviceOptOutGroups());
    const before = names.size;
    for (const name of fromDocument) names.add(name);
    if (names.size !== before) this.saveDeviceOptOutGroups([...names]);
  }

  private saveDeviceOptOutGroups(names: string[]): void {
    // An empty list clears the key rather than storing "[]" — the same prune discipline the
    // settings map followed (C-#26), so opting out and back in leaves the store as it was found.
    this.app.saveLocalStorage("config-sync-device-optouts", names.length > 0 ? JSON.stringify(names) : null);
    this.deviceOptOutsCache = [...names];
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
      disableCorePlugin: async (id) => {
        const p = this.internalPlugins().plugins[id];
        if (p === undefined) throw new Error(`core plugin "${id}" does not exist in this Obsidian build`);
        await p.disable();
      },
      reloadPluginManifests: () => this.pluginRegistry().loadManifests(),
      reloadAppearance: async () => {
        // Deterministic replacement for "reload the app" — verified sequence (design doc
        // 2026-08-06-batch2-scroll-and-appearance-hotapply-design.md): re-read the config files,
        // reconcile customCss's in-memory Set from it, rescan snippet files, then run the
        // explicit appliers (vault.trigger("config-changed") does not run them).
        const av = this.app.vault as unknown as VaultInternal;
        const a = this.app as unknown as AppInternal;
        await av.setupConfig();
        a.customCss.enabledSnippets = new Set(av.config.enabledCssSnippets ?? []);
        await a.customCss.readSnippets();
        await a.customCss.loadSnippets();
        a.customCss.setTheme(av.config.cssTheme ?? "");
        a.updateTheme();
        a.updateFontFamily();
        a.updateFontSize();
        a.updateAccentColor();
      },
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
        if (this.settings.bratIndex[id] === undefined) await this.refreshBratIndex();
        const repo = this.settings.bratIndex[id];
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
    // §4.2b, same rule as appendActionHistory below: no run can have happened while the stop state
    // holds, so nothing here can be a real record. The Sync Center already returns before calling
    // this (setLastRun stops on the refusal's `null`), but caller discipline is not a guarantee.
    if (this.schemaStop !== null) return;
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
  // §4.2b: a refused action is never recorded as done. Both callers now stop on the refusal signal
  // their action returns (stopSyncing/deleteLeftoverStoreFiles return null), but this record is
  // written by the CALLER, so the last word belongs here: while the stop state holds no entry is
  // written at all, and a future caller cannot log a refusal as a success by forgetting to check.
  async appendActionHistory(entry: { kind: RunKind; desc: string; changed: number; removed?: string[]; deletedFiles?: string[] }): Promise<void> {
    if (this.schemaStop !== null) return;
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
    // A device with no BRAT list at all is a READER of the index, never its writer (spec
    // 2026-08-11-data-model-hardening.md §3.3, invariant II.4). resolveBratIndex prunes ids whose
    // repo is gone from THIS device's list, so an empty list resolves to an empty index — and this
    // method would save it, wiping a fleet-shared structure from the device that knows least about
    // it. The Beta tab's map-note reports what it can see either way (bratScanStatus, local-only).
    if (repos.length === 0) return { resolved: 0, total: 0 };
    const next = await resolveBratIndex(this.settings.bratIndex, repos, async (repo) => {
      try {
        const res = await requestUrl({ url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`, throw: true });
        return res.text;
      } catch {
        return null;
      }
    });
    // §4.2b: the assignment sits INSIDE the stop check, not before it — `resolveBratIndex` above
    // pruned the index against this device's repo list, and publishing that reading of a document
    // we cannot read is exactly what the stop state forbids. Silent (the Beta tab re-scans on its
    // own when it opens, with no user gesture behind it — a notice there would fire unprompted).
    if (this.schemaStop === null && JSON.stringify(next) !== JSON.stringify(this.settings.bratIndex)) {
      this.settings.bratIndex = next;
      await this.saveSettings();
    }
    return { resolved: Object.keys(next).length, total: repos.length };
  }

  // A compiled group's item ref — THE way this shell asks the key space a question (spec §3/§4).
  // A name nothing compiles resolves through the same legacy rules a v1/v2 lock read uses, so a
  // display lookup and a lock read can never disagree about which entry they mean.
  //
  // Memoized against the compiled list's identity (task-3 review I4): `lockRefFor` BUILDS an index,
  // and this is asked per row per render by isDeviceOptedOut and displayName. The same regression
  // the Sync Center's own resolver was caught with — fixed there and left here, which is the third
  // time on this branch that one half of a pair moved and the other did not.
  private groupRefSource: SyncGroup[] | null = null;
  private groupRefFor: (group: string) => string = lockRefFor([]);
  private groupRef(group: string): string {
    if (this.groupRefSource !== this.compiledGroups) {
      this.groupRefSource = this.compiledGroups;
      this.groupRefFor = lockRefFor(this.compiledGroups);
    }
    return this.groupRefFor(group);
  }

  displayName(group: string, storedLabel?: string): string {
    // Routes every caller (direct or via the Sync Center host's resolveHostStoredLabel
    // pre-resolve) through the SAME chain — including its carrier element-name fallback
    // (2026-08-09-c-livetest-batch15) — so a bare `this.displayName(name)` call (e.g.
    // ConflictModal's name resolver) never falls back to the id where the wrapped path would
    // have found a name. Idempotent when storedLabel already arrived resolved.
    return displayLabelForGroup(group, this.pluginHost(), resolveHostStoredLabel(group, storedLabel, this.lastGroups, this.lastLock, (n) => this.groupRef(n)));
  }

  displayParts(group: string, storedLabel?: string): GroupDisplayParts {
    return {
      parent: parentCardLabel(group, this.registryDefs, this.settings),
      label: this.displayName(group, storedLabel),
    };
  }

  // The Sync Center host resolver (c-livetest batch5 task 2, spec §1): the parent GROUP name for
  // a companion group, so the view can fold a family into one row/entry — null for a non-companion,
  // a custom group, or `enabled-css-snippets` (none of which groupOwners ever attributes to a
  // def-level companionPath, so the out-of-scope cases fall out of this check for free).
  // groupOwners only knows STATIC def-level presetCompanions; spec §1's family also includes "any
  // item's configured companions" (the Settings drawer's "+ Add folder", any item, not just the
  // ones with a preset) — those live in settings.items, not the registry, so a group groupOwners
  // doesn't recognize falls through to a scan there. Mirrors compileCompanions' own filter
  // (registry.ts:283: only `enabled` companions ever compile into a group) so this only resolves
  // basenames that actually exist as a compiled group. Preset mapping keeps priority (checked
  // first); a name collision between the two sources is impossible at compile time
  // (companionNameConflict guards it), so the first match is always the only match.
  companionParentOf(group: string): string | null {
    const owner = groupOwners(this.registryDefs, this.settings.items)[group]?.[0];
    if (owner !== undefined) {
      if (owner.section === "custom" || owner.companionPath === undefined) return null;
      // defForRef, never `d.section === owner.section` — see SettingTab's consumeSettingsAnchor:
      // an owner carries the STORED section and a beta plugin's def presents the other one.
      return defForRef(this.registryDefs, itemRef(owner.section, owner.id))?.groupName ?? null;
    }
    for (const def of this.registryDefs) {
      const item = itemAt(this.settings.items, def.section, def.id);
      if ((item?.companions ?? []).some((c) => c.enabled && basename(c.path) === group)) return def.groupName;
    }
    return null;
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

  // A group name -> the enablement list it IS, or null. The registry declares which lists exist
  // (ENABLEMENT_LISTS); a group that is not one of them (e.g. enabled-css-snippets, governed by a
  // plain perElement key on the compiled "appearance" group — see registry.ts) has no
  // items-backed enablement at all.
  private listFor(group: string): EnablementList | null {
    return isEnablementList(group) ? group : null;
  }

  private enablementSharingFor(group: string): Record<string, Sharing> {
    const list = this.listFor(group);
    return list === null ? {} : enablementSharing(this.registryDefs, this.settings, list);
  }

  private structuralLocalElementsFor(group: string): Set<string> {
    const list = this.listFor(group);
    return list === null ? new Set<string>() : structuralLocalElements(this.registryDefs, this.settings, list);
  }

  // The per-class slice of the list's sharing map — the only part the capture/apply mask cares
  // about (everywhere masks nothing; this-device is handled by memberLocalIdsFor).
  private memberClassesFor(group: string): Record<string, "desktop" | "mobile"> {
    const out: Record<string, "desktop" | "mobile"> = {};
    for (const [id, sharing] of Object.entries(this.enablementSharingFor(group))) {
      const cls = sharingClass(sharing);
      if (cls !== null) out[id] = cls;
    }
    return out;
  }

  // The stored section an enablement list's elements are items of. StorageSection, not Section:
  // a beta plugin's element lives in `community` like every other community plugin (spec §7b).
  private sectionForList(list: EnablementList): StorageSection {
    return list === "core-plugins" ? "core" : "community";
  }

  // This device's pinned ids for one enablement list, de-refed to bare element ids.
  private thisDeviceIdsIn(section: StorageSection): string[] {
    const out: string[] = [];
    for (const ref of this.settings.thisDeviceItems) {
      const parsed = parseItemRef(ref);
      if (parsed !== null && parsed.section === section) out.push(parsed.id);
    }
    return out;
  }

  // Base decisions from enablementSharing, OVERLAID with settings.thisDeviceItems for this
  // group's list as an explicit this-device pin (a pin wins over any base sharing for that id —
  // an explicit "this device decides" choice always beats a device-class rule the writer path
  // left behind). Every this-device reader (switchMemberDecisions' · N device-scoped count, the ⌂
  // explanation rows, and memberLocalIdsFor below) goes through this so they can't drift apart
  // the way memberDecisionsFor alone did pre-fix (it only saw the structural disabled-card
  // this-device, never the pins).
  private memberDecisionsFor(group: string): MemberDecision[] {
    const base = memberDecisionsFromSharing(this.enablementSharingFor(group), this.structuralLocalElementsFor(group));
    const list = this.listFor(group);
    if (list === null) return base;
    const pinned = this.thisDeviceIdsIn(this.sectionForList(list));
    if (pinned.length === 0) return base;
    const decisions = new Map(base.map((d) => [d.id, d] as const));
    // An explicit pin is itself the "explicit source" — never structural, regardless of the
    // card's enabled state it overrides.
    for (const id of pinned) decisions.set(id, { id, sharing: THIS_DEVICE, structural: false });
    return [...decisions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // This-device ids for a switch-list group: memberDecisionsFor already carries the
  // settings.thisDeviceItems union, so this is just the this-device projection.
  private memberLocalIdsFor(group: string): string[] {
    return this.memberDecisionsFor(group)
      .filter((d) => d.sharing.kind === "this-device")
      .map((d) => d.id);
  }

  // Shared add/remove for the explicit this-device set — every write path that sets or clears
  // "this device decides for itself" goes through this so the settings-card chip (setMemberLocal,
  // called by SettingTab's renderEnabledOnZone) and the where-it-runs menu
  // (addSwitchExceptions/setMemberDevice/clearMemberLocal) can never drift apart. In-memory only —
  // callers persist with their own saveSettings() call.
  private setLocalMember(ref: ItemRef, on: boolean): void {
    const set = new Set(this.settings.thisDeviceItems);
    if (on) set.add(ref);
    else set.delete(ref);
    this.settings.thisDeviceItems = [...set];
  }

  // A this-device pin and a device-class rule are mutually exclusive. The where-it-runs menu's pin
  // and its "Everywhere" reset both go through thisDeviceItems, so they must also drop any stale
  // runsOn.device — otherwise "Desktop only → This device → Everywhere" would silently resolve
  // back to desktop. Only the DEVICE axis is cleared: a force rule is the other axis and answers a
  // different question, exactly as the two v2 fields this merged did. A runsOn left saying nothing
  // at all is dropped entirely, so the round trip leaves data.json as it found it (C-#26).
  private clearMemberDevice(section: StorageSection, id: string): void {
    const item = itemAt(this.settings.items, section, id);
    const runsOn = item?.runsOn;
    if (item === undefined || runsOn === undefined || runsOn.device === "all") return;
    const next: Item = { ...item };
    if (runsOn.force === undefined) delete next.runsOn;
    else next.runsOn = { device: "all", force: runsOn.force };
    this.settings.items = withItem(this.settings.items, section, id, next);
  }

  // SettingsHost-facing wrapper (SettingTab's "Enabled on" chip): single item, persists itself.
  // Takes the ref the caller already holds (registry.ts's defRef) rather than a section+id pair,
  // so a card's PRESENTED section can never become the pin's identity.
  async setMemberLocal(ref: ItemRef, on: boolean): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b: refuse BEFORE mutating — see settingsWritable()
    this.setLocalMember(ref, on);
    await this.saveSettings();
  }

  // Sync Center header chip (unified grammar task-4): same write as the Settings tab's per-card
  // sync toggle (SettingTab.renderItemCard) — Item.enabled, keyed by the item's ref.
  async setItemSyncEnabled(ref: ItemRef, enabled: boolean): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const parsed = parseItemRef(ref);
    if (parsed === null) return;
    const item = itemAt(this.settings.items, parsed.section, parsed.id) ?? emptyItem();
    this.settings.items = withItem(this.settings.items, parsed.section, parsed.id, { ...item, enabled });
    await this.saveSettings();
  }

  // Runs-on menu read (unified grammar task-5, spec §6): a genuinely stored rule always wins;
  // absent one, derive losslessly from this device's pin / the disabled-card structural
  // this-device (memberDecisionsFor) using the SAME forcedRunsOn mapping runsOnForces applies at
  // apply/capture time, so the menu's displayed value always agrees with what a run would do.
  private runsOnFor(list: EnablementList, elementId: string, locallyOn: boolean): RunsOn {
    const stored = this.storedRunsOn(this.sectionForList(list), elementId);
    if (stored !== undefined) return stored;
    const sharing = this.memberDecisionsFor(list).find((d) => d.id === elementId)?.sharing;
    if (sharing === undefined) return { device: "all" };
    if (sharing.kind === "this-device") return forcedRunsOn(locallyOn);
    return { device: sharing.class };
  }

  // asRunsOn, not a bare read: a rule shape this build doesn't know (a newer build's) is ignored
  // here rather than shown/applied, and stays on disk untouched (2.21.0 invariant II.2).
  private storedRunsOn(section: StorageSection, id: string): RunsOn | undefined {
    return asRunsOn(itemAt(this.settings.items, section, id)?.runsOn);
  }

  // Runs-on menu write: stores the rule on the item it governs. Rides the self item's
  // whole-document field sync unchanged (it carries no locked preset, unlike
  // rootPath/remotes/thisDeviceItems — see selfPresetRules).
  async setRunsOn(list: EnablementList, elementId: string, rule: RunsOn): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const section = this.sectionForList(list);
    const item = itemAt(this.settings.items, section, elementId) ?? emptyItem();
    this.settings.items = withItem(this.settings.items, section, elementId, { ...item, runsOn: rule });
    await this.saveSettings();
  }

  // Settings-sync menu read/write (unified grammar task-5): the same field the Settings tab's
  // file-row sharing control edits (Item.settingsFile.fileRule.sharing). `mode` is re-derived
  // on every write exactly as SettingTab's own withDerivedMode does, so a fileRule-only write
  // here never desyncs it from the rules/perElement it's actually driven by.
  private itemFileSharing(ref: ItemRef): FileSharing {
    const parsed = parseItemRef(ref);
    if (parsed === null) return EVERYWHERE;
    return itemAt(this.settings.items, parsed.section, parsed.id)?.settingsFile?.fileRule?.sharing ?? EVERYWHERE;
  }


  // C-#25: the SAME legality test setItemFileSharing's guard throws on below — the Sync Center row
  // calls this to decide whether to offer the menu at all, so "offered" and "accepted" can never
  // disagree.
  private itemFileSharingMenuLegal(ref: ItemRef): boolean {
    const parsed = parseItemRef(ref);
    if (parsed === null) return false;
    const sf = itemAt(this.settings.items, parsed.section, parsed.id)?.settingsFile ?? defaultSettingsFile();
    return fileRuleLegalForMode(deriveMode(sf));
  }

  async setItemFileSharing(ref: ItemRef, sharing: FileSharing): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const parsed = parseItemRef(ref);
    if (parsed === null) return;
    const item = itemAt(this.settings.items, parsed.section, parsed.id) ?? emptyItem();
    const sf = item.settingsFile ?? defaultSettingsFile();
    const mode = deriveMode(sf);
    // C-#25 root cause: writing a fileRule on a fields-mode item used to resolve mode:"fields"
    // below and silently strip the very fileRule this call just wrote — the item's card now never
    // offers this menu (see itemFileSharingMenuLegal above), so reaching here with an illegal mode
    // means a caller ignored that and must be told loudly, not have its write vanish.
    if (!fileRuleLegalForMode(mode)) {
      throw new Error(`setItemFileSharing: "${ref}" is in "${mode}" mode — a whole-file sharing write is illegal there (manifest.ts's fileRule validator only allows plain-mode file groups)`);
    }
    const nextSf: ItemSettingsFile = { ...sf, mode, fileRule: { ...(sf.fileRule ?? { sharing: EVERYWHERE, encrypted: false }), sharing } };
    this.settings.items = withItem(this.settings.items, parsed.section, parsed.id, { ...item, settingsFile: pruneSettingsFile(nextSf) });
    await this.saveSettings();
  }

  // Settings-sync menu for a custom (folder) item (unified grammar task-5 fix round 1): the SAME
  // field and persistence path the Advanced tab's "Devices" dropdown writes
  // (SettingTab.commitGroups → persistCustomItems) — a custom item's device class lives on its
  // own runsOn, not in a settings file, so this is a separate write target from
  // setItemFileSharing above. A no-op if the name isn't (or is no longer) a custom item.
  async setCustomItemDevice(name: string, device: DeviceClass): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const item = itemAt(this.settings.items, "custom", name);
    if (item === undefined) return;
    this.settings.items = withItem(this.settings.items, "custom", name, { ...item, runsOn: { ...(item.runsOn ?? { device }), device } });
    await this.saveSettings();
  }

  // The Stop-syncing menu's "On this device"/"Sync on this device again" read (C-#45, spec §1/§3):
  // true iff this group is in THIS device's own opt-out list (localStorage — never data.json).
  private isDeviceOptedOut(groupName: string): boolean {
    return this.deviceOptOutGroups().includes(this.groupRef(groupName));
  }

  // Every item ref THIS device has opted out of — the guard set for the run/heal seams
  // (captureItems/applyItems payload filtering, backfillLockLabels' tail heal, computeStatuses'
  // synthetic-status treatment; C-#45 spec §4). Refs since v3 (spec §4): the opt-out list moved with
  // the lock and the baselines, because they are one key space and a half-moved one resolves
  // nothing.
  private deviceOptedOutRefs(): Set<string> {
    return new Set(this.deviceOptOutGroups());
  }

  // The Stop-syncing menu's "On this device"/"Sync on this device again" write. Two stores, one
  // gesture (spec 2026-08-11-data-model-hardening.md §2 and its ruling): localStorage is the
  // AUTHORITY — that is the whole point of C-#52, a choice no pull or adopt can overwrite — and
  // the document's carried map is then brought in step for THIS device's id alone, so a device
  // still on the old build (which reads that map and nothing else) is never told something false
  // about us. Other devices' entries are never touched; see withDeviceOptOut.
  // One store, one gesture. The fleet-shared `deviceOptOuts` map this used to keep in step is
  // gone from the document (spec §5, C-#54 phase 2): it only ever existed so a device still on a
  // build that read that map would not lose its own entry when it adopted ours, and no such build
  // can read a v3 document at all — the version gate refuses it and says so. localStorage is the
  // authority, and now the only one.
  async setDeviceOptOut(groupName: string, on: boolean): Promise<void> {
    // §4.2b (review I1): the opt-out list is DERIVED from the document we cannot read (the group
    // name comes from `compiledGroups`) and decides what every future run skips.
    if (this.schemaStopped()) return;
    const ref = this.groupRef(groupName);
    const refs = new Set(this.deviceOptOutGroups());
    if (on) refs.add(ref);
    else refs.delete(ref);
    this.saveDeviceOptOutGroups([...refs]);
  }

  // The More bridge's target item — set here, consumed once by SettingTab.display() via
  // consumePendingSettingsAnchor() below, which expands that item's card and scrolls to it.
  private pendingSettingsDeepLink: ItemRef | null = null;
  private openSettingsAt(ref: ItemRef): void {
    this.pendingSettingsDeepLink = ref;
    const app = this.app as unknown as AppWithSetting;
    // ROOT CAUSE (C-#11, live-traced via console instrumentation on a real build): open() itself
    // re-opens whatever tab was last active — when that's already this plugin's tab (the common
    // case once Settings has been opened here even once), open()'s internal openTabById() already
    // fires SettingTab.display(). openTabById() has no "already active" guard (traced in
    // Obsidian's own compiled Setting class), so the unconditional explicit call below used to
    // re-run display() a second time, resetting activeTab/expanded back to defaults right after
    // the first display() had consumed pendingSettingsDeepLink and applied them — a live-confirmed
    // double render (renderGen incremented twice per open), not a "consume never fires" bug.
    // Call it again only when open() didn't already land us on our own tab — but open() is a
    // no-op while the modal is already showing (no tab change at all), so also force it when we
    // were already active *before* open() ran, or a repeat More click while Settings is already
    // open on our own tab would never re-render to pick up the new pendingSettingsDeepLink.
    const alreadyActive = app.setting.activeTab?.id === this.manifest.id;
    app.setting.open();
    if (alreadyActive || app.setting.activeTab?.id !== this.manifest.id) app.setting.openTabById(this.manifest.id);
  }

  // SettingsHost-facing read-and-clear: the settings tab calls this once per display() so a
  // pending deep link is consumed exactly once per Settings open.
  consumePendingSettingsAnchor(): ItemRef | null {
    const ref = this.pendingSettingsDeepLink;
    this.pendingSettingsDeepLink = null;
    return ref;
  }

  // The item a compiled group belongs to, as the one-string ref localStorage and the Sync Center
  // host both speak — a registry LOOKUP (registry.ts's itemForGroupName), never a parse of the
  // group name. null for a companion group, an enablement carrier, or a name no def claims; a
  // custom item's group name IS its id.
  itemRefForGroup(name: string): ItemRef | null {
    const def = itemForGroupName(this.registryDefs, name);
    if (def !== null) return defRef(def);
    return itemAt(this.settings.items, "custom", name) !== undefined ? itemRef("custom", name) : null;
  }

  // The where-it-runs menu's "This device decides for itself" entry (spec 2026-07-28 §4) — and
  // KeepOnDeviceModal's multi-id "keep extra on this device" batch. Schema v2 (task-2 retarget):
  // this adds every named id's ref to settings.thisDeviceItems and clears the item's device
  // rule; a this-device pin is never a value inside runsOn.
  async addSwitchExceptions(name: string, ids: string[]): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const list = this.listFor(name);
    if (list === null) return; // e.g. enabled-css-snippets: governed by its own perElement map, not this mechanism
    const section = this.sectionForList(list);
    for (const id of ids) {
      this.setLocalMember(itemRef(section, id), true);
      this.clearMemberDevice(section, id);
    }
    await this.saveSettings();
    void this.refreshLocalStatus();
  }

  // The where-it-runs menu's "Desktop only"/"Mobile only" entries; same field the settings
  // card's "Enabled on" writes for those two classes. Masking covers not-installed plugins since
  // the 2026-07-27 enablement fix. A device-class rule always overrides a prior this-device
  // choice, so it clears the id from thisDeviceItems too.
  async setMemberDevice(list: EnablementList, elementId: string, device: "desktop" | "mobile"): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const section = this.sectionForList(list);
    this.setLocalMember(itemRef(section, elementId), false);
    this.settings.items = withItem(this.settings.items, section, elementId, itemWithDevice(itemAt(this.settings.items, section, elementId), device));
    await this.saveSettings();
  }

  // The where-it-runs menu's "Everywhere" entry: clears a prior this-device pin so the member goes
  // back to following the group's normal capture/apply flow, and drops the device axis of any
  // stored rule — needed because the pin does not round-trip through the same field the other
  // three menu entries overwrite.
  async clearMemberLocal(list: EnablementList, elementId: string): Promise<void> {
    if (this.schemaStopped()) return; // §4.2b
    const section = this.sectionForList(list);
    this.setLocalMember(itemRef(section, elementId), false);
    this.clearMemberDevice(section, elementId);
    await this.saveSettings();
    void this.refreshLocalStatus();
  }

  // The runtime mask per switch group = This-device ids (memberLocal) ∪ ids class-scoped away
  // from this device (memberClassesFor) ∪ auto-derived exclusions (community-plugins only:
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
    for (const name of ENABLEMENT_LISTS) {
      const classExcluded = membersExcludedByClass(this.memberClassesFor(name), Platform.isMobile);
      const auto = name === "community-plugins" ? derived : new Set<string>();
      const mask = [...new Set([...this.memberLocalIdsFor(name), ...classExcluded, ...auto])];
      if (mask.length > 0) out[name] = mask;
    }
    return out;
  }

  // Force-off = user class rules enforced on the wrong device class, minus this-device ids
  // (local wins). Auto-derived exclusions are never forced off — they keep local state.
  private memberForceOffIds(group: string): string[] {
    return memberForceOff(this.memberClassesFor(group), this.memberLocalIdsFor(group), Platform.isMobile);
  }

  // A group's PERSISTED local switch-list content — the same file applySwitchList's exception
  // pass-through reads (task-2 fix #1: never a live PluginHost query, which can diverge from what
  // is actually on disk; see availability.ts's forcedRunsOn comment). Absent group/file/unparseable → null,
  // treated as "off" by switchListMemberOn.
  private async localSwitchListFor(name: string): Promise<SwitchList | null> {
    const group = findGroupByName(this.compiledGroups, name);
    if (group === undefined) return null;
    const io = this.configIO();
    const real = localRealPath(name, group.path, this.app.vault.configDir);
    if (!(await io.exists(real))) return null;
    return readLocalSwitchList(name, await io.read(real));
  }

  // This list's stored Runs-on rules, keyed by bare element id. An entry whose shape this build
  // doesn't recognise is dropped FROM THE READ only (invariant II.2): it must not reach the mask
  // below at all — landing there as "no stored rule" would make the id a bare this-device pin and
  // force its switch either way, which is a decision an unknown rule never asked for.
  private storedRunsOnFor(list: EnablementList): Record<string, RunsOn> {
    const out: Record<string, RunsOn> = {};
    for (const [id, item] of Object.entries(this.settings.items[this.sectionForList(list)] ?? {})) {
      const known = asRunsOn(item.runsOn);
      if (known !== undefined) out[id] = known;
    }
    return out;
  }

  // Mask table (Sync Center unified grammar, task 2): every id with either a stored rule or a
  // this-device pin resolves via preferStoredRunsOn (stored wins; otherwise forcedRunsOn against
  // the group's PERSISTED local content, task-2 fix #1) into force on → exception + forceOn, or
  // force off → exception + forceOff (both on top of the class force-off memberForceOffIds
  // already computes).
  private runsOnForces(group: string, persisted: SwitchList | null): { forceOn: string[]; forceOff: string[] } {
    const list = this.listFor(group);
    if (list === null) return { forceOn: [], forceOff: [] };
    const stored = this.storedRunsOnFor(list);
    const ids = new Set([...this.memberLocalIdsFor(group), ...Object.keys(stored)]);
    const forceOn: string[] = [];
    const forceOff: string[] = [];
    for (const id of ids) {
      const rule = preferStoredRunsOn(stored[id], switchListMemberOn(persisted, id));
      if (rule.force?.state === "on") forceOn.push(id);
      else if (rule.force?.state === "off") forceOff.push(id);
    }
    return { forceOn, forceOff };
  }

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    const switchExceptions = await this.augmentedSwitchExceptions(rootPath);
    const ruleForces: Record<string, { forceOn: string[]; forceOff: string[] }> = {};
    for (const name of ENABLEMENT_LISTS) {
      ruleForces[name] = this.runsOnForces(name, await this.localSwitchListFor(name));
    }
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
        for (const name of ENABLEMENT_LISTS) {
          const f = [...new Set([...this.memberForceOffIds(name), ...(ruleForces[name]?.forceOff ?? [])])];
          if (f.length > 0) out[name] = f;
        }
        return out;
      })(),
      switchForceOn: (() => {
        const out: Record<string, string[]> = {};
        for (const name of ENABLEMENT_LISTS) {
          const f = ruleForces[name]?.forceOn ?? [];
          if (f.length > 0) out[name] = f;
        }
        return out;
      })(),
      // No fieldOverlay: compileItems (registry.ts) already merges every app-slice card's rules
      // into the compiled "app" group at settings-compile time — the v3-era runtime overlay
      // (appTabRules/appTabsNonDefault, src/core/appTabs.ts) is superseded and removed.
      groupsIO: {
        read: async () => this.compiledGroups,
        // The sync list is DERIVED from settings.items, not stored directly, so a raw group-list
        // write has no durable home. The only remaining caller
        // is stopSyncing's fallback for a group with no known owner (the hidden aggregate carrier
        // groups) — kept in memory for the rest of the session, never a source of data loss, just
        // non-persistence across a reload.
        write: async (groups) => {
          this.compiledGroups = groups;
        },
      },
      // v3 self copies carry `items` (custom items included), not a compiled groups array — core
      // needs the plugin's registry defs to compile them (storeSelfCopyGroups' contract).
      storeListGroups: (json) => storeSelfCopyGroups(json, this.registryDefs, new Set(Object.keys(this.settings.bratIndex))),
      now: () => new Date().toISOString(),
    };
  }

  // Per-refresh cache (#3): reuses the reader refreshRemoteChecks already cloned for this remote
  // in the current generation, so deepDiff doesn't clone the store a second time. Default (no
  // reuse) always builds fresh and caches it under the current generation — pullFrom/pushTo want
  // the freshest state, not a possibly-stale compare-time snapshot.
  private async createReader(remote: Remote, opts?: { reuse?: boolean }): Promise<ExternalStoreReader> {
    const key = remoteReaderKey(remote);
    if (opts?.reuse === true) {
      const hit = this.readerCache.getReusable(key);
      if (hit !== undefined) return hit;
    }
    const reader = await this.buildReader(remote);
    this.readerCache.store(key, reader);
    return reader;
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async buildReader(remote: Remote): Promise<ExternalStoreReader> {
    if (remote.type === "vault") {
      const { createLocalPathReader } = await import("./external/localPath");
      return createLocalPathReader(remote.storePath);
    }
    const { createGitReader } = await import("./external/gitSource");
    return createGitReader(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path (spec D6):
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async createWriter(remote: Remote): Promise<ExternalStoreWriter> {
    if (remote.type === "vault") {
      const { createLocalPathWriter } = await import("./external/localPath");
      return createLocalPathWriter(remote.storePath);
    }
    const { createGitWriter } = await import("./external/gitSource");
    return createGitWriter(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
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
  // Returns the store paths it deleted, or `null` when the run was refused (§4.2b) — the same
  // "it did not happen" signal the runs already use (see the Sync Center's setLastRun), and the
  // reason it is not an empty array: `[]` is a legitimate outcome (nothing to delete) that the
  // caller records in the run history, so a refusal must be a different value or it gets logged
  // as a success.
  async stopSyncing(groupName: string, deleteStore: boolean): Promise<string[] | null> {
    // §4.1, same rule as the five runs above: this deletes store content BEFORE it touches
    // settings, so leaving it to saveSettings' own refusal would delete first and refuse after.
    // Which files belong to which group is decided by compiledGroups, and this build cannot
    // compile a document it does not understand — the deletion would be a guess.
    if (this.schemaStopped()) return null;
    const group = this.compiledGroups.find((g) => g.name === groupName);
    let deleted: string[] = [];
    if (deleteStore && group !== undefined) {
      const ctx = await this.coreContext();
      const abs = this.groupStoreAbs(ctx, group);
      if (await ctx.io.exists(abs)) {
        const rel = `store/${groupStorePath(group.path)}`;
        if (group.type === "folder") {
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
    // "Custom rules"/"Discovered files"), remove its items.custom entry entirely, since removing
    // the rule is what the Advanced tab means by stopping it — and save. saveSettings persists and recompiles, so the
    // group stays gone across the next settings save instead of being resurrected by an
    // in-memory-only groupsIO write (see coreContext()'s groupsIO comment). Any group name with no
    // known owner (e.g. a future/unrecognized group) falls back to the old in-memory write rather
    // than silently doing nothing.
    const owners = groupOwners(this.registryDefs, this.settings.items)[groupName];
    if (owners !== undefined && owners.length > 0) {
      let nextItems = this.settings.items;
      for (const owner of owners) {
        if (owner.section === "custom") {
          nextItems = withoutItem(nextItems, "custom", owner.id);
          continue;
        }
        const item = itemAt(nextItems, owner.section, owner.id) ?? emptyItem();
        nextItems = withItem(
          nextItems,
          owner.section,
          owner.id,
          owner.companionPath !== undefined
            ? { ...item, companions: (item.companions ?? []).map((c) => (c.path === owner.companionPath ? { ...c, enabled: false } : c)) }
            : { ...item, enabled: false }
        );
      }
      this.settings.items = nextItems;
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
    if (group.type === "folder") return (await listFilesRecursive(ctx.io, abs)).filter((f) => !isJunkPath(f)).length;
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
    const storeGroups = (await ctx.io.exists(selfCopy))
      ? storeSelfCopyGroups(await ctx.io.read(selfCopy), this.registryDefs, new Set(Object.keys(this.settings.bratIndex)))
      : [];
    const out: { rel: string; name: string; path: string; size: number }[] = [];
    for (const lf of leftoverStoreRels(rels, [...this.compiledGroups, ...storeGroups])) {
      const st = await this.app.vault.adapter.stat(`${ctx.rootPath}/${lf.rel}`);
      out.push({ ...lf, size: st?.size ?? 0 });
    }
    return out;
  }

  // Returns the store rels it deleted, or `null` when refused — same signal and same reasoning as
  // stopSyncing above (§4.2b).
  async deleteLeftoverStoreFiles(rels: string[]): Promise<string[] | null> {
    // §4.1: "leftover" means "no compiled group claims this file", and under the stop state the
    // compile ran against a document this build cannot fully read — a file a newer item legitimately
    // owns would look deletable. Refuse rather than delete on a guess.
    if (this.schemaStopped()) return null;
    const ctx = await this.coreContext();
    const deleted: string[] = [];
    for (const rel of rels) {
      const abs = `${ctx.rootPath}/${rel}`;
      if (await ctx.io.exists(abs)) {
        await ctx.io.remove(abs);
        deleted.push(rel);
      }
    }
    return deleted;
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
    return listPluginSections(this.pluginRuntime(), groups, new Set(Object.keys(this.settings.bratIndex)));
  }

  async listBetaSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listBetaSections(this.pluginRuntime(), groups, this.settings.bratIndex);
  }

  // Local-only status for the Beta tab's map-note (no network): index size vs BRAT's list.
  async bratScanStatus(): Promise<{ resolved: number; total: number }> {
    const repos = await this.bratRepos();
    const resolved = Object.values(this.settings.bratIndex).filter((r) => repos.includes(r)).length;
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

  // Drops every cached per-refresh reader (#3): called after the remote list (URL/branch/subdir/
  // storePath) changes, so a stale reader for the old config can never be served to a later
  // deepDiff({ reuse: true }) — see SettingTab.ts's saveRemotes, the sole place remotes mutate.
  clearReaderCache(): void {
    this.readerCache.clear();
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
  // listing (spec §4 "成员行"; task-7-brief.md). No per-member sharing: an arbitrary folder group
  // has no per-file sharing mechanism today (only the three named switch lists in
  // SWITCH_LISTS do), so this is informational-only, unlike listSnippetFiles above.
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
    const dirExists = group.type === "folder" && (await io.exists(real));
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

  // The load-time version gate (classifySettings, spec 2026-08-11-data-model-hardening.md §4.1).
  // `migrate` — a v2 document is brought forward field by field (spec 2026-08-11-v3-one-vocabulary
  // §5) and saved once, silently: nothing was reset, so nothing is announced. `legacy` — a v1 or
  // unversioned document has no field a v3 shape could be reconstructed from, so the plugin starts
  // fresh with defaults and asks the user to reconfigure. `future` is the case this gate was split
  // out for: the old `schemaVersion !== CURRENT` test sent a document from a NEWER build down that
  // same reset branch, and since data.json travels between a user's devices wholesale, one updated
  // device could wipe the setup of every device that hadn't updated yet. A fresh install (no
  // data.json yet) is none of them; it just gets the defaults silently.
  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Record<string, unknown> | null;
    const load = classifySettings(data);
    if (load.kind === "future") {
      this.schemaStop = { found: load.found };
      // Said once, here, and not only to whoever opens the Sync Center (§4.2b): a device that has
      // silently stopped syncing is the failure this release exists to prevent, so it must be
      // visible without the user going looking. Same mechanism and duration as the legacy branch's
      // own notice below — and it seeds the same quiet window every other refusal shares
      // (final-review N1), or a gesture within REFUSAL_NOTICE_MS would stack a second copy of this
      // exact sentence beside the one still on screen, which is what that window exists to prevent.
      this.lastRefusalNoticeAt = Date.now();
      new Notice(SCHEMA_FUTURE_NOTICE, REFUSAL_NOTICE_MS);
      // The document's own values, not defaults over them — and no save, here or anywhere else,
      // while the stop state holds (see saveSettings and the Sync Center's entry points). Loading
      // the real document also means the settings tab shows the user their own setup rather than
      // an empty one, and nothing this build might still write could flatten it to defaults.
      this.settings = withDefaults(DEFAULT_SETTINGS, data);
      return;
    }
    this.schemaStop = null;
    // Quick commands moved to the Ribbon Organizer plugin in 1.7.0; drop the stale key so the
    // next save cleans data.json. C-#45 fix-round 1: an earlier build of the device-opt-out
    // feature (never released/committed) briefly stored the device identity as a settings field
    // (`deviceId`) — a reviewer-caught CRITICAL, since data.json travels wholesale (git-tracked
    // vaults, remotely-save, manual copies) and a value trusted from an inherited data.json would
    // let a bootstrapped machine silently claim the source machine's identity. The identity now
    // lives only in localStorage (see the deviceId() method below); dropping a stray leftover key
    // here is ignore-and-prune, not migrate — the field never shipped to a real user (no release,
    // no commit), so there is nothing meaningful to carry forward, only a local/dev-testing
    // artifact to sweep off the next save.
    //
    // Ahead of the migrate branch, not after it (fix round 1, review M6): a v2 document is the one
    // most likely to still carry both, and the migration SAVES — so leaving the sweep downstream
    // would deliberately write a stray `deviceId` back to disk for one cycle. It is skipped for a
    // `future` document (which returned above) because this build owns nothing there.
    if (data !== null) {
      delete data.quickCommands;
      delete data.deviceId;
    }
    if (load.kind === "migrate") {
      // `data ?? {}` only to satisfy the compiler: classifySettings answers "fresh" for a null
      // document, so "migrate" always comes with one. migrateV2Settings is total either way — it
      // returns any non-v2 document untouched — so this can never take a different branch by
      // accident the way a `data !== null` guard falling through to `legacy` would.
      const { document, carriedDeviceOptOuts } = migrateV2Settings(data ?? {});
      this.settings = withDefaults(DEFAULT_SETTINGS, document);
      // localStorage FIRST, the document second. The two stores are written back to back and a
      // crash between them has to leave a state the next load recovers from: with this order that
      // state is "still a v2 document, opt-outs already absorbed", which migrates again cleanly
      // (the absorb is a union, so it is idempotent). The other order would leave a v3 document
      // whose opt-out map is gone and never reached localStorage — an unrecoverable loss of the
      // user's "don't sync this here" choices.
      this.absorbCarriedDeviceOptOuts(carriedDeviceOptOuts);
      // saveData, not saveSettings(): the migration saves ONCE, and recompiling here would be a
      // second compile before onload's own (loadSettings is always followed by a recompile — see
      // onload and reloadSettings). No Notice either: the setup is intact, so there is nothing to
      // tell the user.
      await this.saveData(this.settings);
      return;
    }
    if (load.kind === "legacy") {
      new Notice(SCHEMA_UPGRADE_NOTICE, 10000);
      // withDefaults, not a `{ ...DEFAULT_SETTINGS }` spread: that shares DEFAULT_SETTINGS' own
      // nested objects (runHistory/ribbonButtons) by reference, and the settings tab edits them in
      // place — one toggle after a reset would rewrite the defaults for the rest of the session.
      this.settings = withDefaults(DEFAULT_SETTINGS, null);
      return;
    }
    this.settings = withDefaults(DEFAULT_SETTINGS, data);
    // `runsOn` is deliberately NOT sanitized here (spec 2026-08-11-data-model-hardening.md §3.2,
    // invariant II.2): the load path used to drop every value this build doesn't know and save
    // immediately, which turned a NEWER build's rule into a deletion this device then pushed to
    // the whole fleet. An unrecognised value is ignored where it is consumed instead (types.ts's
    // asRunsOn) and stays on disk exactly as written.
  }

  // The answer every mutating entry point gives while the §4.1 stop state holds: true means the
  // caller must stop, having written nothing, and the user has been told why in the same words the
  // Sync Center's banner uses. Refusal, not silent recovery — a toggle that quietly did nothing
  // would be indistinguishable from a save that worked.
  //
  // The REFUSAL is never suppressed; only a repeat of the same notice while the previous one is
  // still on screen is (round-4 review N4 — REFUSAL_NOTICE_MS is both its lifetime and the quiet
  // window, so the two can't drift apart). The settings tab's text fields refuse per KEYSTROKE,
  // and a notice per character is worse than silence: a storm teaches the user to ignore the one
  // message that matters. Suppressing here rather than special-casing the text fields keeps one
  // rule to reason about, and nothing is lost — the message the second gesture would have raised
  // is the same sentence the user is still looking at.
  private lastRefusalNoticeAt = 0;
  private schemaStopped(): boolean {
    if (this.schemaStop === null) return false;
    const now = Date.now();
    if (now - this.lastRefusalNoticeAt >= REFUSAL_NOTICE_MS) {
      this.lastRefusalNoticeAt = now;
      new Notice(SCHEMA_FUTURE_NOTICE, REFUSAL_NOTICE_MS);
    }
    return true;
  }

  // SettingsHost-facing (§4.2b): may the settings tab write right now? Asking IS the refusal —
  // the notice fires here, on the user's own gesture — because every writer in that file is
  // mutate-then-save and `saveSettings` refuses too late to undo the mutation. A writer that only
  // learned at save time left memory diverged from disk with no recompile.
  settingsWritable(): boolean {
    return !this.schemaStopped();
  }

  async saveSettings(): Promise<void> {
    // The choke point for every settings writer, the settings tab's own included (§4.1): a
    // document written by a newer build is never written back by this one. Our shape would flatten
    // the fields we cannot see, and the result would travel to the user's other devices.
    if (this.schemaStopped()) return;
    await this.saveData(this.settings);
    await this.recompile();
  }

  // Reloads settings from disk and recompiles immediately — the shared shape for "something just
  // rewrote our own data.json externally and compiledGroups must reflect it right now" (a
  // self-group apply, see adoptConfiguration/applyItems). loadSettings() alone leaves
  // compiledGroups stale until the next unrelated saveSettings() or a restart.
  private async reloadSettings(): Promise<void> {
    await this.loadSettings();
    if (await this.recompile()) this.rekeyDeviceStores();
  }

  /**
   * The §4 re-key of this device's own two stores — the baselines and the opt-out list — from
   * compiled group names to item refs. Runs after every compile, not only after the v2 → v3 document
   * migration, and both halves are idempotent (the ledger by its own version, the opt-out list by
   * the shape of its entries), so a crash between the two writes finishes on the next load rather
   * than leaving one store in each vocabulary.
   *
   * AFTER a SUCCESSFUL compile, deliberately: the conversion asks the compiler what each name's ref
   * is (itemKeys.ts's lockRefFor), so it can only run once compiledGroups is both present and
   * trustworthy — see recompile's return value, and its callers, which is where that precondition is
   * enforced. Nothing is dropped (see rekeyLedger) and nothing is written while the §4.2b stop state
   * holds, because both stores describe a document this build has declared it cannot read.
   *
   * The ledger's version is stamped by the same call that does the work, so there is no window in
   * which the flag says "moved" and the keys disagree; the opt-out list needs no flag at all,
   * because its entries say for themselves whether they have moved (rekeyRefList). What made the
   * stamp dangerous was never its timing but its INPUT, which is why the guard is on the compile.
   */
  private rekeyDeviceStores(): void {
    if (this.schemaStop !== null) return;
    const toRef = lockRefFor(this.compiledGroups);
    const ledger = this.loadBaselines();
    const movedLedger = rekeyLedger(ledger, toRef);
    if (movedLedger !== ledger) this.saveBaselines(movedLedger);
    const optOuts = this.deviceOptOutGroups();
    const movedOptOuts = rekeyRefList(optOuts, toRef);
    if (movedOptOuts.length !== optOuts.length || movedOptOuts.some((r, i) => r !== optOuts[i])) this.saveDeviceOptOutGroups(movedOptOuts);
  }
}
