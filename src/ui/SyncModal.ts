import { App, ButtonComponent, ExtraButtonComponent, Modal } from "obsidian";
import { GroupStatus, GroupState, RemoteCheck, RemoteDiffEntry } from "../core/status";
import { CATEGORY_LABELS, ItemCategory, categoryForGroup } from "../core/catalog";
import { FileChanges, Remote, SyncGroup, hasChanges } from "../core/types";

const CATEGORY_ORDER: ItemCategory[] = ["obsidian", "core", "community", "custom"];

// Direction a checkable row acts in: capture pushes this device → store; apply pulls store → device.
type Direction = "capture" | "apply";

export interface SyncModalHost {
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

// A checkable row acts in "capture" for local-changed/not-captured (this device is ahead / not stored),
// and in "apply" for store-newer/differs (store should overwrite this device).
function directionForState(state: GroupState): Direction {
  return state === "local-changed" || state === "not-captured" ? "capture" : "apply";
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

export class SyncModal extends Modal {
  private groups: SyncGroup[] = [];
  private statuses: Map<string, GroupStatus> = new Map();
  private selected: Set<string> = new Set();
  private expandedItems: Set<string> = new Set();
  private expandedRemotes: Set<string> = new Set();
  private renderGen = 0;
  private remotesEl: HTMLElement | null = null;

  constructor(app: App, private host: SyncModalHost) {
    super(app);
  }

  onOpen(): void {
    // Disable scrim-close: swallow clicks on the modal background at capture phase so Obsidian's
    // own close handler never fires. Esc and the × button close through separate paths, untouched.
    const bg = this.containerEl.children[0] as HTMLElement;
    bg.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true });
    this.titleEl.setText("Config Sync");
    void this.reload();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async reload(): Promise<void> {
    const gen = ++this.renderGen;
    const { groups, statuses } = await this.host.computeStatuses();
    if (gen !== this.renderGen) return;
    this.groups = groups;
    this.statuses = new Map(statuses.map((s) => [s.group, s]));
    // Selections reset to defaults on every reload: pre-check local-changed + store-newer only.
    this.selected = new Set();
    for (const s of statuses) {
      if (s.state === "local-changed" || s.state === "store-newer") this.selected.add(s.group);
    }
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

  private render(gen: number): void {
    if (gen !== this.renderGen) return;
    this.contentEl.empty();
    this.remotesEl = null;
    this.renderHeaderPills();
    this.renderDeviceMacro();
    this.renderRemotes();
  }

  private renderHeaderPills(): void {
    const up = this.rows().filter((r) => r.status.state === "local-changed").length;
    const down = this.rows().filter((r) => r.status.state === "store-newer").length;
    const ok = this.rows().filter((r) => r.status.state === "in-sync").length;
    this.titleEl.empty();
    this.titleEl.setText("Config Sync");
    const pills = this.titleEl.createSpan({ cls: "config-sync-report-pills" });
    pills.createSpan({
      cls: "config-sync-pill is-up",
      text: `↑ ${up}`,
      attr: { "aria-label": `${up} item${up === 1 ? "" : "s"} changed on this device` },
    });
    pills.createSpan({
      cls: "config-sync-pill is-down",
      text: `↓ ${down}`,
      attr: { "aria-label": `${down} item${down === 1 ? "" : "s"}: store is newer` },
    });
    pills.createSpan({
      cls: "config-sync-pill is-ok",
      text: `✓ ${ok}`,
      attr: { "aria-label": `${ok} item${ok === 1 ? "" : "s"} in sync` },
    });
  }

  private renderDeviceMacro(): void {
    const macro = this.contentEl.createDiv({ cls: "config-sync-macro" });
    macro.createDiv({ cls: "config-sync-macro-head", text: "This device ↔ store" });

    for (const cat of CATEGORY_ORDER) {
      const inCat = this.rows().filter((r) => categoryForGroup(r.group.name) === cat);
      if (inCat.length === 0) continue;
      const sect = macro.createDiv({ cls: "config-sync-sect" });
      const boxCb = sect.createEl("input", {
        type: "checkbox",
        attr: { "aria-label": `Select all ${CATEGORY_LABELS[cat]}` },
      });
      sect.createSpan({ text: ` ${CATEGORY_LABELS[cat]}` });
      const card = macro.createDiv({ cls: "config-sync-card" });
      for (const r of inCat) this.renderItemRow(card, r);
      this.wireSectionCheckbox(boxCb, inCat);
    }

    this.renderActionBar(macro);
  }

  // Native tri-state: checked when all checkable rows selected, indeterminate when some, else unchecked.
  private wireSectionCheckbox(box: HTMLInputElement, inCat: StatusRow[]): void {
    const checkable = inCat.filter((r) => r.status.state !== "in-sync").map((r) => r.group.name);
    const selectedCount = checkable.filter((n) => this.selected.has(n)).length;
    if (checkable.length === 0) {
      box.disabled = true;
      box.checked = false;
    } else if (selectedCount === checkable.length) {
      box.checked = true;
    } else if (selectedCount === 0) {
      box.checked = false;
    } else {
      box.indeterminate = true;
    }
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      // Decide from the pre-click selection, not the DOM: any-not-selected → select all, else clear all.
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
    const insync = status.state === "in-sync";
    const row = card.createDiv({ cls: `config-sync-hub-row${insync ? " is-insync" : ""}` });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: this.expandedItems.has(group.name) ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: group.name });
    row.createSpan({ cls: "config-sync-row-path", text: this.host.resolvedPath(group) });
    row.createDiv({ cls: "config-sync-rule-spacer" });

    const icon = this.stateIcon(status.state);
    row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });

    const dir = directionForState(status.state);
    const cb = row.createEl("input", { type: "checkbox" });
    cb.addClass(dir === "capture" ? "is-capture" : "is-apply");
    cb.disabled = insync;
    cb.checked = this.selected.has(group.name);
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (cb.checked) this.selected.add(group.name);
      else this.selected.delete(group.name);
      this.render(this.renderGen);
    });

    // Checked apply-over-differs warns that store will overwrite uncommitted local edits.
    if (status.state === "differs" && this.selected.has(group.name)) {
      card.createDiv({ cls: "config-sync-hub-hint", text: "⚠ applying overwrites local changes" });
    }

    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !this.expandedItems.has(group.name);
    this.renderChangesInto(detail, status.changes);
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
      case "in-sync":
      default:
        return { glyph: "✓", cls: "is-ok", tip: "in sync" };
    }
  }

  private renderChangesInto(detail: HTMLElement, changes: FileChanges | undefined): void {
    if (changes === undefined) return;
    for (const f of changes.added) detail.createDiv({ cls: "is-add", text: `+ ${f}` });
    for (const f of changes.updated) detail.createDiv({ cls: "is-upd", text: `~ ${f}` });
    for (const f of changes.deleted) detail.createDiv({ cls: "is-del", text: `− ${f}` });
  }

  private captureNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && directionForState(r.status.state) === "capture")
      .map((r) => r.group.name);
  }

  private applyNames(): string[] {
    return this.rows()
      .filter((r) => this.selected.has(r.group.name) && directionForState(r.status.state) === "apply")
      .map((r) => r.group.name);
  }

  private renderActionBar(macro: HTMLElement): void {
    const bar = macro.createDiv({ cls: "config-sync-actionbar" });
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

  private renderRemotes(): void {
    // Rebuild in place so the refresh button re-renders only this block, not the whole modal.
    if (this.remotesEl !== null) {
      this.remotesEl.remove();
      this.remotesEl = null;
    }
    const remotes = this.host.remotes();
    if (remotes.length === 0) return;
    const macro = this.contentEl.createDiv({ cls: "config-sync-macro" });
    this.remotesEl = macro;
    let newestCheck: number | null = null;
    for (const remote of remotes) {
      const c = this.host.remoteCheck(remote.name);
      if (c !== undefined && (newestCheck === null || c.at > newestCheck)) newestCheck = c.at;
    }
    const head = macro.createDiv({ cls: "config-sync-macro-head" });
    head.createSpan({ text: `Remotes · checked ${newestCheck === null ? "never" : relativeAge(newestCheck)}` });
    const refresh = new ExtraButtonComponent(head);
    refresh.setIcon("refresh-cw");
    refresh.setTooltip("Re-check remotes");
    refresh.onClick(async () => {
      await this.host.refreshRemoteChecks();
      this.renderRemotes();
    });

    const card = macro.createDiv({ cls: "config-sync-card" });
    for (const remote of remotes) this.renderRemoteRow(card, remote);
  }

  private renderRemoteRow(card: HTMLElement, remote: Remote): void {
    const cached = this.host.remoteCheck(remote.name);
    const check: RemoteCheck | undefined = cached?.check;
    const expanded = this.expandedRemotes.has(remote.name);
    const row = card.createDiv({ cls: "config-sync-hub-row" });
    const chev = row.createSpan({ cls: "config-sync-row-chevron", text: expanded ? "▾" : "▸" });
    row.createSpan({ cls: "config-sync-rule-name", text: remote.name });
    const icon = this.remoteIcon(check);
    row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, text: icon.glyph, attr: { "aria-label": icon.tip } });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    row.createSpan({ cls: "config-sync-row-path", text: `captured ${isoAge(check?.remoteCapturedAt ?? null)}` });

    const detail = card.createDiv({ cls: "config-sync-report-files" });
    detail.hidden = !expanded;
    if (expanded) void this.renderRemoteDetail(detail, remote, check);
    row.addEventListener("click", () => {
      if (this.expandedRemotes.has(remote.name)) {
        this.expandedRemotes.delete(remote.name);
        detail.hidden = true;
        chev.setText("▸");
      } else {
        this.expandedRemotes.add(remote.name);
        detail.hidden = false;
        chev.setText("▾");
        void this.renderRemoteDetail(detail, remote, this.host.remoteCheck(remote.name)?.check);
      }
    });
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
      if (gen !== this.renderGen || !this.expandedRemotes.has(remote.name)) return;
      detail.empty();
      detail.createDiv({ cls: "config-sync-status-error", text: `cannot compare: ${(e as Error).message}` });
      return;
    }
    if (gen !== this.renderGen || !this.expandedRemotes.has(remote.name)) return;
    detail.empty();

    const changed = entries.filter((e) => hasChanges(e.changes));
    for (const cat of CATEGORY_ORDER) {
      const inCat = changed.filter((e) => categoryForGroup(e.group) === cat);
      if (inCat.length === 0) continue;
      detail.createDiv({ cls: "config-sync-sect", text: CATEGORY_LABELS[cat] });
      for (const e of inCat) this.renderRemoteDiffEntry(detail, e);
    }

    // "N more items match" line: groups present in this device's list minus the entries that differ
    // (excludes the "" store-metadata pseudo-entry and any remote-only groups from the count).
    const changedNames = new Set(changed.map((e) => e.group));
    const matchNames = this.groups.filter((g) => !changedNames.has(g.name)).map((g) => g.name);
    const matched = matchNames.length;
    if (matched > 0) {
      const line = detail.createDiv({
        cls: "config-sync-unchanged",
        text: `✓ ${matched} more item${matched === 1 ? "" : "s"} match ▸`,
      });
      line.addEventListener("click", () => line.setText(`✓ ${matchNames.join(" · ")}`));
    }

    const state = check?.state ?? "unknown";
    const pullAligned = state === "remote-newer" || state === "same" || state === "unknown" || state === "no-store";
    detail.createDiv({
      cls: "config-sync-remote-summary",
      text: pullAligned ? "Pull would bring these changes" : "Push would send these changes",
    });
    this.renderRemoteButtons(detail, remote, pullAligned);
  }

  private renderRemoteDiffEntry(detail: HTMLElement, e: RemoteDiffEntry): void {
    const row = detail.createDiv({ cls: "config-sync-report-row" });
    row.createSpan({ cls: "config-sync-rule-name", text: e.group });
    row.createDiv({ cls: "config-sync-rule-spacer" });
    if (e.changes.added.length > 0) row.createSpan({ cls: "config-sync-chip is-add", text: `+${e.changes.added.length}` });
    if (e.changes.updated.length > 0) row.createSpan({ cls: "config-sync-chip is-upd", text: `~${e.changes.updated.length}` });
    if (e.changes.deleted.length > 0) row.createSpan({ cls: "config-sync-chip is-del", text: `−${e.changes.deleted.length}` });
  }

  private renderRemoteButtons(detail: HTMLElement, remote: Remote, pullAligned: boolean): void {
    const bar = detail.createDiv({ cls: "config-sync-actionbar" });

    const pull = new ButtonComponent(bar);
    pull.setButtonText(`↓ Pull from ${remote.name}`);
    pull.buttonEl.addClass("config-sync-remote-btn", "is-pull");
    if (pullAligned) pull.buttonEl.addClass("is-primary");
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
    if (!pullAligned) push.buttonEl.addClass("is-primary");
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
