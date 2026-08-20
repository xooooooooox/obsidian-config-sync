# 2.25.0 · Plan 2a:关系轴与 View 选择器 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sync Center 那个把「筛哪一类项」和「看哪一段关系」压在一起的 `panelSection` 拆成两根正交的轴,并在分区列表头部立起 `View` 选择器,remote 从侧栏收进它的下拉。**面板能画的东西一样不变。**

**Architecture:** 纯状态重构 + 一个新控件。`panelSection` 四路联合拆成 `relation`(设备 / 某个 remote)与 `destination`(项分类 / History / Config Sync 自己)两个字段;两者的类型、键、标签和 `View` 下拉的内容模型都放进 `panelModel.ts`(无 DOM、可单测),`SyncCenterView` 只留一层薄渲染。remote 关系下主区**仍然调用今天的 `renderRemoteMode`** —— 换掉它是 Plan 2b 的事,本计划一行都不动那 520 行。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian API。`panelModel.ts` 保持零 DOM。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(本计划实现 5.2,并为 5.1 / 5.3 / 5.4 铺路)

## 迭代全景(2.25.0 第 2 块,拆三份,本文件是第一份)

| # | 计划 | 交付 |
|---|---|---|
| 1 | 数据模型与迁移 | **DONE**,已合入 main |
| **2a** | **关系轴与 View 选择器(本文件)** | 两轴状态、View 下拉、侧栏变纯筛选、紧凑切换器跟上。**面板内容不变** |
| 2b | 统一渲染 | remote 关系产出行、退役 remote 专用渲染器、三样孤儿功能找新家 |
| 2c | 收尾 | self 项两副面孔、撤掉 Settings 那个开关、状态栏单位统一为项 |
| 3 | 四档方向规则落地 | 传输语义、派生 lock、方向感知忽略集、「一致」重定义 |
| 4 | 加密 | 解密后比对、per-remote 密码短语(含 spec 5.7 的 `Passphrase` 行)、转码、信封复用 |

## Global Constraints

- **面板能画的东西一样不变。** 本计划结束时,每一个面板destination 画出来的内容与 2.25.0-pre 逐像素相同;变的只有「remote 从侧栏移到 View 下拉」这一处导航结构。
- **`panelModel.ts` 零 DOM、零 Obsidian 导入。** 它今天就是这样,新增的东西必须守住。
- **仓库测试策略**:vitest 只覆盖纯逻辑;DOM 由 dev vault 真机冒烟验证(`styles.css` 与渲染方法都不写单测)。新加的纯函数必须有测试,渲染改动靠冒烟。
- **UI 文案逐字取自 spec 5.2**:`This device ↔ store` / `store ↔ <remote name>`。**不得改写、不得意译。**
- **`↔` 与 `↑↓⇡⇣` 是既有 UI 字形**,照用;这条不受「新代码优先 ASCII 标点」约束(那条管的是代码与英文散文,不管已定稿的 UI 文案)。
- **搜索在 remote 关系下继续禁用**(`SyncCenterView.ts:1590`)。spec 5.8.2 要解禁,但解禁的前提是 remote 关系下真有行可筛 —— 那是 2b。本计划**故意保留禁用**,理由写进代码注释:让搜索框可打字却什么也筛不到,比禁用更糟。
- **不提交 Claude 署名**,提交信息不带任何 AI 归属尾注。
- 注释写不变量,不写变更史;不用 `§` 引章节。

---

### Task 1:关系与目的地的类型、键、标签

**Files:**
- Modify: `src/ui/panelModel.ts`(文件末尾追加一节)
- Test: `tests/panelRelation.test.ts`(新建)

**Interfaces:**
- Consumes: `StorageSection`(`src/core/types.ts`,`panelModel.ts` 已导入)
- Produces:
  - `type PanelRelation = { kind: "device" } | { kind: "remote"; name: string }`
  - `type PanelDestination = { kind: "items"; cat: StorageSection | "beta" | "all" } | { kind: "history" } | { kind: "self" }`
  - `function relationKey(r: PanelRelation): string`
  - `function relationLabel(r: PanelRelation): string`
  - `function destinationKey(d: PanelDestination): string`
  - `function foldStateKey(r: PanelRelation, d: PanelDestination, section: string, foldId: string): string`

