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
  STORE_LOCK_MISSING_MESSAGE,
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

// Structural view of app.secretStorage, which manifest.json's minAppVersion guarantees is present.
// TODO: drop the detection and the localStorage fallback below. They are dead on every supported
// Obsidian version; removing them needs one release where no user reports falling back, and nothing
// currently reports it. The git-token path already uses the typed SecretStorage directly.
interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}
import { bratRepoIndex, parseBratRepoList, resolveBratIndex, withBratRepos } from "./core/bratIndex";
import { type CatalogSection, corePluginFile, displayLabelForGroup, findGroupByName, listBetaSections, listCoreSections, listDiscovered, listOptionSections, listPluginSections, SELF_GROUP_NAME, SELF_ITEM_ID, SELF_ITEM_SECTION, setCorePluginIds } from "./core/catalog";
import { Availability, availabilityForGroup, desktopOnlyDrift, desktopOnlyPluginIds } from "./core/availability";
import { listFilesRecursive, isJunkPath, FileIO } from "./core/io";
import { LeftoverNames, LeftoverSection, leftoverStoreRels, storeSelfCopyGroups, selfListGroups } from "./core/leftover";
import { lockEntry, lockLabel, parseStoreLock, STORE_LOCK_FUTURE_MESSAGE, validateSyncManifest } from "./core/manifest";
import { lockRefFor, rekeyRefList } from "./core/itemKeys";
import { SettingsDeepLink, SettingsSpot } from "./ui/settingsDeepLink";
import { lockStoredLabel, resolveHostStoredLabel } from "./core/lockLabels";
import { basename, groupRealPath, groupStorePath, sidecarStoreSuffix } from "./core/pathing";
import {
  buildItemDefs,
  CompileError,
  defaultSettingsFile,
  defsForForeignItems,
  deriveMode,
  emptyItem,
  emptyItemMap,
  ENABLEMENT_LISTS,
  groupOwners,
  GroupDisplayParts,
  defForRef,
  defRef,
  itemAt,
  ItemDef,
  itemForGroupName,
  ItemMap,
  ItemSettingsFile,
  compileItems,
  parentCardLabel,
  pruneSettingsFile,
  RegistryEnv,
  withItem,
  withoutItem,
} from "./core/registry";
import { enablementRuleFor, enablementRules, RuleListId, withEnablementRule } from "./core/enablementRules";
import { DEVICE_ELEMENTS_KEY, DeviceElements, DeviceElementState, deviceElementIds, deviceElementState, parseDeviceElements, withDeviceElement } from "./core/deviceElements";
import { DEVICE_FIELDS_KEY, DeviceFields, deviceFieldExcepted, fieldExceptionsByGroupName, parseDeviceFields, withDeviceField } from "./core/deviceFields";
import { decideEnablement, EnablementDecision } from "./core/enablementDecision";
import { classifySettings, CURRENT_SCHEMA, SCHEMA_FUTURE_NOTICE, SCHEMA_UPGRADE_NOTICE, withDefaults } from "./core/settingsMigration";
import { deviceOptOutsFor, migrateV2Settings } from "./core/v2Migration";
import { migrateV4Settings } from "./core/v4Migration";
import { refsBlockedFor } from "./core/remoteRules";
import { migrateV5Settings } from "./core/v5Migration";
import { applySwitchList, captureSwitchList, EnablementList, enablementListFile, isSwitchListGroup, localRealPath, parseSwitchList, readLocalSwitchList, subtractForceOff, switchDivergence, SwitchList, switchListMemberOn, writeLocalSwitchList } from "./core/switchList";
import { applyTransform, captureTransform, isWholeFileEncrypted, scanSensitive, SensitiveScan } from "./core/modes";
import { PkmMode, PkmProbe, resolveEffectiveMode, resolveRootPath } from "./core/pkm";
import { pluginRuntimeEnabled } from "./core/pluginState";
import { syncListDelta } from "./core/syncListDelta";
import { selfPaneState } from "./core/selfPane";
import { applyUpdates, baselineRefs, Ledger, LEDGER_VERSION, parseLedger, pruneLedger, rekeyLedger } from "./core/ledger";
import { bucketCounts, checkRemote, diffRemote, GroupStatus, remoteDirectionCounts, RemoteCheck, remoteLockAhead, remoteLockLabels, statusForGroups } from "./core/status";
import { EVERYWHERE, FileSharing, GroupResult, itemRef, ItemRef, parseItemRef, Remote, RibbonButtons, Sharing, StoreLock, SyncGroup, SyncMode } from "./core/types";
import { statusBarStatuses } from "./ui/panelModel";
import { ConflictModal } from "./ui/ConflictModal";
import { renderStatusBarItem, statusBarSegments } from "./ui/statusBar";
import { SYNC_CENTER_VIEW_TYPE, SelfSyncInfo, SyncCenterHost, SyncCenterView } from "./ui/SyncCenterView";
import { ConfigSyncSettingTab } from "./ui/SettingTab";

// Settings schema v4. The sync list is not a
// stored SyncGroup[] — it is COMPILED (registry.ts's compileItems) from `items` on every
// load/save. Structure carries the taxonomy: `items` nests by section, and `custom` is one of
// those sections rather than a second data shape. The literal type is deliberate: it is the one
// place a schema bump must be acknowledged in the type system, and it must move together with
// settingsMigration.ts's CURRENT_SCHEMA (which DEFAULT_SETTINGS below reads, so the two can never
// disagree about what this build writes).
interface ConfigSyncSettings {
  schemaVersion: 5;

  // Transport wiring — the locked-local preset (catalog.ts's selfPresetRules); never travels.
  pkmMode: PkmMode;
  rootPath: string; // "" = follow the PKM mode default
  remotes: Remote[];

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
  runHistory: { enabled: true, path: "", maxCount: 50, maxDays: 30 },
};

// How long the schema-stop refusal notice stays ON SCREEN — and, for exactly that long, how long the same
// message stays quiet after being raised (schemaStopped). One literal, one rule: never two copies
// of the same sentence at once. A run of keystrokes in a settings text field therefore raises it
// once, while a gesture made after it has faded gets its own answer; the refusal itself is never
// suppressed, only the repeat of the message.
const REFUSAL_NOTICE_MS = 10000;

