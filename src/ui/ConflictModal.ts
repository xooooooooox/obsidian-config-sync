import { App, Modal, Platform } from "obsidian";
import { PendingPull } from "../core/ConfigSyncCore";
import { MergeConflict } from "../core/merge";
import { SyncGroup } from "../core/types";

type Side = "local" | "remote";
type DiffView = "unified" | "split";

// Session-level view preference: switching one diff makes later expansions follow. Not persisted.
let sessionDiffView: DiffView = "unified";

interface DiffOp {
  kind: "common" | "del" | "ins";
  text: string;
}

const DIFF_LINE_CAP = 2000;

// Minimal LCS line diff — good enough for config-sized JSON; capped for pathological inputs.
function diffLines(localText: string, remoteText: string): DiffOp[] | null {
  const a = localText.split("\n");
  const b = remoteText.split("\n");
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) return null;
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "common", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      ops.push({ kind: "ins", text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "ins", text: b[j++]! });
  return ops;
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortKeysDeep(rec[k]);
    return out;
  }
  return v;
}

function definitionText(g: SyncGroup): string {
  return JSON.stringify(sortKeysDeep(g), null, 2);
}

export class ConflictModal extends Modal {
  private choices: (Side | null)[];
  private applyBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private rowEls: HTMLElement[] = [];
  private decided = false;

  constructor(
    app: App,
    private pending: PendingPull,
    private remoteName: string,
    private displayName: (name: string) => string,
    private onResolve: (choices: Side[]) => void,
    private onCancel: () => void
  ) {
    super(app);
    this.choices = pending.plan.conflicts.map(() => null);
  }

  onOpen(): void {
    const { plan } = this.pending;
    this.modalEl.addClass("config-sync-cm");
    const auto = plan.auto;
    const autoCount = auto.addGroups.length + auto.writeFiles.length + auto.keptLocalGroups.length + auto.keptLocalFiles.length + auto.identical.length;
    const compared = autoCount + plan.conflicts.length;

    // ── pinned header ──
    const header = this.contentEl.createDiv({ cls: "config-sync-cm-header" });
    header.createDiv({ cls: "config-sync-cm-title", text: "Resolve pull conflicts" });
    header.createDiv({ cls: "config-sync-cm-sub", text: `Pulling from ${this.remoteName} · ${compared} items compared` });

    const body = this.contentEl.createDiv({ cls: "config-sync-cm-body" });

    // ── auto-merged section (collapsed by default) ──
    const addCount = auto.addGroups.length + auto.writeFiles.length;
    const identCount = auto.identical.length;
    const keptCount = auto.keptLocalGroups.length + auto.keptLocalFiles.length;
    const autoBox = body.createDiv({ cls: "config-sync-cm-auto" });
    const autoHead = autoBox.createDiv({ cls: "config-sync-cm-auto-head" });
    autoHead.createSpan({ cls: "config-sync-cm-auto-check", text: "✓" });
    autoHead.createSpan({ cls: "config-sync-cm-auto-label", text: `${autoCount} item${autoCount === 1 ? "" : "s"} merge cleanly` });
    autoHead.createSpan({ cls: "config-sync-cm-auto-counts", text: `＋${addCount} · ＝${identCount} · ⌂${keptCount}` });
    autoHead.createDiv({ cls: "config-sync-rule-spacer" });
    const autoChev = autoHead.createSpan({ cls: "config-sync-cm-chev", text: "⌄" });
    const autoList = autoBox.createDiv({ cls: "config-sync-cm-auto-list" });
    autoList.hide();
    const reason = (mark: string, cls: string, text: string): void => {
      const line = autoList.createDiv({ cls: "config-sync-cm-auto-line" });
      line.createSpan({ cls: `config-sync-cm-mark ${cls}`, text: mark });
      line.createSpan({ text });
    };
    for (const g of auto.addGroups) reason("＋", "is-add", `${this.displayName(g.name)} — new group from remote (added, incl. store files)`);
    for (const f of auto.writeFiles) reason("＋", "is-add", `${f.name === "" ? f.rel : this.displayName(f.name)} — store file only on remote (written locally)`);
    for (const id of auto.identical) reason("＝", "is-same", `${this.autoLabel(id)} — identical on both sides`);
    for (const name of auto.keptLocalGroups) reason("⌂", "is-kept", `${this.displayName(name)} — only exists locally (kept, never deleted)`);
    for (const rel of auto.keptLocalFiles) reason("⌂", "is-kept", `${rel} — only exists locally (kept)`);
    autoHead.addEventListener("click", () => {
      const open = autoList.isShown();
      if (open) autoList.hide();
      else autoList.show();
      autoChev.setText(open ? "⌄" : "⌃");
    });

    // ── conflicts header + shortcuts ──
    const chead = body.createDiv({ cls: "config-sync-cm-chead" });
    chead.createSpan({ cls: "config-sync-cm-ctitle", text: `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"}` });
    chead.createSpan({ cls: "config-sync-cm-csub", text: "both sides changed — pick a side per row" });
    chead.createDiv({ cls: "config-sync-rule-spacer" });
    const allLocal = chead.createEl("button", { cls: "config-sync-cm-allbtn", text: "All local" });
    const allRemote = chead.createEl("button", { cls: "config-sync-cm-allbtn", text: "All remote" });
    allLocal.addEventListener("click", () => this.chooseAll("local"));
    allRemote.addEventListener("click", () => this.chooseAll("remote"));

    // ── conflict rows ──
    plan.conflicts.forEach((c, i) => this.renderConflict(body, c, i));

    // ── pinned footer ──
    const footer = this.contentEl.createDiv({ cls: "config-sync-cm-footer" });
    this.statusEl = footer.createSpan({ cls: "config-sync-cm-status" });
    footer.createDiv({ cls: "config-sync-rule-spacer" });
    const cancel = footer.createEl("button", { text: "Cancel pull" });
    cancel.addEventListener("click", () => this.close());
    this.applyBtn = footer.createEl("button", { cls: "mod-cta", text: "Apply merge" });
    this.applyBtn.addEventListener("click", () => {
      if (this.choices.some((c) => c === null)) return;
      this.decided = true;
      this.onResolve(this.choices as Side[]);
      this.close();
    });
    this.refreshFooter(autoCount);
  }