- [ ] **Step 1: 写失败测试**

新建 `tests/panelRelation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { destinationKey, foldStateKey, PanelDestination, PanelRelation, relationKey, relationLabel } from "../src/ui/panelModel";

describe("relationLabel", () => {
  it("names the two relations exactly as the design says", () => {
    expect(relationLabel({ kind: "device" })).toBe("This device ↔ store");
    expect(relationLabel({ kind: "remote", name: "main" })).toBe("store ↔ main");
  });
});

describe("relationKey / destinationKey", () => {
  it("keeps a remote's key apart from an item category that happens to share its name", () => {
    // "beta" is a real item category AND a plausible remote name — the two must never collide
    expect(relationKey({ kind: "remote", name: "beta" })).not.toBe(destinationKey({ kind: "items", cat: "beta" }));
  });

  it("is stable per value", () => {
    expect(relationKey({ kind: "device" })).toBe(relationKey({ kind: "device" }));
    expect(relationKey({ kind: "remote", name: "a" })).toBe(relationKey({ kind: "remote", name: "a" }));
    expect(relationKey({ kind: "remote", name: "a" })).not.toBe(relationKey({ kind: "remote", name: "b" }));
    expect(destinationKey({ kind: "history" })).not.toBe(destinationKey({ kind: "self" }));
  });
});

describe("foldStateKey", () => {
  it("separates the same fold under two different relations", () => {
    const d: PanelDestination = { kind: "items", cat: "all" };
    const device: PanelRelation = { kind: "device" };
    const remote: PanelRelation = { kind: "remote", name: "main" };
    expect(foldStateKey(device, d, "plugins", "outdated")).not.toBe(foldStateKey(remote, d, "plugins", "outdated"));
  });

  it("separates two folds under the same relation and destination", () => {
    const r: PanelRelation = { kind: "device" };
    const d: PanelDestination = { kind: "items", cat: "all" };
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "plugins", "disabled"));
    expect(foldStateKey(r, d, "plugins", "outdated")).not.toBe(foldStateKey(r, d, "obsidian", "outdated"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/panelRelation.test.ts`
Expected: FAIL —— 四个符号都没导出,TypeScript 报错。

- [ ] **Step 3: 写实现**

追加到 `src/ui/panelModel.ts` 末尾:

```ts
// The panel answers two independent questions, and for a long time one field answered both: which
// RELATION is on screen (this device against the store, or the store against one remote) and which
// DESTINATION of the sidebar is selected (a slice of items, the run log, Config Sync's own entry).
// Selecting a remote used to silently change what the item categories meant, which is why they are
// two fields now.
export type PanelRelation = { kind: "device" } | { kind: "remote"; name: string };

export type PanelDestination =
  | { kind: "items"; cat: StorageSection | "beta" | "all" }
  | { kind: "history" }
  | { kind: "self" };

// Prefixed rather than bare: a remote may legitimately be named "beta" or "history", and an
// unprefixed key would collide with the destination of the same spelling.
export function relationKey(r: PanelRelation): string {
  return r.kind === "device" ? "device" : `remote:${r.name}`;
}

export function relationLabel(r: PanelRelation): string {
  return r.kind === "device" ? "This device ↔ store" : `store ↔ ${r.name}`;
}

export function destinationKey(d: PanelDestination): string {
  return d.kind === "items" ? `items:${d.cat}` : d.kind;
}

// Fold state is per relation AND per destination: the same section under two relations is two
// different lists, and a fold opened in one must not read as opened in the other.
export function foldStateKey(r: PanelRelation, d: PanelDestination, section: string, foldId: string): string {
  return `${relationKey(r)}::${destinationKey(d)}::${section}::${foldId}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/panelRelation.test.ts`
Expected: PASS(5 条)

- [ ] **Step 5: 提交**

```bash
git add src/ui/panelModel.ts tests/panelRelation.test.ts
git commit -m "feat(panel): relation and destination are two questions, not one field"
```

---

### Task 2:`View` 下拉的内容模型

**Files:**
- Modify: `src/ui/panelModel.ts`(接着 Task 1 那一节写)
- Test: `tests/panelRelation.test.ts`(续写)

**Interfaces:**
- Consumes: Task 1 的 `PanelRelation` / `relationLabel` / `relationKey`;`RemoteState`(`src/core/status.ts`,`panelModel.ts` 已导入 `BucketCounts` 等,追加即可)
- Produces:
  - `type ViewBadge = { kind: "capture" | "apply"; count: number } | { kind: "remote-state"; state: RemoteState }`
  - `interface ViewOption { relation: PanelRelation; label: string; active: boolean; badges: ViewBadge[] }`
  - `function viewOptions(input: { current: PanelRelation; deviceCounts: { up: number; down: number }; remotes: readonly { name: string; state: RemoteState }[] }): ViewOption[]`

**为什么 remote 那一行现在挂的是状态图标而不是项数:** spec 5.2 画的是 `store ↔ main` ⇣4 ⇡2,那是**项**计数,而项计数要跑一次真正的比较才有。本计划不新增任何比较,所以 remote 行沿用今天侧栏那个便宜的整库状态图标(只读 lock 文件);项计数等 2b 有了 remote 行之后再换上。这一条要写进 `viewOptions` 的注释,否则下一个读者会以为它漏了。

- [ ] **Step 1: 写失败测试**

追加到 `tests/panelRelation.test.ts`:

```ts
import { viewOptions } from "../src/ui/panelModel";