// Our own refusals about the store at the other end, as opposed to a transport failure: each one
// already says what to do, so the pull/push notices append no generic "check the remote's URL"
// advice on top of it.
function isOwnStoreRefusal(message: string): boolean {
  return message === STORE_LOCK_FUTURE_MESSAGE || message === STORE_LOCK_MISSING_MESSAGE;
}

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
// replacement for "reload the app".
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
// activeTab is read by openSettingsAt to avoid re-opening a tab open() already activated
// (see openSettingsAt).
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
  // Compiled engine state: the sync list is DERIVED from settings.items, never stored
  // directly. Recomputed on load and after every settings save (see saveSettings/recompile).
  private registryDefs: ItemDef[] = [];
  private compiledGroups: SyncGroup[] = [];
  remoteChecks = new Map<string, { check: RemoteCheck; at: number }>();
  private storeEventTimer: number | null = null;
  private remoteAutoCheckStartupTimer: number | null = null;
  // Per-refresh reader cache: a compare (deepDiff) reuses the reader refreshRemoteChecks
  // already built for the same remote in this generation, instead of cloning the store again.
  private readerCache = new ReaderCache<ExternalStoreReader>(() => Date.now());
  // Live progress for a global refresh: non-null only while refreshRemoteChecks
  // is running, so the Sync Center can paint a working state before the first clone completes.
  private remoteRefreshProgress: { total: number; done: number } | null = null;
  // Two overlapping refreshes must not share one remoteRefreshProgress (done could pass total,
  // and the first finisher would null progress out from under the still-running second). A second
  // call while one is in flight returns the SAME promise instead of starting a parallel run.
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
  // Newer-schema stop state: non-null when
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
  // Returns whether the compile SUCCEEDED — not a courtesy, a precondition. The baseline
  // re-key keys every baseline against `compiledGroups`, and a failed compile leaves that list
  // empty (or last-good), so the re-key would resolve nothing and file every companion and custom
  // rule under `legacy/…` — then stamp the ledger's new version, so it is never retried. One bad
  // custom rule name is enough to get there, and the user sees only a generic Notice.
  private async recompile(): Promise<boolean> {
    const env = await this.registryEnv();
    // defsForForeignItems, not a bare buildItemDefs: settings.items can carry a selected-but-
    // uninstalled plugin (e.g. install-on-apply's pending target), which env.plugins doesn't see
    // yet — without the synthesized def that item would have no group to compile into.
    this.registryDefs = defsForForeignItems(buildItemDefs(env), this.settings.items, env.betaIds);
    // Defense-in-depth: captured explicitly so "keep the last-good compiled list on failure" is
    // provable rather than incidental — relying on the catch branch merely not reassigning
    // this.compiledGroups would be fragile to a future refactor that adds a second assignment
    // inside the try block. At first-load failure
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
    const betaIds = new Set(Object.keys(bratRepoIndex(this.settings.items)));
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
      // An opted-out group never runs a real comparison on this device — dropped
      // the same way groupsForDevice's own device-class filter already drops a scope-mismatched
      // group, before status/ledger/the ribbon count ever see it.
      const optedOut = this.deviceOptedOutRefs();
      const scoped = groupsForDevice(manifest, device).filter((g) => g.ref === undefined || !optedOut.has(g.ref));
      const ledger = this.loadBaselines();
      const { statuses, updates } = await statusForGroups(ctx, scoped, ledger);
      this.localStatuses = statuses;
      // The prune's keep-set is the WHOLE compile (`manifest.groups`), never `scoped`. `scoped` is
      // what this device COMPARES right now — already narrowed by the opt-out list and by the
      // device-class filter — and both of those are reversible choices, not statements that an item
      // stopped existing. Pruning by them deleted the baseline of every opted-out (and every
      // class-scoped-away) item on the very next refresh, so opting back in found no baseline and
      // groupStatus fell to `never-synced`: a row that was "↑ capture my newer settings" came back
      // as "↓ apply the store over me", and an item with companions rolled that up into a phantom
      // `Changed on both sides`. The prune still does its real job — an item deleted from the
      // config leaves `manifest.groups`, so its entry still goes.
      this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), baselineRefs(manifest.groups)));
      // Presented buckets for the ribbon dot: version-ahead in-sync items count as to-capture,
      // matching the panel (0.23.4/0.23.5) — no crypto cost, just a lock read.
      let lock: StoreLock | null = null;
      try {
        lock = await loadLock(ctx);
      } catch {
        lock = null;
      }
      const host = this.pluginHost();
      // Startup heal (backfillLockLabels):
      // a fresh device with no local store yet is a no-op (lock === null) — the flag still
      // flips so a later pull's lock never gets a second heal attempt bolted onto this same load.
      // `optedOut`: the heal must not resurrect/write a lock entry this device
      // deliberately never captures.
      // The stop state writes NOTHING to either side, and this heal is the one remaining
      // store write on the startup path — cosmetic labels, but an exception here is the kind that
      // grows. Read straight off the field instead of through schemaStopped(): this runs on a
      // timer with no user gesture behind it, and a notice would fire again every refresh cycle.
      // `lockLabelsHealed` stays false while stopped, so a load that clears the stop state still
      // gets its one heal.
      // This is the fourth writer of store.lock.json, and it fires at
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
        Platform.isMobile,
        { selfGroup: SELF_GROUP_NAME, parentOf: (g) => this.companionParentOf(g) }
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
        // The same ignore list `remoteLockAhead` gets for this remote: an item it never pulls must
        // not have its direction decided by that item's lock entry — the two sides diverge there by
        // design, and no Pull could ever clear the arrow.
        const ignore = refsBlockedFor(remote.items, "pull");
        this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader, ignore, this.compiledGroups), at: Date.now() });
      } catch (e) {
        this.remoteChecks.set(remote.name, { check: { state: "unknown", remoteCapturedAt: null, items: null }, at: Date.now() });
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
        // groupsForDevice drops a scope-mismatched group before it ever reaches
        // statusForGroups — comparing its content across device classes would be meaningless (the
        // store copy may belong to a different device's rule entirely), so it correctly never runs
        // capture/apply/status for these. Without the split below, that same drop would make the
        // item invisible in the Sync Center, not merely mislabeled — no row, no availability
        // entry, nothing for the fate layer to read. These groups still get a row here: a
        // synthetic, never-comparison-run "in-sync" status so computeFateInput's excludedHere
        // (SyncCenterView.ts) can author the honest sentence instead of the row vanishing.
        const excludedGroups = manifest.groups.filter((g) => g.devices !== "all" && g.devices !== device);
        // A device-opted-out group
        // IS this device's class (groupsForDevice never drops it) — a run must still skip it, so
        // it's split out of the real run set the SAME way excludedGroups is, and gets the SAME
        // synthetic-neutral-status treatment so rowFate's excluded branch
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
        // `lastGroups`, not `groups`: see refreshLocalStatus's note above. `groups` here is already
        // minus the class-excluded and minus the opted-out, and pruning by it deletes exactly the
        // baselines those two reversible choices must never touch. `lastGroups` is the reunion of
        // all three, computed one line above for the panel — the same "everything this device
        // compiles" set the keep-set wants.
        this.saveBaselines(pruneLedger(applyUpdates(ledger, updates), baselineRefs(this.lastGroups)));
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
        // Keep the status bar's snapshot in step with THIS compute (not only with
        // refreshLocalStatus), and count with the center's own lens (statusBarStatuses: self out,
        // companions folded into their parent, desktop-only dropped) so the bar reads the same rows
        // the center lists. Excluded groups (class rule AND device opt-out) stay out of this count
        // (always-neutral, never up/down either way).
        this.presentedStatuses = statusBarStatuses(statuses, (name) => availability[name], Platform.isMobile, {
          selfGroup: SELF_GROUP_NAME,
          parentOf: (g) => this.companionParentOf(g),
        });
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
        const betaIds = new Set(Object.keys(bratRepoIndex(this.settings.items)));
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
          // The same one derivation the run itself uses, so a preview can never show what a run
          // would not do.
          const decisions = this.decisionsByList();
          const exc = isSwitchListGroup(name) ? ((await this.augmentedSwitchExceptions(rootPath, decisions))[name] ?? []) : [];
          // Same producer coreContext() feeds ctx.fieldExceptions from (fieldExceptionsByGroupName) —
          // a preview must not show what a real capture/apply would do while ignoring this device's
          // own per-key exceptions.
          const fieldExc = fieldExceptionsByGroupName(this.deviceFields(), this.compiledGroups)[name] ?? [];
          const cls: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
          if (dir === "capture") {
            let produced = local ?? "";
            if (group.type === "file" && local !== null) {
              if (isSwitchListGroup(name)) {
                const l = readLocalSwitchList(name, local);
                if (l !== null) produced = serialize(captureSwitchList(l, store !== null ? parseSwitchList(store) : null, exc));
              } else if (group.mode === "fields") {
                produced = (await captureTransform(group, local, this.passphrase(), cls, store, undefined, fieldExc)).content;
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
                const fo = this.forcedFrom(decisions, "off")[name] ?? [];
                produced = writeLocalSwitchList(name, subtractForceOff(merged, fo), local);
              }
            } else if (group.mode === "fields") {
              const sidecarPath = `${storeBase}${sidecarStoreSuffix(cls)}`;
              const ownScope = (await io.exists(sidecarPath)) ? await io.read(sidecarPath) : null;
              produced = await applyTransform(group, store, local, this.passphrase(), cls, ownScope, fieldExc);
            }
          }
          return { base: local ?? "", produced };
        } catch {
          return null; // e.g. passphrase needed for field encryption — no diff available
        }
      },
      isDesktopOnlyPlugin: (id) => {
        const manifest = this.pluginRegistry().manifests[id];
        return manifest === undefined ? null : manifest.isDesktopOnly === true;
      },
      betaIds: () => new Set(Object.keys(bratRepoIndex(this.settings.items))),
      runHistoryEnabled: () => this.settings.runHistory.enabled,
      loadRunHistory: () => this.loadRunHistory(),
      appendRunHistory: (kind, remote, results) => this.appendRunHistory(kind, remote, results),
      clearRunHistory: () => this.clearRunHistory(),
      deviceOptedOut: (groupName) => this.isDeviceOptedOut(groupName),
      setDeviceOptOut: (groupName, on) => this.setDeviceOptOut(groupName, on),
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
      enablementRuleFor: (list, elementId) => this.enablementRuleFor(list, elementId),
      setEnablementRule: (list, elementId, sharing) => this.setEnablementRule(list, elementId, sharing),
      deviceElementFor: (list, elementId) => this.deviceElementFor(list, elementId),
      leaveToThisDevice: (list, elementId) => this.leaveToThisDevice(list, elementId),
      followTheDefault: (list, elementId) => this.followTheDefault(list, elementId),
      setDeviceElement: (list, elementId, state) => this.setDeviceElement(list, elementId, state),
      itemFileSharing: (ref) => this.itemFileSharing(ref),
      itemFileSharingMenuLegal: (ref) => this.itemFileSharingMenuLegal(ref),
      setItemFileSharing: (ref, sharing) => this.setItemFileSharing(ref, sharing),
      openSettingsAt: (ref, spot) => this.openSettingsAt(ref, spot),
      itemRefForGroup: (name) => this.itemRefForGroup(name),
      schemaStop: () => this.schemaStop,
      settingsWritable: () => this.settingsWritable(),
      adoptConfiguration: async () => {
        // Schema stop: adopt is the one entry point that rewrites this device's own data.json wholesale —
        // the very document the stop state is protecting.
        if (this.schemaStopped()) return null;
        try {
          // config-sync's own registry item (registry.ts builds one for every installed plugin,
          // itself included) compiles to the same legacy group name (SELF_GROUP_NAME) the self-
          // propagation apply below expects — enable it so compileItems actually emits that group.
          const selfItem = itemAt(this.settings.items, SELF_ITEM_SECTION, SELF_ITEM_ID);
          if (selfItem?.synced !== true) {
            this.settings.items = withItem(this.settings.items, SELF_ITEM_SECTION, SELF_ITEM_ID, { ...(selfItem ?? emptyItem()), synced: true });
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
        if (this.schemaStopped()) return null; // schema stop
        try {
          const ctx = await this.coreContext();
          // Runner-level guard, not just the UI's own stageable:false — an
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
        if (this.schemaStopped()) return null; // schema stop
        try {
          const ctx = await this.coreContext();
          // Same runner-level guard as captureItems — apply never installs/
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
        // Comparison answers for both directions at once, so an item held back in either one has no
        // difference this pane could offer to act on.
        const skipRefs = [...new Set([...refsBlockedFor(remote.items, "pull"), ...refsBlockedFor(remote.items, "push")])];
        const entries = await diffRemote(ctx, reader, { skipRefs });
        // A lock-only delta (version-refresh capture on the other side) is real pull payload
        // even when every store file matches — surface it so the hint isn't contradictory.
        let lockDiffers = false;
        let remoteLabels: Record<string, string> = {};
        try {
          const remoteLock = (await reader.listFiles()).includes("store.lock.json") ? await reader.readFile("store.lock.json") : null;
          const localLock = (await ctx.io.exists(`${ctx.rootPath}/store.lock.json`)) ? await ctx.io.read(`${ctx.rootPath}/store.lock.json`) : null;
          lockDiffers = remoteLockAhead(localLock, remoteLock, refsBlockedFor(remote.items, "pull"), this.compiledGroups);
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
      pullFrom: async (remote, skipRefs) => {
        if (this.schemaStopped()) return null; // schema stop
        try {
          const ctx = await this.coreContext();
          const blocked = refsBlockedFor(remote.items, "pull");
          const pending = await planImport(ctx, await this.createReader(remote), { skipRefs: [...new Set([...blocked, ...skipRefs])] });
          // Pull resolves file conflicts only; sync-list (definition) conflicts are never
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
          // The newer-lock refusal already says what to do (update Config Sync) — appending the
          // check-your-URL advice would send the user after a problem they do not have. Same
          // reasoning as the no-token case, which is likewise our own refusal, not a transport
          // failure, and as the own-store refusal's, which says something more specific about
          // the path than the generic advice could.
          const advice = classifyRemoteFailure(message) === "no-token" || isOwnStoreRefusal(message) ? "" : " — check the remote's URL or path and try again.";
          new Notice(`Config Sync pull failed: ${message}${advice}`, 10000);
          return null;
        }
      },
      pushTo: async (remote, skipRefs) => {
        if (this.schemaStopped()) return null; // schema stop
        try {
          const ctx = await this.coreContext();
          const blocked = refsBlockedFor(remote.items, "push");
          const results = await pushExternal(ctx, await this.createWriter(remote), { skipRefs: [...new Set([...blocked, ...skipRefs])] });
          await this.refreshRemoteChecks();
          return results;
        } catch (e) {
          const message = (e as Error).message;
          const advice = classifyRemoteFailure(message) === "no-token" || isOwnStoreRefusal(message) ? "" : " — check the remote's URL or path and try again."; // see pullFrom
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

  // Stop-state refusal: a baseline is the fingerprint of a group this device believes it syncs, and
  // that belief comes from `compiledGroups` — compiled from a document this build cannot read. Two
  // devices never see each other's baselines, so this is not "something another device can see";
  // it is refused for the other half of the rule: writing it records a fiction, and direction
  // (`local-changed`/`store-newer`) is decided from it afterwards. Silent, like the other
  // status-path refusals: this runs on a timer with no user gesture behind it. The device's own
  // scratch preferences that read nothing from the document — the passphrase above, the cold-start
  // dismissal below, clearing the run history on request — are deliberately NOT refused.
  //
  // Two more preconditions, both here rather than at the call sites
  // because this is the ONE writer every baseline write goes through — the status refresh, the Sync
  // Center's compute, the self pane and the ref re-key alike. Gating the re-key alone leaves the status
  // path free to do the same damage by a different road: with `compiledGroups` empty after a failed
  // compile, its prune keeps nothing and persists an EMPTY ledger, and every item then reads as
  // never-synced, whose default direction is APPLY — exactly what the re-key's gate was filed for.
  //
  // 1. The compile must have SUCCEEDED. A baseline is keyed by, and pruned against, the compiled
  //    list; a list this build could not produce is not evidence about anything.
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

  // This device's own identity. The opt-out list is not keyed by it, so the only reader is the
  // migration that absorbed the old shared map, which needs it to tell this device's entry from the
  // other devices' in that map. MUST live
  // in localStorage, never data.json: data.json travels wholesale (git-tracked vaults,
  // remotely-save, manual copies), and a value trusted from an inherited data.json would let a
  // bootstrapped machine silently claim the source machine's identity — and with it that machine's
  // opt-outs (a settings-field home for this id would have exactly that hole).
  // localStorage is per-vault, per-device, invisible to vault-wide sync
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

  // The group names THIS device has opted out of.
  // It lives next to the device id above because it lives BY it: a datum true only of this
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

  // The localStorage half of dropping the carried `deviceOptOuts` map, run once by the v2 → v3 migration.
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
    // settings map follows, so opting out and back in leaves the store as it was found.
    this.app.saveLocalStorage("config-sync-device-optouts", names.length > 0 ? JSON.stringify(names) : null);
    this.deviceOptOutsCache = [...names];
  }

  // Parsed at most once per load — this is read per rule row per render, same discipline as
  // deviceOptOutsCache above.
  private deviceFieldsCache: DeviceFields | null = null;

  // Unreadable ⇒ an empty table. Never thrown, and NEVER written back: a shape this build does not
  // recognise may be a newer build's, and rewriting it here would destroy that device's own answer.
  private deviceFields(): DeviceFields {
    if (this.deviceFieldsCache !== null) return this.deviceFieldsCache;
    this.deviceFieldsCache = parseDeviceFields(this.app.loadLocalStorage(DEVICE_FIELDS_KEY));
    return this.deviceFieldsCache;
  }

  private saveDeviceFields(table: DeviceFields): void {
    this.app.saveLocalStorage(DEVICE_FIELDS_KEY, JSON.stringify(table));
    this.deviceFieldsCache = table;
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
      // Resolution order: BRAT index → community catalog. An unmapped id gets one
      // last-chance index refresh before falling back to the catalog path.
      this.installFn = async (id: string, onPhase?: (phase: string) => void, targetVersion?: string): Promise<string> => {
        // Installs run strictly sequentially, so a single field safely carries the active
        // item's phase callback into the retry closures (catalog download / BRAT).
        this.installPhase = onPhase;
        if (itemAt(this.settings.items, "community", id)?.bratRepo === undefined) await this.refreshBratIndex();
        const repo = itemAt(this.settings.items, "community", id)?.bratRepo;
        if (repo !== undefined) {
          // BRAT-managed plugins track their own beta channel — version-pinning applies to the
          // community-catalog path only.
          onPhase?.("downloading via BRAT…");
          return this.installViaBrat(id, repo);
        }
        onPhase?.("downloading from the community catalog…");
        return catalogInstall(id, targetVersion);
      };
    }
    return this.installFn;
  }

  // Run history is local-only and never synced.
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
    // Same stop-state rule as appendActionHistory below: no run can have happened while the stop state
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
  // Stop-state rule: a refused action is never recorded as done. Both callers stop on the refusal signal
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

  // Fill + prune the id→repo index. Never runs during capture; triggered by the Beta
  // tab, its ↻ Re-scan, or an install for an unmapped id. Returns {resolved, total} for the UI.
  async refreshBratIndex(): Promise<{ resolved: number; total: number }> {
    const repos = await this.bratRepos();
    // A device with no BRAT list at all is a READER of the index, never its writer.
    // resolveBratIndex prunes ids whose
    // repo is gone from THIS device's list, so an empty list resolves to an empty index — and this
    // method would save it, wiping a fleet-shared structure from the device that knows least about
    // it. The Beta tab's map-note reports what it can see either way (bratScanStatus, local-only).
    if (repos.length === 0) return { resolved: 0, total: 0 };
    const current = bratRepoIndex(this.settings.items);
    const next = await resolveBratIndex(current, repos, async (repo) => {
      try {
        const res = await requestUrl({ url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`, throw: true });
        return res.text;
      } catch {
        return null;
      }
    });
    // Stop-state rule: the assignment sits INSIDE the stop check, not before it — `resolveBratIndex` above
    // pruned the index against this device's repo list, and publishing that reading of a document
    // we cannot read is exactly what the stop state forbids. Silent (the Beta tab re-scans on its
    // own when it opens, with no user gesture behind it — a notice there would fire unprompted).
    if (this.schemaStop === null && JSON.stringify(next) !== JSON.stringify(current)) {
      this.settings.items = withBratRepos(this.settings.items, next);
      await this.saveSettings();
    }
    return { resolved: Object.keys(next).length, total: repos.length };
  }

  // A compiled group's item ref — THE way this shell asks the key space a question.
  // A name nothing compiles resolves through the same legacy rules a v1/v2 lock read uses, so a
  // display lookup and a lock read can never disagree about which entry they mean.
  //
  // Memoized against the compiled list's identity: `lockRefFor` BUILDS an index,
  // and this is asked per row per render by isDeviceOptedOut and displayName.
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
    // pre-resolve) through the SAME chain — including its carrier element-name fallback —
    // so a bare `this.displayName(name)` call (e.g.
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

  // The Sync Center host resolver: the parent GROUP name for
  // a companion group, so the view can fold a family into one row/entry — null for a non-companion,
  // a custom group, or `enabled-css-snippets` (none of which groupOwners ever attributes to a
  // def-level companionPath, so the out-of-scope cases fall out of this check for free).
  // groupOwners only knows STATIC def-level presetCompanions; a family also includes "any
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

  //
  // The fleet rule lives on the carrier item (enablementRules.ts); this device's own exception
  // lives in localStorage (deviceElements.ts); decideEnablement (enablementDecision.ts) is the one
  // place the two are combined. Everything downstream — the capture/apply mask, the two force
  // sets, every UI row — projects off that one decision: multiple independent derivations are
  // exactly how "a local choice survives a pull" can come to be true in one of them and false
  // in another.

  // The device-element table, parsed at most once per load (same discipline as deviceOptOutsCache
  // — this is read per element per render).
  private deviceElementsCache: DeviceElements | null = null;

  private deviceElements(): DeviceElements {
    if (this.deviceElementsCache === null) this.deviceElementsCache = parseDeviceElements(this.app.loadLocalStorage(DEVICE_ELEMENTS_KEY));
    return this.deviceElementsCache;
  }

  private saveDeviceElements(next: DeviceElements): void {
    this.deviceElementsCache = next;
    // An empty table clears the key rather than storing "{}" — the same prune discipline the
    // opt-out list and the settings map follow.
    this.app.saveLocalStorage(DEVICE_ELEMENTS_KEY, Object.keys(next).length === 0 ? null : JSON.stringify(next));
  }

  // Every element of a list that has anything to decide: a fleet rule, a local exception, or an
  // auto-derived exclusion the caller adds. One walk, one decision per element.
  private enablementDecisions(list: EnablementList): Map<string, EnablementDecision> {
    const rules = enablementRules(this.settings.items, list);
    const table = this.deviceElements();
    const deviceClass: "desktop" | "mobile" = Platform.isMobile ? "mobile" : "desktop";
    const out = new Map<string, EnablementDecision>();
    for (const id of new Set([...Object.keys(rules), ...deviceElementIds(table, list)])) {
      out.set(id, decideEnablement({ rule: rules[id] ?? EVERYWHERE, exception: deviceElementState(table, list, id), deviceClass }));
    }
    return out;
  }

  // One walk per run for every list, so the mask and the two force sets are three projections of
  // ONE map rather than three derivations that can disagree.
  private decisionsByList(): Map<EnablementList, Map<string, EnablementDecision>> {
    return new Map(ENABLEMENT_LISTS.map((list) => [list, this.enablementDecisions(list)] as const));
  }

  private forcedFrom(decisions: Map<EnablementList, Map<string, EnablementDecision>>, want: "on" | "off"): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [list, map] of decisions) {
      const ids = [...map].filter(([, d]) => d.force === want).map(([id]) => id);
      if (ids.length > 0) out[list] = ids;
    }
    return out;
  }

  // The fleet rule for one element of one list — read and write, the only pair.
  enablementRuleFor(list: RuleListId, elementId: string): Sharing {
    return enablementRuleFor(this.settings.items, list, elementId);
  }

  async setEnablementRule(list: RuleListId, elementId: string, sharing: Sharing): Promise<void> {
    if (this.schemaStopped()) return; // refuse BEFORE mutating
    this.settings.items = withEnablementRule(this.settings.items, list, elementId, sharing);
    await this.saveSettings();
  }

  // This device's own exception for that element: null = follows the rule.
  deviceElementFor(list: RuleListId, elementId: string): DeviceElementState | null {
    return deviceElementState(this.deviceElements(), list, elementId);
  }

  // Every element of a list this device has an exception for — what a carrier card's `N left to me`
  // badge counts and what its element list unions in. The per-element read above cannot
  // answer it: the table is localStorage, which only this file touches.
  deviceElementIds(list: RuleListId): string[] {
    return deviceElementIds(this.deviceElements(), list);
  }

  // "Leave it to me" keeps EXACTLY what is on this device right now. The state is read
  // from the PERSISTED list file — the same content applySwitchList's pass-through reads — never
  // from a live plugin query, which can diverge from disk (a non-persistent enablePlugin, which
  // config-sync's own apply cycle and the IOTO ecosystem both use).
  async leaveToThisDevice(list: RuleListId, elementId: string): Promise<void> {
    if (this.schemaStopped()) return;
    const persisted = await this.localSwitchListFor(list);
    this.writeDeviceElement(list, elementId, switchListMemberOn(persisted, elementId) ? "on" : "off");
    void this.refreshLocalStatus();
  }

  // Put it back under the shared answer.
  async followTheDefault(list: RuleListId, elementId: string): Promise<void> {
    if (this.schemaStopped()) return;
    this.writeDeviceElement(list, elementId, null);
    void this.refreshLocalStatus();
  }

  // Flip an existing exception.
  async setDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState): Promise<void> {
    if (this.schemaStopped()) return;
    this.writeDeviceElement(list, elementId, state);
    void this.refreshLocalStatus();
  }

  // ONE writer for the exception table — the three methods above differ only in the
  // value they hand it.
  private writeDeviceElement(list: RuleListId, elementId: string, state: DeviceElementState | null): void {
    this.saveDeviceElements(withDeviceElement(this.deviceElements(), list, elementId, state));
  }

  // The LOCAL half of `thisDeviceItems`' migration. The fleet half (a `this-device` rule)
  // preserves who decides; this half preserves WHAT was decided. Both are needed because a v3
  // this-device pin did not merely mask its element — it FORCED it (against the persisted
  // list). Writing the rule alone would turn a force into a
  // pass-through, and the first apply after the migration could then move a switch the user had
  // pinned. With the freeze, the three list files are byte-identical before and after.
  //
  // Idempotent, which is what makes the localStorage-before-saveData ordering in loadSettings safe:
  // an element that already has an exception is left alone, and one that does not is recorded with
  // the state it is ALREADY in, so running the whole migration twice writes the same table.
  private async freezeThisDeviceElements(freeze: { list: EnablementList; elementId: string }[]): Promise<void> {
    if (freeze.length === 0) return;
    let table = this.deviceElements();
    for (const { list, elementId } of freeze) {
      if (deviceElementState(table, list, elementId) !== null) continue;
      const persisted = await this.readListFileDirect(list);
      table = withDeviceElement(table, list, elementId, switchListMemberOn(persisted, elementId) ? "on" : "off");
    }
    this.saveDeviceElements(table);
  }

  // The list-file read the migration needs, BEFORE anything is compiled: `localSwitchListFor` goes
  // through `compiledGroups`, which does not exist yet at load time. The filename comes from the
  // same producer the compiler would have used (switchList.ts's enablementListFile), so the two
  // reads can never disagree about which file a list lives in.
  private async readListFileDirect(list: EnablementList): Promise<SwitchList | null> {
    const io = this.configIO();
    const real = `${this.app.vault.configDir}/${enablementListFile(list)}`;
    if (!(await io.exists(real))) return null;
    return readLocalSwitchList(list, await io.read(real));
  }

  // Settings-sync menu read/write: the same field the Settings tab's
  // file-row sharing control edits (Item.settingsFile.fileRule.sharing). `mode` is re-derived
  // on every write exactly as SettingTab's own withDerivedMode does, so a fileRule-only write
  // here never desyncs it from the rules/perElement it's actually driven by.
  private itemFileSharing(ref: ItemRef): FileSharing {
    const parsed = parseItemRef(ref);
    if (parsed === null) return EVERYWHERE;
    return itemAt(this.settings.items, parsed.section, parsed.id)?.settingsFile?.fileRule?.sharing ?? EVERYWHERE;
  }


  // The SAME legality test setItemFileSharing's guard throws on below — the Sync Center row
  // calls this to decide whether to offer the menu at all, so "offered" and "accepted" can never
  // disagree.
  // The stored mode outranks derivation for the one value derivation cannot see: a custom item's
  // `mode: "encrypted"` has no rules for deriveMode to read, and treating it as "plain" is how a
  // sharing write once silently downgraded an encrypted rule to plaintext.
  private effectiveFileMode(sf: ItemSettingsFile): SyncMode {
    return sf.mode === "encrypted" ? "encrypted" : deriveMode(sf);
  }

  private itemFileSharingMenuLegal(ref: ItemRef): boolean {
    const parsed = parseItemRef(ref);
    if (parsed === null) return false;
    const sf = itemAt(this.settings.items, parsed.section, parsed.id)?.settingsFile ?? defaultSettingsFile();
    // "fields" is the only illegal mode: there the per-key rules own the file and a fileRule
    // would be stripped by withDerivedMode. An "encrypted" custom item is fine — its fileRule is
    // the devices carrier (registry.ts's customGroup/customItemFromGroup round-trip), and the
    // envelope stays on.
    return this.effectiveFileMode(sf) !== "fields";
  }

  async setItemFileSharing(ref: ItemRef, sharing: FileSharing): Promise<void> {
    if (this.schemaStopped()) return; // schema stop
    const parsed = parseItemRef(ref);
    if (parsed === null) return;
    const item = itemAt(this.settings.items, parsed.section, parsed.id) ?? emptyItem();
    const sf = item.settingsFile ?? defaultSettingsFile();
    const mode = this.effectiveFileMode(sf);
    // Writing a fileRule on a fields-mode item would resolve mode:"fields"
    // below and silently strip the very fileRule this call just wrote — the item's card never
    // offers this menu there (see itemFileSharingMenuLegal above), so reaching here with an illegal mode
    // means a caller ignored that and must be told loudly, not have its write vanish.
    if (mode === "fields") {
      throw new Error(`setItemFileSharing: "${ref}" is in "${mode}" mode — a whole-file sharing write is illegal there (manifest.ts's fileRule validator only allows plain-mode file groups)`);
    }
    const nextSf: ItemSettingsFile = { ...sf, mode, fileRule: { ...(sf.fileRule ?? { sharing: EVERYWHERE, encrypted: false }), sharing } };
    this.settings.items = withItem(this.settings.items, parsed.section, parsed.id, { ...item, settingsFile: pruneSettingsFile(nextSf) });
    await this.saveSettings();
  }

  // The Stop-syncing menu's "On this device"/"Sync on this device again" read:
  // true iff this group is in THIS device's own opt-out list (localStorage — never data.json).
  private isDeviceOptedOut(groupName: string): boolean {
    return this.deviceOptOutGroups().includes(this.groupRef(groupName));
  }

  // Every item ref THIS device has opted out of — the guard set for the run/heal seams
  // (captureItems/applyItems payload filtering, backfillLockLabels' tail heal, computeStatuses'
  // synthetic-status treatment). Refs since v3: the opt-out list moved with
  // the lock and the baselines, because they are one key space and a half-moved one resolves
  // nothing.
  private deviceOptedOutRefs(): Set<string> {
    return new Set(this.deviceOptOutGroups());
  }

  // The Stop-syncing menu's "On this device"/"Sync on this device again" write. One store, one
  // gesture: localStorage is the AUTHORITY — a local choice no pull or adopt can overwrite —
  // and the only one.
  async setDeviceOptOut(groupName: string, on: boolean): Promise<void> {
    // Stop-state rule: the opt-out list is DERIVED from the document we cannot read (the group
    // name comes from `compiledGroups`) and decides what every future run skips.
    if (this.schemaStopped()) return;
    const ref = this.groupRef(groupName);
    const refs = new Set(this.deviceOptOutGroups());
    if (on) refs.add(ref);
    else refs.delete(ref);
    this.saveDeviceOptOutGroups([...refs]);
    // The comparison lens just moved — an opted-out group stops being compared, an opted-in one
    // starts again — so the panel and the status indicators must re-derive, exactly as
    // saveDeviceField/setDeviceElement/leaveToThisDevice/followTheDefault already do. This was the
    // only writer of that family missing it, which is why opting back in left a stale reading on
    // screen until something else happened to refresh.
    await this.refreshLocalStatus();
  }

  // SettingsHost-facing binding of the same whole-file opt-out read isDeviceOptedOut already backs
  // for the Sync Center host (syncCenterHost's `deviceOptedOut` above) — one implementation, two
  // interface names.
  deviceOptedOut(groupName: string): boolean {
    return this.isDeviceOptedOut(groupName);
  }

  // SettingsHost-facing: this device's own exception for one rule's pattern on one item — the
  // per-key sibling of isDeviceOptedOut/setDeviceOptOut above, one layer down.
  deviceFieldExceptedFor(ref: ItemRef, pattern: string): boolean {
    return deviceFieldExcepted(this.deviceFields(), ref, pattern);
  }

  async setDeviceFieldExcepted(ref: ItemRef, pattern: string, excepted: boolean): Promise<void> {
    this.saveDeviceFields(withDeviceField(this.deviceFields(), ref, pattern, excepted));
    // The comparison lens just moved — the panel and the status indicators must re-derive, same
    // as setDeviceElement/leaveToThisDevice/followTheDefault below.
    void this.refreshLocalStatus();
  }

  // The More bridge's target item — set here, consumed once by SettingTab.display() via
  // consumePendingSettingsAnchor() below, which expands that item's card and scrolls to it.
  private pendingSettingsDeepLink: SettingsDeepLink | null = null;
  private openSettingsAt(ref: ItemRef, spot: SettingsSpot): void {
    this.pendingSettingsDeepLink = { ref, spot };
    const app = this.app as unknown as AppWithSetting;
    // open() itself
    // re-opens whatever tab was last active — when that's already this plugin's tab (the common
    // case once Settings has been opened here even once), open()'s internal openTabById() already
    // fires SettingTab.display(). openTabById() has no "already active" guard (Obsidian's own
    // compiled Setting class), so an unconditional explicit call here would
    // re-run display() a second time, resetting activeTab/expanded back to defaults right after
    // the first display() had consumed pendingSettingsDeepLink and applied them.
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
  consumePendingSettingsAnchor(): SettingsDeepLink | null {
    const link = this.pendingSettingsDeepLink;
    this.pendingSettingsDeepLink = null;
    return link;
  }

  // The item a compiled group belongs to, as the one-string ref localStorage and the Sync Center
  // host both speak — a registry LOOKUP (registry.ts's itemForGroupName), never a parse of the
  // group name. null for a companion group or a name no def claims. An enablement carrier resolves
  // here too, to its own def — it is not a special case; a custom item's group name IS
  // its id.
  itemRefForGroup(name: string): ItemRef | null {
    const def = itemForGroupName(this.registryDefs, name);
    if (def !== null) return defRef(def);
    return itemAt(this.settings.items, "custom", name) !== undefined ? itemRef("custom", name) : null;
  }

  // The runtime mask per switch group = every element decideEnablement masked (a local exception,
  // an each-device-decides rule, or a class rule this device does not match) ∪ auto-derived
  // exclusions (community-plugins only: desktop-only manifest ids on mobile, plus plugin groups
  // with a non-matching devices class). Masked ids pass through at capture, keep local state on
  // apply, and are hidden from in-sync comparison. The persisted settings are left untouched.
  private async augmentedSwitchExceptions(
    rootPath: string,
    decisions: Map<EnablementList, Map<string, EnablementDecision>>
  ): Promise<Record<string, string[]>> {
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
      const ruled = [...(decisions.get(name) ?? new Map<string, EnablementDecision>())].filter(([, d]) => d.masked).map(([id]) => id);
      const auto = name === "community-plugins" ? derived : new Set<string>();
      const mask = [...new Set([...ruled, ...auto])];
      if (mask.length > 0) out[name] = mask;
    }
    return out;
  }

  // A group's PERSISTED local switch-list content — the same file applySwitchList's exception
  // pass-through reads (never a live PluginHost query, which can diverge from what
  // is actually on disk — the divergence pluginState.ts documents). Absent group/file/unparseable → null,
  // treated as "off" by switchListMemberOn.
  private async localSwitchListFor(name: string): Promise<SwitchList | null> {
    const group = findGroupByName(this.compiledGroups, name);
    if (group === undefined) return null;
    const io = this.configIO();
    const real = localRealPath(name, group.path, this.app.vault.configDir);
    if (!(await io.exists(real))) return null;
    return readLocalSwitchList(name, await io.read(real));
  }

  private async coreContext(): Promise<CoreContext> {
    const rootPath = await resolveRootPath(this.settings.rootPath, this.settings.pkmMode, this.pkmProbe());
    if (rootPath === "" || rootPath.startsWith("/") || rootPath.split("/").includes("..")) {
      throw new Error(`Config Sync: invalid data folder "${rootPath}" — set a vault-relative path in settings`);
    }
    this.lastResolvedRoot = rootPath;
    // ONE decision per element per run; the mask and both force sets are projections of it —
    // three independent derivations could disagree.
    const decisions = this.decisionsByList();
    return {
      io: this.configIO(),
      configDir: this.app.vault.configDir,
      rootPath,
      plugins: this.pluginHost(),
      passphrase: this.passphrase(),
      deviceClass: Platform.isMobile ? "mobile" : "desktop",
      switchExceptions: await this.augmentedSwitchExceptions(rootPath, decisions),
      fieldExceptions: fieldExceptionsByGroupName(this.deviceFields(), this.compiledGroups),
      switchForceOff: this.forcedFrom(decisions, "off"),
      switchForceOn: this.forcedFrom(decisions, "on"),
      // No fieldOverlay: compileItems (registry.ts) already merges every app-slice card's rules
      // into the compiled "app" group at settings-compile time.
      groupsIO: {
        read: async () => this.compiledGroups,
        // The sync list is DERIVED from settings.items, not stored directly, so a raw group-list
        // write has no durable home. The only remaining caller is stopSyncing's fallback for a
        // group with no known owner — every registry-produced group has one (the two carriers
        // have their own def), so this is reachable only for a name no def or custom entry
        // claims at all (a future/unrecognized group) — kept in memory for the rest of the
        // session, never a source of data loss, just non-persistence across a reload.
        write: async (groups) => {
          this.compiledGroups = groups;
        },
      },
      // v3 self copies carry `items` (custom items included), not a compiled groups array — core
      // needs the plugin's registry defs to compile them (storeSelfCopyGroups' contract).
      storeListGroups: (json) => storeSelfCopyGroups(json, this.registryDefs, new Set(Object.keys(bratRepoIndex(this.settings.items)))),
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

  // Dynamic import() keeps Node fs/child_process out of the mobile load path:
  // a static import would execute require("fs") at plugin load and crash on mobile.
  private async buildReader(remote: Remote): Promise<ExternalStoreReader> {
    if (remote.type === "vault") {
      const { createLocalPathReader } = await import("./external/localPath");
      return createLocalPathReader(remote.storePath);
    }
    const { createGitReader } = await import("./external/gitSource");
    return createGitReader(remote.url, remote.branch, remote.subdir ?? "", resolveGitToken(this.app.secretStorage, remote));
  }

  // Dynamic import() keeps Node fs/child_process out of the mobile load path:
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

  private groupStoreAbs(ctx: CoreContext, group: SyncGroup): string {
    return `${ctx.rootPath}/store/${groupStorePath(group.path)}`;
  }

  // Returns the store paths it deleted (display form, no "store/" prefix) so the caller can
  // record them in run history; empty when deleteStore is false or there was no store data.
  // Returns the store paths it deleted, or `null` when the run was refused (stop state) — the same
  // "it did not happen" signal the runs already use (see the Sync Center's setLastRun), and the
  // reason it is not an empty array: `[]` is a legitimate outcome (nothing to delete) that the
  // caller records in the run history, so a refusal must be a different value or it gets logged
  // as a success.
  async stopSyncing(groupName: string, deleteStore: boolean): Promise<string[] | null> {
    // Schema stop, same rule as the five runs above: this deletes store content BEFORE it touches
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
    // Durable: flip the owning item(s)' synced flag (or, for a companion group, just that one
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
            : { ...item, synced: false }
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

  // The name sources leftoverStoreRels resolves real owners through (DESIGN.md's Leftover section):
  // plugin labels from the local store lock (its entries survive for exactly these files), else
  // the locally installed manifest; config-root file owners from the registry defs, which always
  // know every core plugin and Obsidian card.
  private async leftoverNames(ctx: { io: FileIO; rootPath: string }, rels: string[]): Promise<LeftoverNames> {
    let lock: StoreLock | null = null;
    const lockPath = `${ctx.rootPath}/store.lock.json`;
    try {
      // compiledGroups lets a v1/v2 lock's name-keyed entries convert to refs where resolvable.
      if (await ctx.io.exists(lockPath)) lock = parseStoreLock(await ctx.io.read(lockPath), this.compiledGroups);
    } catch {
      lock = null; // an unreadable lock only costs display names, never the listing
    }
    const registry = this.pluginRegistry();
    const pluginLabels = new Map<string, string>();
    for (const rel of rels) {
      const m = rel.match(/^store\/configdir\/plugins\/([^/]+)\//);
      const id = m?.[1];
      if (id === undefined || pluginLabels.has(id)) continue;
      const label = lockLabel(lockEntry(lock, itemRef("community", id))) ?? registry.manifests[id]?.name;
      if (label !== undefined) pluginLabels.set(id, label);
    }
    const fileOwners = new Map<string, { section: "obsidian" | "core"; label: string }>();
    let appearanceLabel = "Appearance";
    for (const def of this.registryDefs) {
      if (def.section !== "obsidian" && def.section !== "core") continue;
      if (def.section === "obsidian" && def.id === "appearance") appearanceLabel = def.label;
      const path = def.settingsFile?.defaultPath;
      if (path === undefined || path === null) continue;
      const basename = path.slice(path.lastIndexOf("/") + 1);
      fileOwners.set(basename, { section: def.section === "core" ? "core" : "obsidian", label: def.label });
    }
    return { pluginLabels, fileOwners, appearanceLabel };
  }

  async listLeftoverStoreFiles(): Promise<{ rel: string; section: LeftoverSection; name: string; crumb: string | null; path: string; size: number }[]> {
    const ctx = await this.coreContext();
    if (!(await ctx.io.exists(ctx.rootPath))) return [];
    const files = (await listFilesRecursive(ctx.io, ctx.rootPath)).filter((f) => !isJunkPath(f));
    const rels = files.map((f) => f.slice(ctx.rootPath.length + 1));
    // Files the store's own sync list defines but this device hasn't adopted yet are pending, not
    // leftover — union the local list with the store self-copy's list so a pull can't leave
    // just-arrived data looking like deletable junk.
    const selfCopy = `${ctx.rootPath}/store/configdir/plugins/config-sync/data.json`;
    const storeGroups = (await ctx.io.exists(selfCopy))
      ? storeSelfCopyGroups(await ctx.io.read(selfCopy), this.registryDefs, new Set(Object.keys(bratRepoIndex(this.settings.items))))
      : [];
    const names = await this.leftoverNames(ctx, rels);
    const out: { rel: string; section: LeftoverSection; name: string; crumb: string | null; path: string; size: number }[] = [];
    for (const lf of leftoverStoreRels(rels, [...this.compiledGroups, ...storeGroups], names)) {
      const st = await this.app.vault.adapter.stat(`${ctx.rootPath}/${lf.rel}`);
      out.push({ ...lf, size: st?.size ?? 0 });
    }
    return out;
  }

  // Returns the store rels it deleted, or `null` when refused — same signal and same reasoning as
  // stopSyncing above.
  async deleteLeftoverStoreFiles(rels: string[]): Promise<string[] | null> {
    // Schema stop: "leftover" means "no compiled group claims this file", and under the stop state the
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
    return listPluginSections(this.pluginRuntime(), groups, new Set(Object.keys(bratRepoIndex(this.settings.items))));
  }

  async listBetaSections(groups: SyncGroup[]): Promise<CatalogSection[]> {
    return listBetaSections(this.pluginRuntime(), groups, bratRepoIndex(this.settings.items));
  }

  // Local-only status for the Beta tab's map-note (no network): index size vs BRAT's list.
  async bratScanStatus(): Promise<{ resolved: number; total: number }> {
    const repos = await this.bratRepos();
    const resolved = Object.values(bratRepoIndex(this.settings.items)).filter((r) => repos.includes(r)).length;
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
  // Appearance card's snippets companion member rows; reuses the same directory
  // scan snippetUniverse() already does for the old switch-list drawer.
  async listSnippetFiles(): Promise<string[]> {
    return (await this.snippetUniverse()).fromDir;
  }

  // Immediate child file/folder names of a companion path — plain (non-mapKey) companion member
  // listing. No per-member sharing: an arbitrary folder group
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

  // The load-time version gate (classifySettings).
  // `migrate` — a v2 document is brought forward field by field
  // and saved once, silently: nothing was reset, so nothing is announced. `legacy` — a v1 or
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
      // Said once, here, and not only to whoever opens the Sync Center: a device that has
      // silently stopped syncing is the failure the version gate exists to prevent, so it must be
      // visible without the user going looking. Same mechanism and duration as the legacy branch's
      // own notice below — and it seeds the same quiet window every other refusal shares,
      // or a gesture within REFUSAL_NOTICE_MS would stack a second copy of this
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
    // Quick commands live in the Ribbon Organizer plugin, so the stale key is dropped here and the
    // next save cleans data.json. `deviceId` is likewise swept: the device identity lives only in
    // localStorage (see the deviceId() method below) — data.json travels wholesale (git-tracked
    // vaults, remotely-save, manual copies), and a value trusted from an inherited data.json would
    // let a bootstrapped machine silently claim the source machine's identity — so a stray
    // settings-field copy is ignore-and-prune, not migrate: nothing meaningful to carry forward,
    // only an artifact to sweep off the next save.
    //
    // Ahead of the migrate branch, not after it: a v2 document is the one
    // most likely to still carry both, and the migration SAVES — so leaving the sweep downstream
    // would deliberately write a stray `deviceId` back to disk for one cycle. It is skipped for a
    // `future` document (which returned above) because this build owns nothing there.
    if (data !== null) {
      delete data.quickCommands;
      delete data.deviceId;
    }
    if (load.kind === "migrate") {
      // `data ?? {}` only to satisfy the compiler: classifySettings answers "fresh" for a null
      // document, so "migrate" always comes with one. Both migrations are total either way — each
      // returns a document of any other version untouched — so this can never take a different
      // branch by accident the way a `data !== null` guard falling through to `legacy` would.
      //
      // The CHAIN is the point: migrateV2Settings answers with a v3 document, migrateV4Settings a v4
      // one, and migrateV5Settings takes the rest of the way, so a device that skipped 2.22.0
      // entirely still lands on v5 in this one load. A document that is already v3 or v4 simply
      // starts further along, and carries no v2 opt-out map to absorb.
      const v3 = load.from === 2 ? migrateV2Settings(data ?? {}) : { document: data ?? {}, carriedDeviceOptOuts: undefined };
      const v4 = migrateV4Settings(v3.document);
      this.settings = withDefaults(DEFAULT_SETTINGS, migrateV5Settings(v4.document));
      // localStorage FIRST, the document second. The two stores are written back to back and a
      // crash between them has to leave a state the next load recovers from: with this order that
      // state is "still a v2/v3/v4 document, opt-outs already absorbed and exceptions already frozen",
      // which migrates again cleanly — the absorb is a union, and the freeze writes the element's
      // CURRENT state, which the run that wrote it did not change, so both are idempotent. The
      // other order would leave a v5 document whose opt-out map and whose this-device pins are gone
      // and never reached localStorage — an unrecoverable loss of the user's own choices.
      this.absorbCarriedDeviceOptOuts(v3.carriedDeviceOptOuts);
      await this.freezeThisDeviceElements(v4.freeze);
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
    // A field this build doesn't recognise is deliberately NOT sanitized here:
    // dropping every such value and saving immediately would turn a NEWER build's data into a
    // deletion this device then pushes to the whole fleet. This is what a v3 document's leftover
    // `runsOn` rides through as —
    // unknown data in an item's carried tail (registry.ts's itemTail/WRITTEN_ITEM_KEYS), ignored
    // where it is consumed and never rewritten out from under a newer build that might still read
    // it.
  }

  // The answer every mutating entry point gives while the stop state holds: true means the
  // caller must stop, having written nothing, and the user has been told why in the same words the
  // Sync Center's banner uses. Refusal, not silent recovery — a toggle that quietly did nothing
  // would be indistinguishable from a save that worked.
  //
  // The REFUSAL is never suppressed; only a repeat of the same notice while the previous one is
  // still on screen is (REFUSAL_NOTICE_MS is both its lifetime and the quiet
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

  // SettingsHost-facing: may the settings tab write right now? Asking IS the refusal —
  // the notice fires here, on the user's own gesture — because every writer in that file is
  // mutate-then-save and `saveSettings` refuses too late to undo the mutation. A writer that only
  // learned at save time left memory diverged from disk with no recompile.
  settingsWritable(): boolean {
    return !this.schemaStopped();
  }

  async saveSettings(): Promise<void> {
    // The choke point for every settings writer, the settings tab's own included: a
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
   * The re-key of this device's own two stores — the baselines and the opt-out list — from
   * compiled group names to item refs. Runs after every compile, not only after the v2 → v3 document
   * migration, and both halves are idempotent (the ledger by its own version, the opt-out list by
   * the shape of its entries), so a crash between the two writes finishes on the next load rather
   * than leaving one store in each vocabulary.
   *
   * AFTER a SUCCESSFUL compile, deliberately: the conversion asks the compiler what each name's ref
   * is (itemKeys.ts's lockRefFor), so it can only run once compiledGroups is both present and
   * trustworthy — see recompile's return value, and its callers, which is where that precondition is
   * enforced. Nothing is dropped (see rekeyLedger) and nothing is written while the stop state
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