  onClose(): void {
    if (!this.decided) this.onCancel();
    this.contentEl.empty();
  }

  private autoLabel(id: string): string {
    if (id.startsWith("group:")) return this.displayName(id.slice("group:".length));
    return id.startsWith("file:") ? id.slice("file:".length) : id;
  }

  private chooseAll(side: Side): void {
    this.choices = this.choices.map(() => side);
    this.rowEls.forEach((row, i) => this.paintChoice(row, this.choices[i] ?? null));
    this.refreshFooter(null);
  }

  private renderConflict(body: HTMLElement, c: MergeConflict, index: number): void {
    const row = body.createDiv({ cls: "config-sync-cm-conflict is-unresolved" });
    this.rowEls.push(row);
    const head = row.createDiv({ cls: "config-sync-cm-crow" });
    const chev = head.createSpan({ cls: "config-sync-cm-chev", text: "⌄" });
    head.createSpan({ cls: "config-sync-cm-cname", text: c.name === "" ? (c.kind === "file" ? c.rel : "(store)") : this.displayName(c.name) });
    head.createSpan({ cls: `config-sync-cm-kind is-${c.kind}`, text: c.kind === "definition" ? "DEFINITION" : "FILE" });
    if (c.kind === "file") head.createSpan({ cls: "config-sync-cm-rel", text: c.rel });
    head.createDiv({ cls: "config-sync-rule-spacer" });
    head.createSpan({ cls: "config-sync-cm-warn", text: "⚠ choose a side" });
    const seg = head.createDiv({ cls: "config-sync-cm-seg" });
    const localBtn = seg.createEl("button", { cls: "config-sync-cm-segbtn", text: "Local" });
    const remoteBtn = seg.createEl("button", { cls: "config-sync-cm-segbtn", text: "Remote" });
    localBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.choices[index] = "local";
      this.paintChoice(row, "local");
      this.refreshFooter(null);
    });
    remoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.choices[index] = "remote";
      this.paintChoice(row, "remote");
      this.refreshFooter(null);
    });

    // expandable diff
    const diffHost = row.createDiv({ cls: "config-sync-cm-diffhost" });
    diffHost.hide();
    let built = false;
    head.addEventListener("click", () => {
      const open = diffHost.isShown();
      if (open) {
        diffHost.hide();
        chev.setText("⌄");
        return;
      }
      if (!built) {
        this.buildDiff(diffHost, c);
        built = true;
      }
      diffHost.show();
      chev.setText("⌃");
    });
  }

  private paintChoice(row: HTMLElement, side: Side | null): void {
    row.toggleClass("is-unresolved", side === null);
    const btns = row.querySelectorAll<HTMLButtonElement>(".config-sync-cm-segbtn");
    const local = btns[0];
    const remote = btns[1];
    if (local) local.toggleClass("is-on", side === "local");
    if (remote) remote.toggleClass("is-on", side === "remote");
  }

  private refreshFooter(autoCountIn: number | null): void {
    const resolved = this.choices.filter((c) => c !== null).length;
    const total = this.choices.length;
    const auto = autoCountIn ?? this.autoCount();
    this.statusEl?.setText(`${resolved} of ${total} resolved · nothing is written until you apply`);
    if (this.applyBtn) {
      this.applyBtn.disabled = resolved !== total;
      this.applyBtn.setText(`Apply merge (${auto} + ${resolved}/${total})`);
    }
  }

  private autoCount(): number {
    const a = this.pending.plan.auto;
    return a.addGroups.length + a.writeFiles.length + a.keptLocalGroups.length + a.keptLocalFiles.length + a.identical.length;
  }

  private buildDiff(host: HTMLElement, c: MergeConflict): void {
    const localText = c.kind === "definition" ? definitionText(c.local) : c.localContent;
    const remoteText = c.kind === "definition" ? definitionText(c.remote) : c.remoteContent;
    const toolbar = host.createDiv({ cls: "config-sync-cm-difftools" });
    toolbar.createSpan({ cls: "config-sync-cm-diffmeta", text: c.kind === "definition" ? "group definition" : "--- local · +++ remote" });
    toolbar.createDiv({ cls: "config-sync-rule-spacer" });
    const pane = host.createDiv({ cls: "config-sync-cm-diffpane" });
    const render = (): void => {
      pane.empty();
      const ops = diffLines(localText, remoteText);
      if (ops === null) {
        pane.createDiv({ cls: "config-sync-cm-diffbig", text: "Content differs — too large to diff inline." });
        return;
      }
      if (sessionDiffView === "unified" || Platform.isMobile) this.renderUnified(pane, ops);
      else this.renderSplit(pane, ops);
    };
    if (!Platform.isMobile) {
      const toggle = toolbar.createDiv({ cls: "config-sync-cm-viewseg" });
      const uni = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Unified" });
      const spl = toggle.createEl("button", { cls: "config-sync-cm-viewbtn", text: "Split" });
      const paint = (): void => {
        uni.toggleClass("is-on", sessionDiffView === "unified");
        spl.toggleClass("is-on", sessionDiffView === "split");
      };
      uni.addEventListener("click", () => {
        sessionDiffView = "unified";
        paint();
        render();
      });
      spl.addEventListener("click", () => {
        sessionDiffView = "split";
        paint();
        render();
      });
      paint();
    }
    render();
  }

  private renderUnified(pane: HTMLElement, ops: DiffOp[]): void {
    const box = pane.createDiv({ cls: "config-sync-cm-unified" });
    box.createDiv({ cls: "config-sync-cm-dline is-delhead", text: "--- local  (this device)" });
    box.createDiv({ cls: "config-sync-cm-dline is-inshead", text: `+++ remote (${this.remoteName})` });
    for (const op of ops) {
      const prefix = op.kind === "del" ? "- " : op.kind === "ins" ? "+ " : "  ";
      box.createDiv({ cls: `config-sync-cm-dline is-${op.kind}`, text: prefix + op.text });
    }
  }

  private renderSplit(pane: HTMLElement, ops: DiffOp[]): void {
    const wrap = pane.createDiv({ cls: "config-sync-cm-split" });
    const left = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
    const right = wrap.createDiv({ cls: "config-sync-cm-splitpane" });
    left.createDiv({ cls: "config-sync-cm-dline is-delhead", text: "local (this device)" });
    right.createDiv({ cls: "config-sync-cm-dline is-inshead", text: `remote (${this.remoteName})` });
    for (const op of ops) {
      if (op.kind === "common") {
        left.createDiv({ cls: "config-sync-cm-dline is-common", text: op.text });
        right.createDiv({ cls: "config-sync-cm-dline is-common", text: op.text });
      } else if (op.kind === "del") {
        left.createDiv({ cls: "config-sync-cm-dline is-del", text: op.text });
        right.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
      } else {
        left.createDiv({ cls: "config-sync-cm-dline is-pad", text: " " });
        right.createDiv({ cls: "config-sync-cm-dline is-ins", text: op.text });
      }
    }
  }
}
