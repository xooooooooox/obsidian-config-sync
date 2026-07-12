import { ButtonComponent, ExtraButtonComponent, ItemView, WorkspaceLeaf } from "obsidian";
import { bucketCounts, GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry } from "../core/status";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";
import { FileChanges, Remote, SyncGroup, hasChanges } from "../core/types";
import {
  capFileEntries,
  CappedEntry,
  insyncLineText,
  matchesSearch,
  moreFilesText,
  nosettingsLineText,
  PanelFilter,
  visibleUnderFilter,
  Direction,
  effectiveDirection,
} from "./panelModel";

const CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

// Session-remembered UI state: which scopes have their ✓ / ○ trailing lines flattened open.
const sessionUi = {
  insyncOpen: new Set<string>(),
  nosettingsOpen: new Set<string>(),
};

export interface SyncCenterHost {
  computeStatuses(): Promise<{ groups: SyncGroup[]; statuses: GroupStatus[] }>;
  resolvedPath(group: SyncGroup): string;
  captureItems(names: string[]): Promise<void>; // runs selective capture + shows its report
  applyItems(names: string[]): Promise<void>; // warnings-confirm + apply + report
  remotes(): Remote[]; // [] on mobile
  remoteCheck(name: string): { check: RemoteCheck; at: number } | undefined;
  refreshRemoteChecks(): Promise<void>;
  deepDiff(remote: Remote): Promise<RemoteDiffEntry[]>;
  pullFrom(remote: Remote): Promise<void>;
  pushTo(remote: Remote): Promise<void>;
}

