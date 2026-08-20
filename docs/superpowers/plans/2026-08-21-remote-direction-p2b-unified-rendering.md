# 2.25.0 · Plan 2b:统一渲染 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 remote 关系走主列表那一套渲染器 —— 同一套行、同一套分区、同一张卡、同一个勾选框 —— 并退役 remote 专用渲染器那 520 行。

**Architecture:** remote 关系产出与设备关系**同一个 `GroupStatus` 形状**的行,由一个新的纯函数从 `diffRemote` 的结果 + 整库 `RemoteState` 推出来。`GroupState` 那套值不动;用户可见的词全部改由「关系」查表(`relationCopy`)。可用性轴(没装 / 被禁用 / 仅桌面)在 remote 关系下**整根撤掉** —— store 副本存不存在与本机装没装无关。勾选框接上 Plan 1 已经铺好的 `skipRefs`:没勾的行进 skipRefs,core 一行不改。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian API。`panelModel.ts` / 新的 core 文件保持零 DOM。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 5.1 / 5.3 / 5.4 的结构部分、5.8 三条新规矩)

## 迭代全景(2.25.0 第 2 块的第二份)

| # | 计划 | 状态 |
|---|---|---|
| 1 | 数据模型与迁移 | **DONE**,已合入 main |
| 2a | 关系轴与 View 选择器 | **DONE**,已合入 main |
| **2b** | **统一渲染(本文件)** | remote 产出行、退役专用渲染器、勾选框接 skipRefs |
| 2c | 收尾 | self 项两副面孔、撤掉 Settings 那个开关、状态栏单位统一为项 |
| 3 | 四档方向规则落地 | 传输语义、派生 lock、方向感知忽略集、「一致」重定义 |
| 4 | 加密 | 解密后比对、per-remote 密码短语(含 spec 5.7 的 `Passphrase` 行)、转码、信封复用 |

## Global Constraints

- **设备关系下一个像素都不许变。** 统一是让同一套组件在另一段关系下换一套词,不是改动现有界面。每个 Task 的冒烟都要复核这一条。
- **本轮的方向是整库的,不是逐行的。** `diffRemote` 只答「两侧字节等不等」,方向来自整库 `RemoteState`,所以**这一轮每一条变更行显示同一个方向**。逐行方向是 Plan 3。不许在本计划里造一个假的逐行方向。
- **勾选框必须真的管用。** 仓库明令「a dead affordance reads as a broken one」(`SyncCenterView.ts` 的静态分区头注释)。没勾的行进 `skipRefs`,由 `planImport` / `pushExternal` 跳过 —— 这两个入口 Plan 1 已经改成收 `skipRefs: ItemRef[]`,core 不用再动。
- **可用性轴在 remote 关系下整根撤掉**(spec 5.1)。没装 / 被禁用 / 仅桌面三个折叠区、以及 `versionAheadClause`,在 remote 关系下不渲染。
- **UI 文案逐字取自 spec 5.1 / 5.3**,不得改写:桶词 `To push` / `To pull` / `In sync` / `Doesn't sync with this remote` / `Nothing captured yet`;命运句 `Pushes settings` / `Pulls settings` / `Doesn't sync with this remote` / `Nothing to send`;折叠行 `N items match this remote` / `N items don't sync with this remote`;按钮 `Pull N` / `Push N`。
- **`Can't compare` 桶不在本轮**(加密项且本机未解锁,spec 3.8)——它属于 Plan 4。
- **不提交 Claude 署名**,提交信息不带任何 AI 归属尾注。
- 注释写不变量,不写变更史;不用 `§` 引章节。

---

### Task 1:remote 关系的行,从比较结果推出来

**Files:**
- Create: `src/core/remoteRows.ts`
- Test: `tests/remoteRows.test.ts`(新建)