describe("viewOptions", () => {
  const remotes = [
    { name: "main", state: "remote-newer" as const },
    { name: "work", state: "same" as const },
  ];

  it("puts this device first, then the remotes in the order settings gave them", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.label)).toEqual(["This device ↔ store", "store ↔ main", "store ↔ work"]);
  });

  it("marks exactly one option active, by value not by identity", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "work" }, deviceCounts: { up: 3, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([false, false, true]);
  });

  it("falls back to this device when the current remote is gone", () => {
    const opts = viewOptions({ current: { kind: "remote", name: "deleted" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts.map((o) => o.active)).toEqual([true, false, false]);
  });

  it("gives this device its capture/apply counts and drops the zeroes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 11, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([{ kind: "capture", count: 11 }]);
  });

  it("gives this device no badges at all when nothing is waiting", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes: [] });
    expect(opts[0]?.badges).toEqual([]);
  });

  it("gives each remote its whole-store state, always — including the ones with nothing to do", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 0, down: 0 }, remotes });
    expect(opts[1]?.badges).toEqual([{ kind: "remote-state", state: "remote-newer" }]);
    expect(opts[2]?.badges).toEqual([{ kind: "remote-state", state: "same" }]);
  });

  it("offers this device alone when there are no remotes", () => {
    const opts = viewOptions({ current: { kind: "device" }, deviceCounts: { up: 1, down: 2 }, remotes: [] });
    expect(opts).toHaveLength(1);
    expect(opts[0]?.badges).toEqual([
      { kind: "capture", count: 1 },
      { kind: "apply", count: 2 },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/panelRelation.test.ts -t viewOptions`
Expected: FAIL —— `viewOptions` 未导出。

- [ ] **Step 3: 写实现**

`panelModel.ts` 顶部的 `core/status` 那一行 import 追加 `RemoteState`:

```ts
import { BucketCounts, GroupState, GroupStatus, OTHER_STORE_FILES_GROUP, RemoteDiffEntry, RemoteState } from "../core/status";
```

接着 Task 1 那一节写:

```ts
// A remote's badge is its WHOLE-STORE state (the cheap lock-file answer the sidebar already draws),
// not a count of items: an item count needs a real comparison against that remote, and this list is
// built on every render. The device side counts items because those numbers are already in hand.
export type ViewBadge = { kind: "capture" | "apply"; count: number } | { kind: "remote-state"; state: RemoteState };

export interface ViewOption {
  relation: PanelRelation;
  label: string;
  active: boolean;
  badges: ViewBadge[];
}

// The whole content of the View picker, as data. A `current` naming a remote that settings no
// longer has resolves to this device rather than to nothing — the picker always has exactly one
// active row, and a deleted remote is not a state the user can be left stranded in.
export function viewOptions(input: {
  current: PanelRelation;
  deviceCounts: { up: number; down: number };
  remotes: readonly { name: string; state: RemoteState }[];
}): ViewOption[] {
  const { current, deviceCounts, remotes } = input;
  // Read out to a local BEFORE the callback below: TypeScript does not carry a narrowing of
  // `input.current.kind` into a closure, so `input.current.name` there would not compile.
  const currentName = current.kind === "remote" ? current.name : null;
  const liveName = currentName !== null && remotes.some((r) => r.name === currentName) ? currentName : null;
  const deviceBadges: ViewBadge[] = [];
  if (deviceCounts.up > 0) deviceBadges.push({ kind: "capture", count: deviceCounts.up });
  if (deviceCounts.down > 0) deviceBadges.push({ kind: "apply", count: deviceCounts.down });
  const device: PanelRelation = { kind: "device" };
  const out: ViewOption[] = [
    { relation: device, label: relationLabel(device), active: liveName === null, badges: deviceBadges },
  ];
  for (const r of remotes) {
    const relation: PanelRelation = { kind: "remote", name: r.name };
    out.push({
      relation,
      label: relationLabel(relation),
      active: liveName === r.name,
      badges: [{ kind: "remote-state", state: r.state }],
    });
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/panelRelation.test.ts`
Expected: PASS(全部 12 条)

- [ ] **Step 5: 提交**

```bash
git add src/ui/panelModel.ts tests/panelRelation.test.ts
git commit -m "feat(panel): the View picker's contents as data"
```

---

### Task 3:`panelSection` 拆成两根轴(行为逐像素不变)

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(下表 20 处)

**Interfaces:**
- Consumes: Task 1 的 `PanelRelation` / `PanelDestination` / `foldStateKey`
- Produces: 视图上两个私有字段 `relation` / `destination`;`panelSection` 与 `sectionKey()` 消失

**这一步没有新测试**,它是等价改写:守卫是 `npx tsc --noEmit`(联合类型换掉之后每一处漏改都会报错)、既有全套 vitest,以及 Step 4 的真机冒烟。**不要顺手改任何行为**;唯一允许的行为差异是折叠状态的键变了(会话内状态,升级后折叠一次性复位,无害)。

- [ ] **Step 1: 换字段声明**

`:494` 整行替换:

```ts
  // Two orthogonal axes — see panelModel's PanelRelation/PanelDestination. `relation` is what the
  // View picker sets; `destination` is what the sidebar sets.
  private relation: PanelRelation = { kind: "device" };
  private destination: PanelDestination = { kind: "items", cat: "all" };
```

`:35-87` 那个多行的 `} from "./panelModel";` import 块追加七个名字:`foldStateKey`、`PanelDestination`、`PanelRelation`、`relationLabel`、`viewOptions`、`ViewBadge`、`ViewOption`(后五个 Task 4 才用,一次加齐,免得两次动同一块)。

- [ ] **Step 2: 逐处改写**

| 行 | 今天 | 改成 |
|---|---|---|
| `:705` | `this.panelSection = { kind: "self" }` | `this.destination = { kind: "self" }` |
| `:1275` | `this.panelSection.kind === "self"` | `this.destination.kind === "self"` |
| `:1279` | `this.panelSection.kind === "history"` | `this.destination.kind === "history"` |
| `:1283-1290` | remote 分支 | 见 Step 3 |
| `:1298` | `const active = this.panelSection.kind === "self"` | `const active = this.destination.kind === "self"` |
| `:1313` | `this.panelSection = { kind: "self" }` | `this.destination = { kind: "self" }` |
| `:1427` | `this.panelSection = { kind: "remote", name }` | `this.relation = { kind: "remote", name };`<br>`this.destination = { kind: "items", cat: "all" };` —— 这一处是 self 面板里的 `Open <name>` 按钮,不把 destination 挪开的话 self 面板会盖住刚选中的 remote |
| `:1450` `:1470` | `this.panelSection = { kind: "device", cat: "all" }` | `this.destination = { kind: "items", cat: "all" }` |
| `:1590` | `if (this.panelSection.kind === "remote") searchEl.disabled = true;` | `if (this.relation.kind === "remote") searchEl.disabled = true;` —— **保留禁用**,并把 Global Constraints 里那条理由写成行上注释 |
| `:1627` | `this.panelSection.kind === "device" && this.panelSection.cat === cat` | `this.destination.kind === "items" && this.destination.cat === cat` |
| `:1651` | `this.panelSection = { kind: "device", cat }` | `this.destination = { kind: "items", cat }` |
| `:1664-1685` | 侧栏的 remote 区块 | **整块删除**(含它上面那条 `config-sync-side-divider`)—— remote 去了 View 下拉 |
| `:1689` `:1696` | history 的 active / 点击 | `this.destination.kind === "history"` / `this.destination = { kind: "history" }` |
| `:1707-1725` | `renderSwitcher` 的四路分支 | 见 Step 3 |
| `:1752` | `this.panelSection = { kind: "self" }` | `this.destination = { kind: "self" }` |
| `:1924` | `this.panelSection = { kind: "history" }` | `this.destination = { kind: "history" }` |
| `:2081-2086` | `sectionKey()` 整个方法 | **删除**,调用点改用 `foldStateKey` |
| `:2133-2135` | `if (this.panelSection.kind !== "device" \|\| this.panelSection.cat === "all") return this.rows();`<br>`const cat = this.panelSection.cat;` | `if (this.destination.kind !== "items" \|\| this.destination.cat === "all") return this.rows();`<br>`const cat = this.destination.cat;` |
| `:2160` | `this.panelSection = { kind: "self" }` | `this.destination = { kind: "self" }` |
| `:2533` | `` const key = `${this.sectionKey()}::${ts}::${opts.foldId}`; `` | `const key = foldStateKey(this.relation, this.destination, ts, opts.foldId);` |
| `:3987` `:4001` `:4025` | `this.panelSection.kind !== "remote" \|\| this.panelSection.name !== remote.name` | `this.relation.kind !== "remote" \|\| this.relation.name !== remote.name` |

- [ ] **Step 3: 改两处分支**

`renderMainRegionBody`(`:1274-1292`)整段替换。**顺序是设计的一部分**:self 与 History 与关系无关,任何关系下都照常打开;只有落到项列表时才分设备 / remote。

```ts
  private renderMainRegionBody(main: HTMLElement): void {
    // self and History answer the same thing under either relation, so they are checked first and
    // the relation never reaches them.
    if (this.destination.kind === "self") {
      this.renderConfigSyncMode(main);
      return;
    }
    if (this.destination.kind === "history") {
      this.renderHistoryMode(main);
      return;
    }
    if (this.relation.kind === "remote") {
      const name = this.relation.name;
      const remote = this.host.remotes().find((x) => x.name === name);
      if (remote !== undefined) {
        this.renderRemoteMode(main, remote);
        return;
      }
      this.relation = { kind: "device" }; // remote vanished (settings change) — fall back
    }
    this.renderItemMode(main);
  }
```

`renderSwitcher`(`:1707-1725`)的分支现在按 destination 走,remote 的名字不再出现在这里(它去了 View 选择器,而紧凑模式下 View 选择器就画在切换器菜单的头部,见 Task 4):

```ts
    if (this.destination.kind === "items") {
      const cat = this.destination.cat;
      sw.createSpan({ text: cat === "all" ? "All items" : ITEM_SECTION_LABELS[cat] });
      const c = this.presentedCounts(this.countable(this.sectionRows()));
      if (c.up > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-up" }), "capture", c.up);
      if (c.down > 0) renderActionCount(sw.createSpan({ cls: "config-sync-side-badge is-down" }), "apply", c.down);
      if (c.ok > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-ok" }), FATE_PILL_FOLD.ok, c.ok);
      if (c.excluded > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-excluded" }), FATE_PILL_FOLD.excluded, c.excluded);
      if (c.none > 0) renderFoldCount(sw.createSpan({ cls: "config-sync-side-badge is-none" }), FATE_PILL_FOLD.none, c.none);
    } else if (this.destination.kind === "history") {
      sw.createSpan({ text: "History" });
    } else {
      setIcon(sw.createSpan({ cls: "config-sync-switcher-selfic" }), "settings-2");
      sw.createSpan({ text: "Config Sync" });
    }
```

- [ ] **Step 4: 全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 类型干净;测试全绿;lint 不超既有基线(0 error / 57 warn)。

真机冒烟(dev vault):`npm run smoke:install`,`cd dev/vault && obsidian-cli reload`,然后依次点开 All items / 每个分类 / History / Config Sync,确认与升级前一致;`obsidian-cli dev:errors` 无捕获。**此时侧栏里已经没有 remote 了,而 View 选择器还没做 —— remote 关系暂时进不去,这是本任务与 Task 4 之间的已知空档**,Task 4 补上。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SyncCenterView.ts
git commit -m "refactor(panel): split the panel's relation axis from its destination axis"
```

---

### Task 4:`View` 选择器

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`renderSectionEntries` 头部、`sidebarRowNeeds`)
- Modify: `styles.css`(新增一节)

**Interfaces:**
- Consumes: Task 2 的 `viewOptions` / `ViewOption` / `ViewBadge`;既有的 `renderActionCount`(`./actionIcons`)、`this.remoteIcon` / `this.paintStateIcon`
- Produces: 无新导出

- [ ] **Step 1: 画选择器**

在 `renderSectionEntries`(`:1618`)最开头、`this.renderSelfEntry(container)` **之前**插入,并新增一个 `viewPickerOpen` 字段(挨着 `:504` 的 `compact` 声明):

```ts
  private viewPickerOpen = false;
```

```ts
  // The head of the section list, above everything: it answers "which relation am I looking at",
  // and every entry below it answers "which items". Each remote carries its state icon here, so
  // "which remote needs attention" is readable without switching to it first.
  private renderViewPicker(container: HTMLElement): void {
    const opts = viewOptions({
      current: this.relation,
      deviceCounts: this.presentedCounts(this.countable(this.rows())),
      remotes: this.host.remotes().map((r) => ({ name: r.name, state: this.host.remoteCheck(r.name)?.check.state ?? "unknown" })),
    });
    const current = opts.find((o) => o.active) ?? opts[0];
    if (current === undefined) return;
    const box = container.createDiv({ cls: "config-sync-view-picker" });
    const head = box.createDiv({ cls: `config-sync-view-current${this.viewPickerOpen ? " is-open" : ""}` });
    head.createSpan({ cls: "config-sync-view-label", text: current.label });
    setIcon(head.createSpan({ cls: "config-sync-view-chev" }), "chevrons-up-down");
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      this.viewPickerOpen = !this.viewPickerOpen;
      this.render(this.renderGen);
    });
    if (!this.viewPickerOpen) return;
    const menu = box.createDiv({ cls: "config-sync-view-menu" });
    for (const opt of opts) {
      const row = menu.createDiv({ cls: `config-sync-view-opt${opt.active ? " is-active" : ""}` });
      row.createSpan({ cls: "config-sync-view-label", text: opt.label });
      for (const b of opt.badges) this.renderViewBadge(row, b);
      row.addEventListener("click", () => {
        this.relation = opt.relation;
        this.viewPickerOpen = false;
        this.switcherOpen = false;
        // A relation change never moves the destination: the sidebar's answer is still the user's.
        this.render(this.renderGen);
      });
    }
  }

  private renderViewBadge(row: HTMLElement, b: ViewBadge): void {
    if (b.kind === "remote-state") {
      const icon = this.remoteIcon({ state: b.state, remoteCapturedAt: null });
      this.paintStateIcon(row.createSpan({ cls: `config-sync-state-icon ${icon.cls}`, attr: { "aria-label": icon.tip } }), icon);
      return;
    }
    const cls = b.kind === "capture" ? "is-up" : "is-down";
    renderActionCount(row.createSpan({ cls: `config-sync-side-badge ${cls}` }), b.kind, b.count);
  }
```

`renderSectionEntries` 的第一行改成:

```ts
    this.renderViewPicker(container);
    container.createDiv({ cls: "config-sync-side-divider" });
    this.renderSelfEntry(container);
```

`renderSwitcher`(`:1732-1735`)展开菜单时调 `renderSectionEntries`,所以紧凑模式**自动**拿到同一个选择器,不另立一套 —— 这正是 spec 5.2 最后一句要的。

- [ ] **Step 2: 宽度需求跟上**

`sidebarRowNeeds`(`:618-637`):删掉 `for (const remote of this.host.remotes()) needs.push({ name: remote.name, badges: 1 });` 那一行,改成把 View 选择器**当前那一行**算进去(它和分区行同在一列里,是新的最宽候选):

```ts
    const needs: SidebarRowNeed[] = [{ name: relationLabel(this.relation), badges: 1 }, { name: "All items", badges: badgesFor(countable) }];
```

并把 `:613-617` 那段注释里讲 remote 行的两句换成:讲 View 选择器那一行 —— 它画一个折叠箭头(按一个徽章预留),名字是关系标签,可能比任何分区名都长。

- [ ] **Step 3: CSS**

追加到 `styles.css`(挨着 `:997` 那组 `.config-sync-switcher` 规则之后,同一段风格):

```css
/* View picker: the head of the section list. Same box as .config-sync-switcher so the sidebar and
   the compact switcher read as one control in two places. */
.config-sync-view-picker { display: flex; flex-direction: column; gap: 4px; }
.config-sync-view-current { display: flex; align-items: center; gap: 5px; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--background-modifier-border); background: var(--background-secondary); cursor: pointer; font-size: var(--font-ui-small); }
.config-sync-view-current.is-open { border-color: rgba(var(--interactive-accent-rgb), 0.4); }
.config-sync-view-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-sync-view-chev { display: inline-flex; align-items: center; margin-left: auto; color: var(--text-faint); }
.config-sync-view-chev svg { width: 13px; height: 13px; }
.config-sync-view-menu { display: flex; flex-direction: column; gap: 3px; padding: 4px; border: 1px solid var(--background-modifier-border); border-radius: 8px; background: var(--background-primary); }
.config-sync-view-opt { display: flex; align-items: center; gap: 5px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: var(--font-ui-small); }
.config-sync-view-opt:hover { background: var(--background-modifier-hover); }
.config-sync-view-opt.is-active { background: rgba(var(--interactive-accent-rgb), 0.14); }
```

- [ ] **Step 4: 全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 三绿,lint 不超基线。

真机冒烟(dev vault,**先在设置里加两个 remote**,`/tmp/smoke-store` 之类即可):

1. 侧栏头部出现 `This device ↔ store`,点开列出三行:设备 + 两个 remote,各带徽章;选中的那行高亮。
2. 选一个 remote → 主区画出今天的 remote 面板;侧栏里**没有** remote 条目了;分区选择保持不动。
3. 切回 `This device ↔ store` → 回到项列表,分区选择仍是刚才那个。
4. 在 remote 关系下点 History / Config Sync → 照常打开(关系不拦它们)。
5. 把窗口拖窄进紧凑模式 → 切换器菜单里同样有这个选择器,行为一致。
6. 在设置里删掉当前选中的那个 remote → 面板回落到设备关系,不空白、不报错。
7. `obsidian-cli dev:errors` 无捕获。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(panel): a View picker heads the section list, remotes move into it"
```

---

### Task 5:文档追平

**Files:**
- Modify: `docs/design/DESIGN.md`(Sync Center 侧栏那一节)
- Modify: `docs/ARCHITECTURE.md`(`ui/SyncCenterView.ts` 与 `ui/panelModel.ts` 两条)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

**Interfaces:**
- Consumes: 前四个 Task 的最终形状
- Produces: 无代码接口

- [ ] **Step 1: 改 DESIGN.md**

改 Component library 里的 **Sidebar** 那一条(`docs/design/DESIGN.md:515-549`)。它今天写着分隔线的分组是「self card / scope list / **remote rows** / History」,而 remote 行已经不在侧栏了 —— 把那句改成「self card / scope list / History」,并在它前面补两句:

- 侧栏此后只回答「筛哪一类项」;「看哪一段关系」由分区列表头部的 `View` 选择器(`config-sync-view-picker/-view-current/-view-menu/-view-opt/-view-label/-view-chev`)回答,remote 收在它的下拉里,每一项自带徽章 —— 设备侧是项计数,remote 侧是那个整库状态图标(项计数要跑一次真正的比较,不在这一步)。
- 紧凑切换器展开时画的就是同一份分区列表,所以这个选择器**自动**在窄面板与手机上出现,不另立一套。

同一条里那句「each remote row's own state icon carries the result」照旧成立,只是那个图标现在画在 View 下拉里 —— 顺手把「row」改成「entry」。

- [ ] **Step 2: 改 ARCHITECTURE.md**

`ui/panelModel.ts` 那一条补上:`PanelRelation` / `PanelDestination` 两根正交轴、`relationKey`/`destinationKey`/`foldStateKey`、`viewOptions` 是 View 下拉的纯数据模型。`ui/SyncCenterView.ts` 那一条把 `panelSection` 的说法换成两个字段,并写明 `renderMainRegionBody` 的判定顺序(self / History 先答,关系不拦它们)。

- [ ] **Step 3: 改 CHANGELOG.md**

在既有 2.25.0 条目下追加一条,产品视角、不泄漏实现词:侧栏顶部多了一个视图选择器,远端从侧栏列表移进去,每个远端在下拉里就能看到状态;侧栏本身此后只管筛选。

- [ ] **Step 4: 核对**

人工核对:`grep -rn "panelSection" src/` 无命中。

- [ ] **Step 5: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: the panel's two axes and the View picker"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超既有基线 0 error / 57 warn)。
- `grep -rn "panelSection" src/` 无命中。
- 真机冒烟:Task 4 Step 4 的七条全过。
- **面板内容零变化**:设备关系下的项列表、卡片、折叠、筛选药丸、头部药丸、状态栏与 2.25.0-pre 完全一致;remote 关系下画的仍是今天那套 remote 面板。

## 交给 2b 的边界

本计划**故意不做**、由 Plan 2b 接手的东西,列在这里免得两边抢:

- remote 关系产出行(`GroupStatus` 形状的 remote 侧状态)、关系查表的词表、可用性轴在 remote 关系下撤掉。
- 退役 `renderRemoteMode` 及其 6 个 helper(`SyncCenterView.ts:3901-4419`)。
- View 下拉里 remote 那一行从整库状态图标换成**项**计数(spec 5.2 画的形态)。
- 搜索与筛选药丸在 remote 关系下解禁(spec 5.8.2)。
- remote 专用渲染器独有的三样东西找新家(行内文件级 diff、插件开关逐个翻转清单、「有 N 个文件只有你这边有」)。

2c 接手:self 项两副面孔(spec 5.6)、撤掉 Settings 里那个开关(spec 5.7 的删除部分)、状态栏单位统一为项(spec 5.5)。