function relativeAge(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function isoAge(iso: string | null): string {
  if (iso === null) return "never";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "unknown" : relativeAge(ms);
}

interface StatusRow {
  group: SyncGroup;
  status: GroupStatus;
}

export const SYNC_CENTER_VIEW_TYPE = "config-sync-center";

export class SyncCenterView extends ItemView {
  private groups: SyncGroup[] = [];
  private statuses: Map<string, GroupStatus> = new Map();
  private selected: Set<string> = new Set();
  private directionOverride: Map<string, Direction> = new Map();
  private expandedItems: Set<string> = new Set();
  private renderGen = 0;
  private filter: PanelFilter = "all";
  private panelScope: { kind: "device"; cat: ItemCategory | "all" } | { kind: "remote"; name: string } = { kind: "device", cat: "all" };
  private search = "";
  private firstLoad = true;
  private lastRefreshedAt: number | null = null;
  private compact = false;
  private switcherOpen = false;

  constructor(leaf: WorkspaceLeaf, private host: SyncCenterHost) {
    super(leaf);
  }

  getViewType(): string {
    return SYNC_CENTER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Sync Center";
  }

  getIcon(): string {
    return "arrow-left-right";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("config-sync-center");
    const ro = new ResizeObserver(() => {
      this.evaluateCompact();
    });
    ro.observe(this.contentEl);
    this.register(() => ro.disconnect());
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf === this.leaf) void this.reload();
      })
    );
    this.registerDomEvent(document, "click", (ev) => {
      if (!this.switcherOpen) return;
      const t = ev.target as Node;
      const sw = this.contentEl.querySelector(".config-sync-switcher");
      const menu = this.contentEl.querySelector(".config-sync-switcher-menu");
      if (sw?.contains(t) === true || menu?.contains(t) === true) return;
      this.switcherOpen = false;
      this.render(this.renderGen);
    });
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  onResize(): void {
    this.evaluateCompact();
  }

  private evaluateCompact(): void {
    const width = this.contentEl.clientWidth;
    if (width === 0) return; // hidden leaf
    const compact = width < 700;
    if (compact !== this.compact) {
      this.compact = compact;
      this.render(this.renderGen);
    }
  }

  // Called by the plugin when awareness state changes while the view is open.
  notifyExternalChange(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    const gen = ++this.renderGen;
    const { groups, statuses } = await this.host.computeStatuses();
    if (gen !== this.renderGen) return;
    this.groups = groups;
    this.statuses = new Map(statuses.map((s) => [s.group, s]));
    // User state survives reloads; prune entries whose item vanished.
    const names = new Set(groups.map((g) => g.name));
    for (const n of [...this.selected]) if (!names.has(n)) this.selected.delete(n);
    for (const n of [...this.directionOverride.keys()]) if (!names.has(n)) this.directionOverride.delete(n);
    for (const n of [...this.expandedItems]) if (!names.has(n)) this.expandedItems.delete(n);
    // Default pre-check seeds once per view lifetime, never on later refreshes.
    if (this.firstLoad) {
      this.firstLoad = false;
      for (const s of statuses) {
        if (s.state === "local-changed" || s.state === "store-newer") this.selected.add(s.group);
      }
    }
    this.lastRefreshedAt = Date.now();
    this.render(gen);
  }

  private rows(): StatusRow[] {
    const out: StatusRow[] = [];
    for (const group of this.groups) {
      const status = this.statuses.get(group.name);
      if (status !== undefined) out.push({ group, status });
    }
    return out;
  }

  private effDir(r: StatusRow): Direction {
    return effectiveDirection(r.status.state, this.directionOverride.get(r.group.name));
  }

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    this.contentEl.empty();
    this.renderHeader();
    const shell = this.contentEl.createDiv({ cls: `config-sync-shell${this.compact ? " is-compact" : ""}` });
    if (this.compact) this.renderSwitcher(shell);
    else this.renderSidebar(shell);
    const main = shell.createDiv({ cls: "config-sync-main" });
    if (this.panelScope.kind === "remote") {
      const remote = this.host.remotes().find((x) => this.panelScope.kind === "remote" && x.name === this.panelScope.name);
      if (remote !== undefined) {
        this.renderRemoteMode(main, remote);
        return;
      }
      this.panelScope = { kind: "device", cat: "all" }; // remote vanished (settings change) — fall back
    }
    this.renderItemMode(main);
  }

  private renderSidebar(shell: HTMLElement): void {
    const side = shell.createDiv({ cls: "config-sync-side" });
    this.renderScopeEntries(side);
  }

  private renderScopeEntries(container: HTMLElement): void {
    container.createDiv({ cls: "config-sync-side-head", text: "This device ↔ store" });

    const deviceEntry = (cat: ItemCategory | "all", label: string, statuses: GroupStatus[]): void => {
      const active = this.panelScope.kind === "device" && this.panelScope.cat === cat;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: label });
      const c = bucketCounts(statuses);
      if (c.up > 0) item.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) item.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
      if (c.ok > 0) item.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) item.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
      item.addEventListener("click", () => {
        this.panelScope = { kind: "device", cat };
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    };

    deviceEntry("all", "All items", this.rows().map((r) => r.status));
    for (const cat of CATEGORY_ORDER) {
      const inCat = this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
      if (inCat.length === 0) continue;
      deviceEntry(cat, CATEGORY_LABELS[cat], inCat.map((r) => r.status));
    }

    const remotes = this.host.remotes();
    if (remotes.length === 0) return;
    let newestCheck: number | null = null;
    for (const remote of remotes) {
      const c = this.host.remoteCheck(remote.name);
      if (c !== undefined && (newestCheck === null || c.at > newestCheck)) newestCheck = c.at;
    }
    const head = container.createDiv({ cls: "config-sync-side-head config-sync-side-head-remotes" });
    head.createSpan({ text: `Remotes · checked ${newestCheck === null ? "never" : relativeAge(newestCheck)}` });
    const refresh = new ExtraButtonComponent(head);
    refresh.setIcon("refresh-cw");
    refresh.setTooltip("Re-check remotes");
    refresh.onClick(async () => {
      await this.host.refreshRemoteChecks();
      this.render(this.renderGen);
    });
    for (const remote of remotes) {
      const active = this.panelScope.kind === "remote" && this.panelScope.name === remote.name;
      const item = container.createDiv({ cls: `config-sync-side-item${active ? " is-active" : ""}` });
      item.createSpan({ cls: "config-sync-side-name", text: remote.name });
      const icon = this.remoteIcon(this.host.remoteCheck(remote.name)?.check);
      item.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
      item.addEventListener("click", () => {
        this.panelScope = { kind: "remote", name: remote.name };
        this.switcherOpen = false;
        this.render(this.renderGen);
      });
    }
  }

  // Compact replacement for the sidebar: current scope as a button; dropdown mirrors the sidebar.
  private renderSwitcher(shell: HTMLElement): void {
    const sw = shell.createDiv({ cls: "config-sync-switcher" });
    if (this.panelScope.kind === "device") {
      const cat = this.panelScope.cat;
      sw.createSpan({ text: cat === "all" ? "All items" : CATEGORY_LABELS[cat] });
      const c = bucketCounts(this.scopedRows().map((r) => r.status));
      if (c.up > 0) sw.createSpan({ cls: "config-sync-side-badge is-up", text: `↑${c.up}` });
      if (c.down > 0) sw.createSpan({ cls: "config-sync-side-badge is-down", text: `↓${c.down}` });
      if (c.ok > 0) sw.createSpan({ cls: "config-sync-side-badge is-ok", text: `✓${c.ok}` });
      if (c.none > 0) sw.createSpan({ cls: "config-sync-side-badge is-none", text: `○${c.none}` });
    } else {
      sw.createSpan({ text: this.panelScope.name });
      const icon = this.remoteIcon(this.host.remoteCheck(this.panelScope.name)?.check);
      sw.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph });
    }
    sw.createSpan({ cls: "config-sync-switcher-chev", text: this.switcherOpen ? "▴" : "▾" });
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      this.switcherOpen = !this.switcherOpen;
      this.render(this.renderGen);
    });
    if (this.switcherOpen) {
      const menu = shell.createDiv({ cls: "config-sync-switcher-menu" });
      this.renderScopeEntries(menu);
    }
  }

  private renderHeader(): void {
    const head = this.contentEl.createDiv({ cls: "config-sync-center-head" });
    head.createSpan({ cls: "config-sync-center-title", text: "Sync Center" });
    const { up, down, ok, none } = bucketCounts(this.rows().map((r) => r.status));
    const pills = head.createSpan({ cls: "config-sync-report-pills" });
    if (up > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-up",
        text: `↑ ${up}`,
        attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} to capture` },
      });
    }
    if (down > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-down",
        text: `↓ ${down}`,
        attr: { "aria-label": `${down} item${down === 1 ? "" : "s"} to apply` },
      });
    }
    pills.createSpan({
      cls: "config-sync-pill is-ok",
      text: `✓ ${ok}`,
      attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` },
    });
    if (none > 0) {
      pills.createSpan({
        cls: "config-sync-pill is-none",
        text: `○ ${none}`,
        attr: { "aria-label": `${none} item${none === 1 ? "" : "s"} with no settings yet` },
      });
    }
    head.createSpan({
      cls: "config-sync-center-refreshed",
      text: this.lastRefreshedAt === null ? "" : `refreshed ${relativeAge(this.lastRefreshedAt)}`,
    });
  }

  private scopeKey(): string {
    return this.panelScope.kind === "device" ? this.panelScope.cat : `remote:${this.panelScope.name}`;
  }

  private scopedRows(): StatusRow[] {
    if (this.panelScope.kind !== "device" || this.panelScope.cat === "all") return this.rows();
    const cat = this.panelScope.cat;
    return this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
  }

  private renderItemMode(main: HTMLElement): void {
    const scoped = this.scopedRows();
    const counts = bucketCounts(scoped.map((r) => r.status));

    const bar = main.createDiv({ cls: "config-sync-mainbar" });
    const defs: { key: PanelFilter; label: string }[] = [
      { key: "all", label: `All ${scoped.length}` },
      { key: "capture", label: `To capture ${counts.up}` },
      { key: "apply", label: `To apply ${counts.down}` },
      { key: "ok", label: `In sync ${counts.ok}` },
      { key: "none", label: `No settings yet ${counts.none}` },
    ];
    for (const d of defs) {
      const pill = bar.createEl("button", { cls: `config-sync-fpill${this.filter === d.key ? " is-active" : ""}`, text: d.label });
      pill.addEventListener("click", () => {
        this.filter = d.key;
        this.render(this.renderGen);
      });
    }
    const searchEl = bar.createEl("input", {
      type: "search",
      cls: "config-sync-mainbar-search",
      attr: { placeholder: "Filter by name…" },
    });
    searchEl.value = this.search;
    searchEl.addEventListener("input", () => {
      this.search = searchEl.value;
      this.renderListInto(listHost, scoped); // re-render only the list; keeps the input focused
      this.refreshGlobalSelectAll(selectAll, scoped); // resync tri-state against the new search
    });
    const selectAll = bar.createEl("input", { type: "checkbox", attr: { "aria-label": "Select all visible items" } });

    const listHost = main.createDiv();
    this.renderListInto(listHost, scoped);
    this.wireGlobalSelectAll(selectAll, scoped);

    this.renderActionBar(main);
  }

  private visibleRows(scoped: StatusRow[]): StatusRow[] {
    return scoped.filter((r) => visibleUnderFilter(r.status.state, this.filter) && matchesSearch(r.group.name, this.search));
  }

  private renderListInto(listHost: HTMLElement, scoped: StatusRow[]): void {
    listHost.empty();
    const card = listHost.createDiv({ cls: "config-sync-card" });
    const visible = this.visibleRows(scoped);
    const searching = this.search.trim() !== "";
    if (this.filter === "all" && !searching) {
      const active = visible.filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings");
      const insync = visible.filter((r) => r.status.state === "in-sync");
      const nosettings = visible.filter((r) => r.status.state === "no-settings");
      for (const r of active) this.renderItemRow(card, r);
      this.renderTrailingLine(card, insync, sessionUi.insyncOpen, (n, open) => insyncLineText(n, open));
      this.renderTrailingLine(card, nosettings, sessionUi.nosettingsOpen, (n, open) => nosettingsLineText(n, open));
    } else {
      for (const r of visible) this.renderItemRow(card, r);
    }
  }

  // ✓ / ○ rows fold into one dim line per scope; searching bypasses the fold entirely.
  private renderTrailingLine(card: HTMLElement, rows: StatusRow[], openSet: Set<string>, text: (n: number, open: boolean) => string): void {
    if (rows.length === 0) return;
    const key = this.scopeKey();
    const open = openSet.has(key);
    const line = card.createDiv({ cls: "config-sync-unchanged", text: text(rows.length, open) });
    line.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open) openSet.delete(key);
      else openSet.add(key);
      this.render(this.renderGen);
    });
    if (open) for (const r of rows) this.renderItemRow(card, r);
  }

  // Tri-state select-all over the currently visible checkable rows (scope + filter + search).
  private checkableRows(scoped: StatusRow[]): string[] {
    return this.visibleRows(scoped)
      .filter((r) => r.status.state !== "in-sync" && r.status.state !== "no-settings" && r.status.state !== "locked")
      .map((r) => r.group.name);
  }

  private refreshGlobalSelectAll(box: HTMLInputElement, scoped: StatusRow[]): void {
    const checkable = this.checkableRows(scoped);
    const selectedCount = checkable.filter((n) => this.selected.has(n)).length;
    box.indeterminate = false;
    if (checkable.length === 0) {
      box.disabled = true;
      box.checked = false;
    } else if (selectedCount === checkable.length) {
      box.disabled = false;
      box.checked = true;
    } else if (selectedCount === 0) {
      box.disabled = false;
      box.checked = false;
    } else {
      box.disabled = false;
      box.indeterminate = true;
    }
  }

  private wireGlobalSelectAll(box: HTMLInputElement, scoped: StatusRow[]): void {
    this.refreshGlobalSelectAll(box, scoped);
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const checkable = this.checkableRows(scoped); // read live so it reflects the current search
      const turnOn = checkable.some((n) => !this.selected.has(n));
      for (const name of checkable) {
        if (turnOn) this.selected.add(name);
        else this.selected.delete(name);
      }
      this.render(this.renderGen);
    });
  }

  private renderItemRow(card: HTMLElement, r: StatusRow): void {
    const { group, status } = r;
    const inert = status.state === "in-sync" || status.state === "no-settings" || status.state === "locked";
    const row = card.createDiv({
      cls: `config-sync-hub-row${inert ? " is-insync" : ""}${status.state === "no-settings" ? " is-nosettings" : ""}`,
      attr: { "aria-label": this.host.resolvedPath(group) },
    });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: this.expandedItems.has(group.name) ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: group.name });
    if (group.mode === "encrypted") row.createSpan({ cls: "config-sync-mode-badge", text: "🔒" });
    else if (group.mode === "fields") row.createSpan({ cls: "config-sync-mode-badge", text: "▤" });
    row.createDiv({ cls: "config-sync-rule-spacer" });

    const icon = this.stateIcon(status.state);
    row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });

    const dir = this.effDir(r);
    const cb = row.createEl("input", { type: "checkbox" });
    cb.addClass(dir === "capture" ? "is-capture" : "is-apply");
    cb.disabled = inert;
    cb.checked = this.selected.has(group.name);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cb.checked) this.selected.add(group.name);
      else this.selected.delete(group.name);
      this.render(this.renderGen);
    });

    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !this.expandedItems.has(group.name);
    this.renderItemDetail(detail, r);
    row.addEventListener("click", () => {
      if (this.expandedItems.has(group.name)) this.expandedItems.delete(group.name);
      else this.expandedItems.add(group.name);
      detail.hidden = !detail.hidden;
      chev.setText(detail.hidden ? "▸" : "▾");
    });
  }

  private stateIcon(state: GroupState): { glyph: string; cls: string; tip: string } {
    switch (state) {
      case "local-changed":
        return { glyph: "↑", cls: "is-up", tip: "changed on this device (likely)" };
      case "store-newer":
        return { glyph: "↓", cls: "is-down", tip: "store is newer (likely)" };
      case "differs":
        return { glyph: "≠", cls: "is-neq", tip: "differs from store — direction unknown" };
      case "not-captured":
        return { glyph: "—", cls: "is-miss", tip: "not yet captured" };
      case "no-settings":
        return { glyph: "○", cls: "is-none", tip: "no settings yet — nothing on this device or in the store" };
      case "locked":
        return { glyph: "🔒", cls: "is-locked", tip: "encrypted — set the passphrase in settings to compare" };
      case "in-sync":
      default:
        return { glyph: "✓", cls: "is-ok", tip: "in sync" };
    }
  }

  // Expanded rows always show content: an error, a state note, or actions + the file diff.
  private renderItemDetail(detail: HTMLElement, r: StatusRow): void {
    const { status } = r;
    if (status.message !== undefined) {
      detail.createDiv({ cls: "config-sync-status-error", text: status.message });
      return;
    }
    if (status.state === "in-sync") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "identical to the store" });
      return;
    }
    if (status.state === "no-settings") {
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: "no settings yet on this device or in the store — appears under “To capture” once this item has settings",
      });
      return;
    }
    if (status.state === "not-captured") {
      detail.createDiv({ cls: "config-sync-expand-note", text: "not captured yet — nothing in the store" });
      return;
    }
    if (status.state === "locked") {
      detail.createDiv({
        cls: "config-sync-expand-note",
        text: "encrypted — set the passphrase in Settings → General to compare or apply",
      });
      return;
    }
    if (status.changes === undefined) return;
    this.renderDirectionToggle(detail, r);
    this.renderCappedChanges(detail, status.changes);
  }

  // Staging, not execution: a segment checks the row in that direction; clicking the
  // active segment unstages it. The footer buttons are the only execution points.
  private renderDirectionToggle(detail: HTMLElement, r: StatusRow): void {
    const name = r.group.name;
    const staged = this.selected.has(name);
    const dir = this.effDir(r);
    const seg = detail.createDiv({ cls: "config-sync-seg" });
    const segBtn = (d: Direction, label: string, aria: string): void => {
      const on = staged && dir === d;
      const b = seg.createEl("button", {
        cls: `config-sync-seg-btn is-${d}${on ? " is-on" : ""}`,
        text: label,
        attr: { "aria-label": aria },
      });
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (on) {
          this.selected.delete(name);
          this.directionOverride.delete(name);
        } else {
          this.selected.add(name);
          this.directionOverride.set(name, d);
        }
        this.render(this.renderGen);
      });
    };
    segBtn("capture", "↑ Capture", "Capture this (keep local)");
    segBtn("apply", "↓ Apply store", "Apply store version (overwrites local)");
  }

  private renderCappedChanges(detail: HTMLElement, changes: FileChanges): void {
    const { shown, rest } = capFileEntries(changes, 10);
    const renderEntry = (e: CappedEntry): void => {
      const glyph = e.kind === "add" ? "+" : e.kind === "upd" ? "~" : "−";
      detail.createDiv({ cls: `is-${e.kind}`, text: `${glyph} ${e.name}` });
    };
    for (const e of shown) renderEntry(e);
    if (rest.length > 0) {
      const more = detail.createDiv({ cls: "config-sync-more-files", text: moreFilesText(rest.length) });
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        more.remove();
        for (const entry of rest) renderEntry(entry);
      });
    }
  }

  private captureNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.effDir(r) === "capture")
      .map((r) => r.group.name);
  }

  private applyNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && this.effDir(r) === "apply")
      .map((r) => r.group.name);
  }

  private renderActionBar(macro: HTMLElement): void {
    const bar = macro.createDiv({ cls: "config-sync-actionbar" });
    bar.createSpan({ cls: "config-sync-staged-count", text: `${this.selected.size} staged` });
    bar.createDiv({ cls: "config-sync-rule-spacer" });
    const capNames = this.captureNames();
    const applyNames = this.applyNames();

    const cap = new ButtonComponent(bar);
    cap.setButtonText(`↑ Capture ${capNames.length} item${capNames.length === 1 ? "" : "s"}`);
    cap.buttonEl.addClass("config-sync-btn-capture");
    cap.setDisabled(capNames.length === 0);
    cap.onClick(async () => {
      await this.host.captureItems(this.captureNames());
      await this.reload();
    });

    const apply = new ButtonComponent(bar);
    apply.setCta();
    apply.setButtonText(`↓ Apply ${applyNames.length} item${applyNames.length === 1 ? "" : "s"}`);
    apply.setDisabled(applyNames.length === 0);
    apply.onClick(async () => {
      await this.host.applyItems(this.applyNames());
      await this.reload();
    });
  }

  private renderRemoteMode(main: HTMLElement, remote: Remote): void {
    const check = this.host.remoteCheck(remote.name)?.check;
    const icon = this.remoteIcon(check);
    main.createDiv({
      cls: "config-sync-remote-head",
      text: `${remote.name} · captured ${isoAge(check?.remoteCapturedAt ?? null)} — ${icon.tip}`,
    });
    const detail = main.createDiv({ cls: "config-sync-report-files config-sync-remote-pane" });
    void this.renderRemoteDetail(detail, remote, check);
  }

  private remoteIcon(check: RemoteCheck | undefined): { glyph: string; cls: string; tip: string } {
    const state = check?.state ?? "unknown";
    switch (state) {
      case "remote-newer":
        return { glyph: "↓", cls: "is-pull", tip: "remote captured later — Pull would update your store" };
      case "remote-older":
        return { glyph: "↑", cls: "is-push", tip: "remote is older — Push would update the remote" };
      case "same":
        return { glyph: "✓", cls: "is-ok", tip: "remote matches your store" };
      case "no-store":
        return { glyph: "—", cls: "is-miss", tip: "no store at this remote yet" };
      case "unknown":
      default:
        return { glyph: "?", cls: "is-neq", tip: "remote state unknown" };
    }
  }

  private async renderRemoteDetail(detail: HTMLElement, remote: Remote, check: RemoteCheck | undefined): Promise<void> {
    detail.empty();
    detail.createDiv({ cls: "config-sync-remote-comparing", text: "comparing…" });
    const gen = this.renderGen;
    let entries: RemoteDiffEntry[];
    try {
      entries = await this.host.deepDiff(remote);
    } catch (e) {
      if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
      detail.empty();
      detail.createDiv({ cls: "config-sync-status-error", text: `cannot compare: ${(e as Error).message}` });
      return;
    }
    if (gen !== this.renderGen || this.panelScope.kind !== "remote" || this.panelScope.name !== remote.name) return;
    detail.empty();

    const changed = entries.filter((e) => hasChanges(e.changes));
    for (const cat of CATEGORY_ORDER) {
      const inCat = changed.filter((e) => categoryForGroup(e.group) === cat);
      if (inCat.length === 0) continue;
      detail.createDiv({ cls: "config-sync-sect", text: CATEGORY_LABELS[cat] });
      for (const e of inCat) this.renderRemoteDiffEntry(detail, e);
    }

    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";
    const directionText = pullAligned ? "Pull would bring these changes" : "Push would send these changes";

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.groups.filter((g) => !changedNames.has(g.name)).map((g) => g.name);
    const matched = matchNames.length;
    if (entries.length === 0) {
      detail.createDiv({ cls: "config-sync-unchanged", text: "✓ remote matches the local store" });
    } else if (matched > 0) {
      const line = detail.createDiv({
        cls: "config-sync-unchanged",
        text: `✓ ${matched} more item${matched === 1 ? " matches" : "s match"} ▸ · ${directionText}`,
      });
      line.addEventListener("click", () => line.setText(`✓ ${matchNames.join(" · ")}`));
    } else {
      detail.createDiv({ cls: "config-sync-remote-summary", text: directionText });
    }

    this.renderRemoteButtons(detail, remote, pullAligned, entries.length === 0);
  }

  private renderRemoteDiffEntry(detail: HTMLElement, e: RemoteDiffEntry): void {
    const row = detail.createDiv({ cls: "config-sync-report-row" });
    row.createSpan({ cls: "config-sync-rule-name", text: e.group });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    if (e.changes.added.length > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${e.changes.added.length}` });
    if (e.changes.updated.length > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${e.changes.updated.length}` });
    if (e.changes.deleted.length > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${e.changes.deleted.length}` });
  }

  private renderRemoteButtons(detail: HTMLElement, remote: Remote, pullAligned: boolean, noChanges: boolean): void {
    const bar = detail.createDiv({ cls: "config-sync-actionbar" });

    const pull = new ButtonComponent(bar);
    pull.setButtonText(`↓ Pull from ${remote.name}`);
    pull.buttonEl.addClass("config-sync-remote-btn", "is-pull");
    if (noChanges) pull.buttonEl.addClass("is-dimmed");
    else if (pullAligned) pull.buttonEl.addClass("is-primary");
    else {
      pull.buttonEl.addClass("is-dimmed");
      pull.buttonEl.setAttribute("aria-label", "Pull would overwrite your newer local store");
    }
    pull.onClick(async () => {
      await this.host.pullFrom(remote);
      await this.reload();
    });

    const push = new ButtonComponent(bar);
    push.setButtonText(`↑ Push to ${remote.name}`);
    push.buttonEl.addClass("config-sync-remote-btn", "is-push");
    if (noChanges) push.buttonEl.addClass("is-dimmed");
    else if (!pullAligned) push.buttonEl.addClass("is-primary");
    else {
      push.buttonEl.addClass("is-dimmed");
      push.buttonEl.setAttribute("aria-label", "Push would overwrite the newer remote");
    }
    push.onClick(async () => {
      await this.host.pushTo(remote);
      await this.reload();
    });
  }
}