**Interfaces:**
- Consumes: `RemoteDiffEntry`、`GroupStatus`、`GroupState`(`src/core/status.ts`);`FileChanges`(`src/core/types.ts`)
- Produces:
  - `type RemoteFlow = "pull" | "push"`
  - `function remoteFlowFor(state: RemoteState): RemoteFlow`
  - `function remoteRowStatuses(input: { entries: readonly RemoteDiffEntry[]; flow: RemoteFlow; localGroupNames: readonly string[] }): GroupStatus[]`

**语义映射(这一步全部的设计):** 一条 `RemoteDiffEntry` 的 `files` 按 `kind` 折成 `FileChanges`(`added`/`updated`/`deleted` 三桶,存的是 `itemRel`),而 `GroupState` 取决于 `flow` —— 拉方向上有差异就是 `store-newer`(远端有东西要进来),推方向上有差异就是 `local-changed`(我这边有东西要出去)。本地有、比较里没出现的项是 `in-sync`。远端独有的项(`localGroupNames` 里没有)照样出一行,状态同变更行 —— spec 5.8.1 的「没有本地对应物的行」。

- [ ] **Step 1: 写失败测试**

新建 `tests/remoteRows.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { remoteFlowFor, remoteRowStatuses } from "../src/core/remoteRows";
import { RemoteDiffEntry } from "../src/core/status";

const entry = (group: string, kinds: ("added" | "updated" | "deleted")[]): RemoteDiffEntry => ({
  group,
  files: kinds.map((kind, i) => ({ itemRel: `f${i}.json`, kind, local: null, remote: null })),
});

describe("remoteFlowFor", () => {
  it("reads the whole-store state as one direction for the whole list", () => {
    expect(remoteFlowFor("remote-newer")).toBe("pull");
    expect(remoteFlowFor("remote-older")).toBe("push");
  });

  it("treats every undecided state as pull — the additive one", () => {
    // Pull never removes local files; push mirror-deletes. When the store cannot say which side is
    // ahead, the safe reading is the one that cannot destroy anything.
    expect(remoteFlowFor("same")).toBe("pull");
    expect(remoteFlowFor("unknown")).toBe("pull");
    expect(remoteFlowFor("no-store")).toBe("pull");
  });
});

describe("remoteRowStatuses", () => {
  const local = ["appearance", "hotkeys", "dataview"];

  it("gives a changed item the direction the whole store is in", () => {
    const pull = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "pull", localGroupNames: local });
    expect(pull.find((s) => s.group === "hotkeys")?.state).toBe("store-newer");
    const push = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "push", localGroupNames: local });
    expect(push.find((s) => s.group === "hotkeys")?.state).toBe("local-changed");
  });

  it("folds the file kinds into the same FileChanges shape the device relation uses", () => {
    const [row] = remoteRowStatuses({
      entries: [entry("hotkeys", ["added", "updated", "updated", "deleted"])],
      flow: "pull",
      localGroupNames: local,
    });
    expect(row?.changes).toEqual({ added: ["f0.json"], updated: ["f1.json", "f2.json"], deleted: ["f3.json"] });
  });

  it("calls every local item the comparison did not mention in sync", () => {
    const rows = remoteRowStatuses({ entries: [entry("hotkeys", ["updated"])], flow: "pull", localGroupNames: local });
    expect(rows.filter((s) => s.state === "in-sync").map((s) => s.group).sort()).toEqual(["appearance", "dataview"]);
  });

  it("keeps an entry with no local counterpart — the remote has items this device does not", () => {
    const rows = remoteRowStatuses({ entries: [entry("themes", ["added"])], flow: "pull", localGroupNames: local });
    expect(rows.find((s) => s.group === "themes")?.state).toBe("store-newer");
    expect(rows).toHaveLength(4);
  });

  it("drops the store-metadata pseudo-entry, which is bookkeeping and never an item", () => {
    const rows = remoteRowStatuses({ entries: [entry("", ["updated"])], flow: "pull", localGroupNames: local });
    expect(rows.every((s) => s.group !== "")).toBe(true);
  });

  it("says nothing changed when the comparison found nothing", () => {
    const rows = remoteRowStatuses({ entries: [], flow: "pull", localGroupNames: local });
    expect(rows.every((s) => s.state === "in-sync")).toBe(true);
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRows.test.ts`
Expected: FAIL —— `src/core/remoteRows.ts` 不存在。

