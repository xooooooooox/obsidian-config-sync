import { App, Modal } from "obsidian";
import { isSelfStoreRel, PendingPull } from "../core/ConfigSyncCore";
import { MergeConflict, mergeDisclosure, sortKeysDeep } from "../core/merge";
import { SyncGroup } from "../core/types";
import { renderDiffPanel } from "./diffView";
import { isSwitchListGroup, switchListSortedView } from "../core/switchList";
import { renderFoldChevron, setFoldOpen } from "./foldChevron";

type Side = "local" | "remote";

function definitionText(g: SyncGroup): string {
  return JSON.stringify(sortKeysDeep(g), null, 2);
}

export class ConflictModal extends Modal {
  private choices: (Side | null)[];
  private applyBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private rowEls: HTMLElement[] = [];
  private decided = false;
  private selfHintShown = false;

  constructor(
    app: App,
    private pending: PendingPull,
    private remoteName: string,
    // Conflicts arrive ordered: the first `pickedCount` sit on items the user staged, the rest
    // came along with the whole-store merge (an unstaged family, a remote-only item, an
    // unattributable file). The two render as sections; the caller owns the ordering.
    private pickedCount: number,
    // Whether the self-item hint may render at all: false once this remote carries a written
    // rule for config-sync — that user has already used the control the hint teaches.
    private showSelfHint: boolean,
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
    // Files and real writes only (mergeDisclosure): definition entries are invisible in this
    // modal, so they appear in no number here either.
    const auto = mergeDisclosure(plan.auto);
    const compared = auto.count + plan.conflicts.length;

    const header = this.contentEl.createDiv({ cls: "config-sync-cm-header" });
    header.createDiv({ cls: "config-sync-cm-title", text: "Resolve pull conflicts" });
    // "· N items compared" travels with the box below: when nothing merges cleanly, the
    // conflicts are the whole story and the header has no second number to explain.
    header.createDiv({ cls: "config-sync-cm-sub", text: auto.count === 0 ? `Pulling from ${this.remoteName}` : `Pulling from ${this.remoteName} · ${compared} items compared` });

    const body = this.contentEl.createDiv({ cls: "config-sync-cm-body" });

    if (auto.count > 0) {
      const autoBox = body.createDiv({ cls: "config-sync-cm-auto" });
      const autoHead = autoBox.createDiv({ cls: "config-sync-cm-auto-head" });
      autoHead.createSpan({ cls: "config-sync-cm-auto-check", text: "✓" });
      autoHead.createSpan({ cls: "config-sync-cm-auto-label", text: `${auto.count} item${auto.count === 1 ? "" : "s"} merge cleanly` });
      autoHead.createSpan({ cls: "config-sync-cm-auto-counts", text: `＋${auto.add} · ＝${auto.identicalFiles.length} · ⌂${auto.keptFiles.length}` });
      autoHead.createDiv({ cls: "config-sync-rule-spacer" });
      const autoChev = renderFoldChevron(autoHead, false, "config-sync-cm-chev");
      const autoList = autoBox.createDiv({ cls: "config-sync-cm-auto-list" });
      autoList.hide();
      const reason = (mark: string, cls: string, text: string): void => {
        const line = autoList.createDiv({ cls: "config-sync-cm-auto-line" });
        line.createSpan({ cls: `config-sync-cm-mark ${cls}`, text: mark });
        line.createSpan({ text });
      };
      for (const g of plan.auto.addGroups) reason("＋", "is-add", `${this.displayName(g.name)}: new item from remote (added, incl. its store files)`);
      for (const f of plan.auto.writeFiles) reason("＋", "is-add", `${f.name === "" ? f.rel : this.displayName(f.name)}: store file only on remote (written locally)`);
      for (const id of auto.identicalFiles) reason("＝", "is-same", `${this.autoLabel(id)}: identical on both sides`);
      for (const rel of auto.keptFiles) reason("⌂", "is-kept", `${rel}: only exists locally (kept)`);
      autoHead.addEventListener("click", () => {
        const open = autoList.isShown();
        if (open) autoList.hide();
        else autoList.show();
        setFoldOpen(autoChev, !open);
      });
    }

    const chead = body.createDiv({ cls: "config-sync-cm-chead" });
    chead.createSpan({ cls: "config-sync-cm-ctitle", text: `${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? "" : "s"}` });
    chead.createSpan({ cls: "config-sync-cm-csub", text: "both sides changed; pick a side per row" });
    chead.createDiv({ cls: "config-sync-rule-spacer" });
    const allLocal = chead.createEl("button", { cls: "config-sync-cm-allbtn", text: "All local" });
    const allRemote = chead.createEl("button", { cls: "config-sync-cm-allbtn", text: "All remote" });
    allLocal.addEventListener("click", () => this.chooseAll("local"));
    allRemote.addEventListener("click", () => this.chooseAll("remote"));

    // Section headers answer "why is this row here" — the came-along one carries the
    // explanation in its own subtitle, so a conflict on an item the user never staged is
    // announced rather than discovered. A section with no rows renders no header.
    const cameCount = plan.conflicts.length - this.pickedCount;
    const section = (label: string, count: number, why: string | null, came: boolean): void => {
      const head = body.createDiv({ cls: `config-sync-cm-sect${came ? " is-came" : ""}` });
      head.createSpan({ cls: "config-sync-cm-sect-label", text: label });
      head.createSpan({ cls: "config-sync-cm-sect-n", text: `${count}` });
      if (why !== null) head.createSpan({ cls: "config-sync-cm-sect-why", text: why });
    };
    // Only a MIXED list needs the picked header — when every conflict is on a picked item there
    // is nothing to tell apart and the list stays flat; a purely came-along list still gets its
    // one header, since that header carries the explanation.
    plan.conflicts.forEach((c, i) => {
      if (i === 0 && this.pickedCount > 0 && cameCount > 0) section("On items you picked", this.pickedCount, null, false);
      if (i === this.pickedCount && cameCount > 0)
        section("Came along with the pull", cameCount, "a pull compares the whole remote, and these also changed on both sides", true);
      this.renderConflict(body, c, i);
    });

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
    this.refreshFooter(auto.count);
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
    const chev = renderFoldChevron(head, false, "config-sync-cm-chev");
    head.createSpan({ cls: "config-sync-cm-cname", text: c.name === "" ? (c.kind === "file" ? c.rel : "Sync setup") : this.displayName(c.name) });
    head.createSpan({ cls: `config-sync-cm-kind is-${c.kind}`, text: c.kind === "definition" ? "Rule" : "File" });
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
        setFoldOpen(chev, false);
        return;
      }
      if (!built) {
        this.buildDiff(diffHost, c);
        built = true;
      }
      diffHost.show();
      setFoldOpen(chev, true);
    });
    // Once per modal: the self item's three store files (data.json + two sidecars) can conflict
    // together, and three copies of the same advice teach nothing more than one.
    if (c.kind === "file" && isSelfStoreRel(c.rel) && this.showSelfHint && !this.selfHintShown) {
      this.selfHintShown = true;
      row.createDiv({
        cls: "config-sync-cm-selfhint",
        text: "If this vault keeps its own Config Sync setup, you can leave it out of this remote (Settings → Remotes).",
      });
    }
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
      // With nothing merging cleanly the "0 +" would be an empty claim; the conflicts alone
      // ARE the merge then.
      this.applyBtn.setText(auto === 0 ? `Apply merge (${resolved}/${total})` : `Apply merge (${auto} + ${resolved}/${total})`);
    }
  }

  private autoCount(): number {
    return mergeDisclosure(this.pending.plan.auto).count;
  }

  private buildDiff(host: HTMLElement, c: MergeConflict): void {
    // On/off lists compare as sets — render both sides sorted so a real membership difference
    // isn't buried in per-device ordering noise.
    const sortedView = c.kind === "file" && isSwitchListGroup(c.name);
    const localText = c.kind === "definition" ? definitionText(c.local) : sortedView ? switchListSortedView(c.localContent) : c.localContent;
    const remoteText = c.kind === "definition" ? definitionText(c.remote) : sortedView ? switchListSortedView(c.remoteContent) : c.remoteContent;
    renderDiffPanel(
      host,
      localText,
      remoteText,
      "local  (this device)",
      `remote (${this.remoteName})`,
      { name: c.kind === "definition" ? "sync rule" : "--- local · +++ remote", sorted: c.kind !== "definition" && sortedView },
      null // already a modal — there is nowhere bigger to open
    );
  }
}