- [ ] **Step 3: 写实现**

新建 `src/core/remoteRows.ts`:

```ts
import { GroupState, GroupStatus, OTHER_STORE_FILES_GROUP, RemoteDiffEntry, RemoteState } from "./status";
import { FileChanges } from "./types";

// Which way this whole comparison points. ONE direction for the whole list: diffRemote only answers
// "are the two sides byte-equal", so there is no per-item evidence to point rows in different
// directions yet. Plan 3 is where a row gets its own answer.
export type RemoteFlow = "pull" | "push";

// Everything that is not "the remote is behind us" reads as pull, because pull is the additive
// operation: it never removes a local file, while push mirror-deletes whatever the remote has and we
// do not. An undecidable state must land on the side that cannot destroy anything.
export function remoteFlowFor(state: RemoteState): RemoteFlow {
  return state === "remote-older" ? "push" : "pull";
}

function changesOf(entry: RemoteDiffEntry): FileChanges {
  const out: FileChanges = { added: [], updated: [], deleted: [] };
  for (const f of entry.files) out[f.kind].push(f.itemRel);
  return out;
}

// The remote relation's rows, in the SAME shape the device relation produces, so one renderer can
// draw both. An item the comparison never mentioned is in sync with this remote — that is what
// "the comparison found no difference" means, and it is why the local list is the row set's floor
// rather than the diff being it.
export function remoteRowStatuses(input: {
  entries: readonly RemoteDiffEntry[];
  flow: RemoteFlow;
  localGroupNames: readonly string[];
}): GroupStatus[] {
  const { entries, flow, localGroupNames } = input;
  const changedState: GroupState = flow === "pull" ? "store-newer" : "local-changed";
  const out: GroupStatus[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    // "" is diffRemote's store-metadata pseudo-entry and OTHER_STORE_FILES_GROUP its unattributable
    // one. Neither is an item, so neither is ever a row.
    if (e.group === "" || e.group === OTHER_STORE_FILES_GROUP) continue;
    if (e.files.length === 0) continue;
    seen.add(e.group);
    out.push({ group: e.group, state: changedState, changes: changesOf(e) });
  }
  for (const name of localGroupNames) {
    if (seen.has(name)) continue;
    out.push({ group: name, state: "in-sync" });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/remoteRows.test.ts`
Expected: PASS(全部 8 条)

- [ ] **Step 5: 提交**

```bash
git add src/core/remoteRows.ts tests/remoteRows.test.ts
git commit -m "feat(core): a remote comparison produces rows in the device relation's shape"
```

---

### Task 2:两套状态词,一处查表

**Files:**
- Modify: `src/ui/panelModel.ts`(接 2a 那一节写)
- Test: `tests/panelRelation.test.ts`(续写)

**Interfaces:**
- Consumes: 2a 的 `PanelRelation`;`FateBucket`(`panelModel.ts` 已有)
- Produces:
  - `interface RelationCopy { bucket: Record<FateBucket, string>; sentence: { push: string; pull: string; excluded: string; nothing: string }; matchFold: (n: number) => string; excludedFold: (n: number) => string }`
  - `function relationCopy(r: PanelRelation): RelationCopy`

**为什么是查表而不是分支:** spec 5.1 的表是一一对应的五个桶,只有词不同。把它做成一张按关系取的表,三处按状态分桶的区域(侧栏徽章、筛选药丸、顶部药丸)各自只读表,谁也不会漏掉一处。

- [ ] **Step 1: 写失败测试**

追加到 `tests/panelRelation.test.ts`:

```ts
import { relationCopy } from "../src/ui/panelModel";

describe("relationCopy", () => {
  it("keeps every word the device relation shows today", () => {
    const c = relationCopy({ kind: "device" });
    expect(c.bucket.capture).toBe("To capture");
    expect(c.bucket.apply).toBe("To apply");
    expect(c.bucket.ok).toBe("In sync");
    expect(c.bucket.excluded).toBe("Not synced here");
    expect(c.bucket.none).toBe("No settings yet");
  });

  it("swaps in the remote relation's words, one for one", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.bucket.capture).toBe("To push");
    expect(c.bucket.apply).toBe("To pull");
    expect(c.bucket.ok).toBe("In sync");
    expect(c.bucket.excluded).toBe("Doesn't sync with this remote");
    expect(c.bucket.none).toBe("Nothing captured yet");
  });

  it("gives both relations the same five buckets and no more", () => {
    const device = Object.keys(relationCopy({ kind: "device" }).bucket).sort();
    const remote = Object.keys(relationCopy({ kind: "remote", name: "m" }).bucket).sort();
    expect(device).toEqual(remote);
  });

  it("carries the remote relation's own sentences", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.sentence.push).toBe("Pushes settings");
    expect(c.sentence.pull).toBe("Pulls settings");
    expect(c.sentence.excluded).toBe("Doesn't sync with this remote");
    expect(c.sentence.nothing).toBe("Nothing to send");
  });

  it("counts the fold lines in that relation's words", () => {
    const c = relationCopy({ kind: "remote", name: "main" });
    expect(c.matchFold(1)).toBe("1 item matches this remote");
    expect(c.matchFold(4)).toBe("4 items match this remote");
    expect(c.excludedFold(1)).toBe("1 item doesn't sync with this remote");
    expect(c.excludedFold(3)).toBe("3 items don't sync with this remote");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/panelRelation.test.ts -t relationCopy`
Expected: FAIL —— `relationCopy` 未导出。

- [ ] **Step 3: 写实现**

追加到 `src/ui/panelModel.ts`:

```ts
// The two relations' state words, one for one (spec 5.1). The BUCKETS are the same five under both —
// what changes is only what they are called — so this is a lookup rather than a branch: the three
// surfaces that bucket by state (sidebar badges, filter pills, header pills) each read the table and
// none of them can drift from the others. `conflict` shares `apply`'s word under both relations, the
// same way the apply filter pill already counts conflicts.
export interface RelationCopy {
  bucket: Record<FateBucket, string>;
  sentence: { push: string; pull: string; excluded: string; nothing: string };
  matchFold: (n: number) => string;
  excludedFold: (n: number) => string;
}

export function relationCopy(r: PanelRelation): RelationCopy {
  if (r.kind === "device") {
    return {
      bucket: { capture: "To capture", apply: "To apply", conflict: "To apply", ok: "In sync", excluded: "Not synced here", none: "No settings yet" },
      sentence: { push: "Captures settings", pull: "Applies settings", excluded: "Not synced here", nothing: NOTHING_YET_SENTENCE },
      matchFold: (n) => `${n} item${n === 1 ? "" : "s"} in sync`,
      excludedFold: (n) => `${n} item${n === 1 ? "" : "s"} not synced here`,
    };
  }
  return {
    bucket: { capture: "To push", apply: "To pull", conflict: "To pull", ok: "In sync", excluded: "Doesn't sync with this remote", none: "Nothing captured yet" },
    sentence: { push: "Pushes settings", pull: "Pulls settings", excluded: "Doesn't sync with this remote", nothing: "Nothing to send" },
    matchFold: (n) => `${n} item${n === 1 ? " matches" : "s match"} this remote`,
    excludedFold: (n) => `${n} item${n === 1 ? " doesn't" : "s don't"} sync with this remote`,
  };
}
```

`NOTHING_YET_SENTENCE` 来自 `./fateModel`,`panelModel.ts` 顶部已经从那里导入 `Fate` / `FateInput` / `rowFate`,把它加进同一行。

**注意** `matchFold` / `excludedFold` 的设备侧措辞:先去 `SyncCenterView.ts` 搜今天那两条折叠行的实际字符串,**照抄**,不要按上面的示意重写 —— 设备关系下一个像素都不许变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/panelRelation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/panelModel.ts tests/panelRelation.test.ts
git commit -m "feat(panel): one table holds both relations' state words"
```

---

### Task 3:勾选框接上 `skipRefs`

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`SyncCenterHost` 的 `pullFrom` / `pushTo` 声明,约 `:321-322`)
- Modify: `src/main.ts`(`pullFrom` / `pushTo` 两个实现)
- Test: `tests/remoteRows.test.ts`(续写)

**Interfaces:**
- Consumes: Plan 1 的 `refsBlockedFor`(`src/core/remoteRules.ts`)、`ItemRef`
- Produces:
  - `SyncCenterHost.pullFrom(remote: Remote, skipRefs: ItemRef[]): Promise<GroupResult[] | null>`
  - `SyncCenterHost.pushTo(remote: Remote, skipRefs: ItemRef[]): Promise<GroupResult[] | null>`
  - `function skipRefsForSelection(input: { allRefs: readonly ItemRef[]; selectedRefs: readonly ItemRef[] }): ItemRef[]`(`src/core/remoteRows.ts`)

**这一步为什么便宜:** Plan 1 已经把 `planImport` / `pushExternal` / `diffRemote` 的 opts 变成 `skipRefs: ItemRef[]`,并且 `main.ts` 已经在算 `refsBlockedFor(remote.items, …)`。这里只是让视图再交一份「用户没勾的」,由 `main.ts` 与规则算出来的那份取并集。**core 一行不改。**

- [ ] **Step 1: 写失败测试**

追加到 `tests/remoteRows.test.ts`:

```ts
import { skipRefsForSelection } from "../src/core/remoteRows";
import { ItemRef } from "../src/core/types";

describe("skipRefsForSelection", () => {
  const all = ["obsidian/appearance", "core/backlink", "community/dataview"] as ItemRef[];

  it("skips exactly what the user left unchecked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: ["core/backlink"] as ItemRef[] }).sort()).toEqual([
      "community/dataview",
      "obsidian/appearance",
    ]);
  });

  it("skips nothing when every row is checked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: all })).toEqual([]);
  });

  it("skips everything when nothing is checked", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: [] }).sort()).toEqual([...all].sort());
  });

  it("ignores a selected ref that is not on the list at all", () => {
    expect(skipRefsForSelection({ allRefs: all, selectedRefs: ["community/ghost"] as ItemRef[] }).sort()).toEqual([...all].sort());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRows.test.ts -t skipRefsForSelection`
Expected: FAIL —— 未导出。

- [ ] **Step 3: 写实现**

追加到 `src/core/remoteRows.ts`:

```ts
// The rows the user did NOT tick, as the skip list the transport already speaks. The checkbox means
// the same thing under both relations — "does this run include this row" — and under the remote
// relation that is exactly `skipRefs`, which planImport/pushExternal have taken since schema v5.
export function skipRefsForSelection(input: { allRefs: readonly ItemRef[]; selectedRefs: readonly ItemRef[] }): ItemRef[] {
  const keep = new Set<string>(input.selectedRefs);
  return input.allRefs.filter((r) => !keep.has(r));
}
```

`ItemRef` 从 `./types` 导入(该文件已经导入 `FileChanges`,加进同一行)。

`SyncCenterView.ts` 的 host 声明(`:321-322`):

```ts
  // skipRefs: the rows the user unticked. main.ts unions it with what this remote's own rules
  // withhold — the view knows the selection, the plugin knows the rules, and neither guesses.
  pullFrom(remote: Remote, skipRefs: ItemRef[]): Promise<GroupResult[] | null>;
  pushTo(remote: Remote, skipRefs: ItemRef[]): Promise<GroupResult[] | null>;
```

`main.ts` 两处实现:签名各加 `skipRefs: ItemRef[]`,并在算 opts 时取并集:

```ts
      pullFrom: async (remote, skipRefs) => {
        …
          const blocked = refsBlockedFor(remote.items, "pull");
          const pending = await planImport(ctx, await this.createReader(remote), { skipRefs: [...new Set([...blocked, ...skipRefs])] });
```

```ts
      pushTo: async (remote, skipRefs) => {
        …
          const blocked = refsBlockedFor(remote.items, "push");
          const results = await pushExternal(ctx, await this.createWriter(remote), { skipRefs: [...new Set([...blocked, ...skipRefs])] });
```

两个既有调用点(`renderRemoteButtons` 里的 `pullFrom(remote)` / `pushTo(remote)`)先传 `[]` —— Task 4 换成真选择之前,行为与今天逐值相同。

- [ ] **Step 4: 跑全套**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 三绿,lint 不超基线(0 error / 57 warn)。

- [ ] **Step 5: 提交**

```bash
git add src/core/remoteRows.ts src/main.ts src/ui/SyncCenterView.ts tests/remoteRows.test.ts
git commit -m "feat(remote): a run can leave rows out, the way the transport already understands"
```

---

### Task 4:remote 关系走主列表渲染器

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`renderItemMode` 与它下游的取数处;`renderMainRegionBody`)
- Modify: `src/ui/SyncCenterView.ts`(**删除** `renderRemoteMode` / `paintRemoteCompareResult` / `renderRemoteOnOff` / `renderRemoteDiffEntry` / `renderRemoteFileRows` / `renderRemoteFileDiff` / `renderRemoteButtons` 七个方法)

**Interfaces:**
- Consumes: Task 1 的 `remoteRowStatuses` / `remoteFlowFor`;Task 2 的 `relationCopy`;Task 3 的 `skipRefsForSelection` 与新的 host 签名
- Produces: 无新导出

**这是本计划的重头,分四步走,每步之间面板都要能开。**

- [ ] **Step 1: 让 `rows()` 认关系**

`rows()` 今天从 `this.statuses`(设备关系)建 `StatusRow[]`。改成:关系是设备时照旧;关系是 remote 时,从该 remote 的比较结果建 —— 比较结果已经缓存在 `this.inflightCompare`(见 `renderRemoteDetail`),把它提到视图字段 `remoteRows: Map<string, StatusRow[]>`,由比较完成时填。**比较还没回来时,remote 关系下 `rows()` 返回空**,主区画既有的「Comparing with …」进度块(从 `renderRemoteDetail` 里把那段搬进 `renderItemMode` 的空态分支)。

- [ ] **Step 2: 可用性轴与词表**

`renderItemMode` 里三处按可用性分的折叠区(没装 / 被禁用 / 仅桌面)在 `this.relation.kind === "remote"` 时**不渲染**;`versionAheadClause` 同样跳过。所有出现桶词与命运句的地方改读 `relationCopy(this.relation)`。**设备关系下这一步必须逐字不变** —— 用 Task 2 里从代码抄来的设备侧措辞。

- [ ] **Step 3: 按钮与勾选**

`renderActionBar` 在 remote 关系下画 `Pull N` / `Push N`(N = 勾选的行数),点击走:

**`StageableRow` 带的是 `itemName`,不是 `ref`** —— 选择是按组名记的,而 `skipRefs` 说的是 `ItemRef`,所以中间要过一次 `this.groups`:

```ts
    const refOfName = (name: string): ItemRef | undefined => findGroupByName(this.groups, name)?.ref;
    const allRefs = this.rows().map((r) => r.group.ref).filter((x): x is ItemRef => x !== undefined);
    const selectedRefs = this.stagedRows()
      .map((r) => refOfName(r.itemName))
      .filter((x): x is ItemRef => x !== undefined);
    const skip = skipRefsForSelection({ allRefs, selectedRefs });
    this.setLastRun("pull", remote.name, await this.host.pullFrom(remote, skip));
```

按方向各跑各的勾选行(spec 5.3 最后一句):`Pull N` 只算 apply 桶的勾选行,`Push N` 只算 capture 桶的。

**已知边界,写进代码注释:** 只有远端才有的项在本地没有 `SyncGroup`,也就没有 `ref`,所以它进不了 `allRefs`,**取消勾选对它无效** —— 它总是跟着跑。这不是本轮要解决的:`skipRelPredicate` 认远端 group 列表,真要支持得让视图拿到远端 manifest 里那一项的 ref,那是 Plan 3 处理「只有对面才有的项」时一并做的事。冒烟第 4 条只验它**出得来一行**,不验它能被取消勾选。

- [ ] **Step 4: 删掉七个方法**

`renderMainRegionBody` 里 `this.renderRemoteMode(main, remote)` 那一支删掉 —— remote 关系此后直接落到 `renderItemMode`。然后删七个方法,以及只被它们用到的字段(`remoteFoldsOpen`)与 CSS 类(见 Task 6)。

- [ ] **Step 5: 全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机冒烟(dev vault,两个真 store):
1. 设备关系下的列表、卡片、折叠、药丸、状态栏 —— **与 2a 逐像素相同**(截图比对)。
2. 切到 remote 关系:同一套分区头、同一套行(箭头 / 名字 / chip / 命运句 / 勾选框)。
3. 勾掉两行 → `Pull N` 的 N 跟着减;跑一次 → 那两行没被拉过来,其余拉了。
4. remote 那边有、本地没有的项照样出一行。
5. 可用性折叠区在 remote 关系下**不出现**。
6. `dev:errors` 无捕获。

- [ ] **Step 6: 提交**

```bash
git add src/ui/SyncCenterView.ts
git commit -m "refactor(panel): the remote relation renders through the item list, not its own screen"
```

---

### Task 5:三样孤儿功能找新家

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`renderUnifiedCard` 的 `Files` 行、卡内清单)

**Interfaces:**
- Consumes: Task 4 之后的卡片渲染
- Produces: 无新导出

spec 5.8.3 点名的三样,退役渲染器之后必须有落点:

- [ ] **Step 1: 行内文件级 diff → 卡片的 `Files` 行**

原 `renderRemoteFileRows` / `renderRemoteFileDiff` 的能力(逐文件 `+ ~ −` 三色、点开看内容 diff)并入既有的 `renderUnifiedFiles`。它今天已经画本地的文件清单与 diff;remote 关系下喂给它的是 `GroupStatus.changes`(Task 1 折出来的那份),内容 diff 的两侧取自比较结果里那条 `RemoteDiffFile` 的 `local` / `remote`。

- [ ] **Step 2: 插件开关逐个翻转清单 → 卡内清单**

原 `renderRemoteOnOff` 那段(某个开关名单项在两侧的逐个成员差异)并进该项卡片的既有清单行。它今天是钉在分区头下的一条特殊行;统一之后它就是那一项自己的卡片内容。

- [ ] **Step 3: 「有 N 个文件只有你这边有」→ 一致性叙述**

原 `paintRemoteCompareResult` 里 `config-sync-remote-kept` 那两句(拉方向说本地独有、推方向说远端独有)并入 spec 3.3 的一致性叙述:统一之后这些文件各自就是一行(拉方向下是 capture 桶,推方向下是 apply 桶),**行本身就说了这件事**,所以这两句整体撤掉,不另找位置。**这一条是删除,不是搬家** —— 写进提交信息里说清楚。

- [ ] **Step 4: 冒烟**

真机:remote 关系下点开一个变更项的卡片,`Files` 行列出逐文件差异并能点开内容 diff;一个开关名单项的卡片列出逐成员翻转。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SyncCenterView.ts
git commit -m "refactor(panel): the remote pane's three unique views move into the card"
```

---

### Task 6:搜索解禁、View 徽章换真计数、CSS 清理

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`renderSidebar` 的搜索禁用、`renderViewPicker` 的 `remotes` 入参)
- Modify: `src/ui/panelModel.ts`(`ViewBadge` 的 remote 分支)
- Modify: `styles.css`(删掉 remote 专用类)
- Test: `tests/panelRelation.test.ts`(改 `viewOptions` 的 remote 徽章断言)

- [ ] **Step 1: 搜索解禁**

删掉 2a 留下的那两行注释与 `if (this.relation.kind === "remote") searchEl.disabled = true;` —— remote 关系现在有行可筛了(spec 5.8.2)。

- [ ] **Step 2: View 徽章换成项计数**

`ViewBadge` 的 `{ kind: "remote-state"; state }` 换成与设备侧同形的 `{ kind: "push" | "pull"; count }`,`viewOptions` 的 `remotes` 入参从 `state` 换成 `{ push: number; pull: number }`。**只有比较跑过的 remote 才有计数**;没跑过的仍给状态图标,所以 `ViewBadge` 保留两个分支。同步改 Task 2a 写的那几条 `viewOptions` 测试。

- [ ] **Step 3: CSS 清理**

`grep -n "config-sync-remote-" styles.css`,删掉只被已退役方法用过的类(`-remote-pane`、`-remote-head`、`-remote-row`、`-remote-files`、`-remote-frow`、`-remote-fglyph`、`-remote-fname`、`-remote-summary`、`-remote-kept`)。`-remote-btn` 与 `-remote-selfnote` **留着**:前者动作条还在用,后者 2c 才撤。逐个 `grep` 确认没有别的引用再删。

- [ ] **Step 4: 全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
真机:remote 关系下搜索可用并能筛到行;View 下拉里跑过比较的 remote 显示 ⇡/⇣ 项计数。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SyncCenterView.ts src/ui/panelModel.ts styles.css tests/panelRelation.test.ts
git commit -m "feat(panel): search works under a remote, and the View picker counts items"
```

---

### Task 7:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(`SyncCenterView.ts` / `panelModel.ts` / `status.ts` 三条,新增 `core/remoteRows.ts` 一条)
- Modify: `docs/design/DESIGN.md`(Component library 的 **Remote** 条目、**Sidebar** 条目)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

- [ ] **Step 1: ARCHITECTURE.md**

新增 `core/remoteRows.ts` 一条:它把一次远端比较翻成设备关系那套 `GroupStatus`,`remoteFlowFor` 说明「未定状态一律读作 pull,因为 pull 是加性的」,`skipRefsForSelection` 说明勾选框如何落到 `skipRefs`。`SyncCenterView.ts` 那条把「the Remotes block (which renders the remote pane's diffs through the same type-section/family grammar as the main list)」整句删掉,改成:remote 关系走同一个 `renderItemMode`,没有第二套渲染器。

- [ ] **Step 2: DESIGN.md**

**Remote** 条目改成:remote 不再是一块单独的屏;`config-sync-remote-btn` 仍是动作条上的方向按钮。**Sidebar** 条目里 2a 写的那句「an item count there needs a real comparison against that remote, so it waits until remote rows exist」现在成立了,改成:跑过比较的 remote 显示项计数,没跑过的显示状态图标。

- [ ] **Step 3: CHANGELOG.md**

2.25.0 条目追加一条,产品视角:远端不再是单独一块屏,和本机那半边用同一套列表、同一张卡、同一个勾选框;可以只勾几项来拉/推,而不是每次整份。

- [ ] **Step 4: 核对**

`grep -rn "renderRemoteMode\|paintRemoteCompareResult\|renderRemoteDiffEntry" src/ docs/` 无命中。

- [ ] **Step 5: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: one renderer, two relations"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超既有基线 0 error / 57 warn)。
- `grep -rn "renderRemoteMode\|paintRemoteCompareResult\|renderRemoteOnOff\|renderRemoteDiffEntry\|renderRemoteFileRows\|renderRemoteFileDiff\|renderRemoteButtons" src/` 无命中。
- **设备关系下逐像素不变**:与 2a 的截图比对通过。
- 真机冒烟:Task 4 Step 5 的六条 + Task 5 Step 4 + Task 6 Step 4 全过。

## 交给 2c 的边界

- self 项两副面孔(spec 5.6):设备关系下钉在顶部、无勾选框的特殊行;remote 关系下是普通一行。
- 撤掉 Settings 里「Keep Config Sync's own settings out of this remote」那个开关与它的说明(spec 5.7 的删除部分),以及面板底部复述它的 `config-sync-remote-selfnote` 那一行。
- 状态栏同时报两段、单位统一为**项**(spec 5.5)。
