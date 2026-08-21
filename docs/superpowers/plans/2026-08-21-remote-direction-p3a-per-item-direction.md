# 2.25.0 · Plan 3a:逐项方向与「一致」重定义 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每一行自己回答「这一项和这个 remote 之间还有什么要做」—— 由两边记账文件的逐项新鲜度与该项的四档规则相交得出 —— 并据此重新定义「一致」:**一致 = 在允许流动的方向上没有待办**,不再是「两边字节相同」。

**Architecture:** 事实来源从「整库一个方向」换成「每项一个判定」。`checkRemote` 早就逐项走过两边 lock 的 `itemFreshness`(2c 的项计数就是这么来的),本轮把那趟走查的**逐项结论**留下来:`RemoteCheck.itemVerdicts` —— ref → `"pull" | "push"`,不在表里即「没有待办」。判定按方向相交:远端更新且这一项允许拉才是 `pull`,本地更新且允许推才是 `push`,`Neither way` 两边都不是。面板的行状态改读这张表;`diffRemote` 的文件差异**退居证据**,只喂卡片的 `Files`,不再决定行的状态。`remoteFlowFor`(2b 那个「整库一个方向」的权宜)随之退役。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian API。`core/status.ts` / `core/remoteRules.ts` 保持零 DOM 可单测。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 3.3 的 item 级部分、3.5,以及 5.4 里 `Push only 且远端更新` 那一格)

## Plan 3 为什么拆成三份

spec 第 3 节是七块彼此独立的语义改动,合成一份计划会大到没法审。拆法与 Plan 2 同理,每一份自己就是能跑、能验的软件:

| # | 计划 | 内容 |
|---|---|---|
| **3a** | **逐项方向与「一致」重定义(本文件)** | 方向感知的忽略集(3.5)、逐项判定、行状态改读它、`Push only` 且远端更新的呈现(5.4)、`lockDiffers` 归位 |
| 3b | 逐键扣留 | pull/push 的合并语义(3.1/3.2)、派生 lock(3.4.4/3.6)、pull 后的记账与指纹快路(3.4.2/3.4.3) |
| 3c | 并发与新鲜度 | vault 类型的写前复核、过期判断中止(3.7) |

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c | 数据模型、关系轴、统一渲染、收尾 | **DONE**,均已合入 main |
| **3a** | **本文件** | 逐项方向与「一致」重定义 |
| 3b / 3c | 逐键扣留 / 并发 | 计划未写 |
| 4 | 加密 | 未开始 |

## Global Constraints

- **设备关系下一个像素都不许变。** 与 2b/2c 同一条:本轮只动 remote 关系下的行状态与卡片文案。
- **一致 = 在允许流动的方向上没有待办**(spec 3.3)。一个 `Push only` 的项,对面自己改了内容,两边字节不同 —— 那不是待办,归进「一致」折起来,无勾选框。**已知代价照 spec 接受**:对面确实变了而这一行不告诉你(卡片里仍答,见 Task 4)。
- **一个忽略集不够**(spec 3.5)。「远端有没有东西值得拉」忽略所有不参与拉的项;「我有没有东西该推」忽略所有不参与推的项。沿用一个集合会让 `Push only` 的项因对面更新而永久点亮一个任何 Pull 都清不掉的箭头。
- **行的状态来自 lock,文件差异只做证据。** `diffRemote` 回答的是「哪些文件字节不同」,那是卡片 `Files` 的内容;行说的是「还有什么要做」,那是逐项判定。两者从此分工明确。
- **文案取自 spec,即终稿。** `Push only` 且远端更新时的 State 句:`<remote> changed N files. Push only, so they stay there.`
- **写 `Remote.items` 只有一条路**:`withItemDirection`。读只有一条路:`itemDirection` / `keyDirection`(`core/remoteRules.ts`)。

---

### Task 1:忽略集按方向分开

**Files:**
- Modify: `src/core/status.ts`(`checkRemote`、`perItemRemoteState`、`remoteItemCounts` 的 `ignoreRefs` 参数)
- Modify: `src/main.ts`(`checkRemote` 的调用点,约 `:534`)
- Test: `tests/status.test.ts`(续写)

**Interfaces:**
- Consumes: `refsBlockedFor(items, "pull" | "push")`(`core/remoteRules.ts`,Plan 1 已有)
- Produces:
  - `interface DirectionIgnores { pull: ItemRef[]; push: ItemRef[] }`
  - `checkRemote(localLock, reader, ignore: DirectionIgnores, groups?)`
  - `perItemRemoteState(local, remote, ignore: DirectionIgnores)`(私有,签名跟着变)
  - `remoteItemCounts(local, remote, ignore: DirectionIgnores)`

**为什么必须两个集合:** 今天两个问题共用一个集合。一个 `Push only` 的项,对面更新了 —— 拉方向该忽略它(那个方向不流动),推方向不该忽略(我这边真有东西要送)。共用一个集合,不管取哪一边都会错一头:取 pull 集会让「该推」漏报,取 push 集会让「值得拉」永久点亮一个 Pull 清不掉的箭头。

- [ ] **Step 1: 写失败测试**

追加到 `tests/status.test.ts`:

```ts
describe("remoteItemCounts · direction-aware ignores", () => {
  const t0 = "2026-08-01T00:00:00.000Z";
  const t1 = "2026-08-02T00:00:00.000Z";
  const none = { pull: [], push: [] };

  it("does not count a pull for an item this remote never pulls", () => {
    // The remote is ahead on dataview, but the rule says push only — nothing to pull.
    const local = lockByName(t0, { "plugin-dataview": { hash: "a", capturedAt: t0 } });
    const remote = lockByName(t1, { "plugin-dataview": { hash: "b", capturedAt: t1 } });
    expect(remoteItemCounts(local, remote, { pull: ["community/dataview"], push: [] })).toEqual({ push: 0, pull: 0 });
  });

  it("still counts the push for that same item when this side is the one ahead", () => {
    const local = lockByName(t1, { "plugin-dataview": { hash: "a", capturedAt: t1 } });
    const remote = lockByName(t0, { "plugin-dataview": { hash: "b", capturedAt: t0 } });
    expect(remoteItemCounts(local, remote, { pull: ["community/dataview"], push: [] })).toEqual({ push: 1, pull: 0 });
  });

  it("counts neither direction for an item the remote exchanges neither way", () => {
    const local = lockByName(t1, { "plugin-dataview": { hash: "a", capturedAt: t1 } });
    const remote = lockByName(t0, { "plugin-dataview": { hash: "b", capturedAt: t0 } });
    const both = { pull: ["community/dataview"], push: ["community/dataview"] };
    expect(remoteItemCounts(local, remote, both)).toEqual({ push: 0, pull: 0 });
  });

  it("counts both directions when nothing is withheld", () => {
    const local = lockByName(t1, { app: { hash: "a", capturedAt: t1 }, hotkeys: { hash: "h", capturedAt: t0 } });
    const remote = lockByName(t1, { app: { hash: "a2", capturedAt: t0 }, hotkeys: { hash: "h2", capturedAt: t1 } });
    expect(remoteItemCounts(local, remote, none)).toEqual({ push: 1, pull: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/status.test.ts -t "direction-aware ignores"`
Expected: FAIL —— 第三个参数还是 `string[]`,类型不符;行为也还没有按方向分。

- [ ] **Step 3: 写实现**

`src/core/status.ts`:

```ts
// The two questions a remote check answers need two ignore sets, not one (spec 3.5). "Is there
// anything worth pulling" must ignore every item that does not pull; "is there anything of mine to
// push" must ignore every item that does not push. Sharing one set gets one of the two wrong: a
// `Push only` item the remote edited would light an arrow no Pull could ever clear — the exact bug
// the original ignoreRefs comment set out to prevent.
export interface DirectionIgnores {
  pull: ItemRef[]; // refs that never flow remote → here
  push: ItemRef[]; // refs that never flow here → remote
}
```

`remoteItemCounts` 的循环按方向过滤:

```ts
export function remoteItemCounts(local: StoreLock | null, remote: StoreLock, ignore: DirectionIgnores): RemoteItemCounts | null {
  if (!hasPerItemPayload(remote)) return null;
  if (local !== null && !hasPerItemPayload(local)) return null;
  const refs = [...new Set([...(local === null ? [] : lockEntryList(local.items)), ...lockEntryList(remote.items)].map(([ref]) => ref))];
  let push = 0;
  let pull = 0;
  for (const ref of refs) {
    const freshness = itemFreshness(local === null ? undefined : lockEntry(local, ref), lockEntry(remote, ref));
    if (freshness === "newer" && !ignore.pull.includes(ref)) pull++;
    else if (freshness === "older" && !ignore.push.includes(ref)) push++;
  }
  return { push, pull };
}
```

`perItemRemoteState` 同样按方向过滤 —— 它决定整库状态图标,一个不参与拉的项不能把状态推成 `remote-newer`:

```ts
function perItemRemoteState(local: StoreLock, remote: StoreLock, ignore: DirectionIgnores): RemoteState | null {
  if (!hasPerItemPayload(local) || !hasPerItemPayload(remote)) return null;
  const refs = [...new Set([...lockEntryList(local.items), ...lockEntryList(remote.items)].map(([ref]) => ref))];
  if (refs.length === 0) return null;
  let newer = false;
  let older = false;
  for (const ref of refs) {
    const freshness = itemFreshness(lockEntry(local, ref), lockEntry(remote, ref));
    if (freshness === "undatable") return null;
    if (freshness === "newer" && !ignore.pull.includes(ref)) newer = true;
    else if (freshness === "older" && !ignore.push.includes(ref)) older = true;
  }
  if (newer && older) return null;
  return newer ? "remote-newer" : older ? "remote-older" : "same";
}
```

`checkRemote` 的签名从 `ignoreRefs: string[]` 换成 `ignore: DirectionIgnores`,内部两处调用照传。

`src/main.ts` 的调用点:

```ts
        const ignore = { pull: refsBlockedFor(remote.items, "pull"), push: refsBlockedFor(remote.items, "push") };
        this.remoteChecks.set(remote.name, { check: await checkRemote(localLock, reader, ignore, this.compiledGroups), at: Date.now() });
```

`remoteLockAhead` **不动**:它只回答「值得拉吗」,拿 pull 集是对的(`main.ts:915` 那一处保持原样)。

- [ ] **Step 4: 跑全套**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 三绿。类型改动会把每个手写 `ignoreRefs` 的调用点标出来,逐个改成两集合形式。

- [ ] **Step 5: 提交**

```bash
git add src/core/status.ts src/main.ts tests/status.test.ts
git commit -m "fix(core): the two questions a remote check answers get their own ignore sets"
```

---

### Task 2:逐项判定 —— 一次走查,一张表

**Files:**
- Modify: `src/core/status.ts`(`RemoteCheck` 增加 `itemVerdicts`;`remoteItemCounts` 改为读它)
- Test: `tests/status.test.ts`(续写)

**Interfaces:**
- Consumes: Task 1 的 `DirectionIgnores`
- Produces:
  - `type ItemVerdict = "pull" | "push"`
  - `function remoteItemVerdicts(local: StoreLock | null, remote: StoreLock, ignore: DirectionIgnores): Record<string, ItemVerdict> | null`
  - `RemoteCheck` 增加 `itemVerdicts: Record<string, ItemVerdict> | null`
  - `remoteItemCounts(verdicts: Record<string, ItemVerdict> | null): RemoteItemCounts | null`(**改签名**:从数 lock 变成数这张表)

**一张表,两个消费者。** 面板要「这一项还有什么要做」,状态栏要「一共几项」。让计数从判定表里数,而不是各走各的一趟 lock —— 否则两处会在边界情形上分歧,而这正是这个仓库反复修过的那类 bug。

**不在表里 = 没有待办。** 三种情况合并成同一个答案:两边一样、这一项那个方向不流动、这一项只有一边有但那个方向不流动。行读到「不在表里」就是 `in-sync`,这就是 spec 3.3 的「一致」重定义在数据层的落点。

- [ ] **Step 1: 写失败测试**

追加到 `tests/status.test.ts`:

```ts
describe("remoteItemVerdicts", () => {
  const t0 = "2026-08-01T00:00:00.000Z";
  const t1 = "2026-08-02T00:00:00.000Z";
  const none = { pull: [], push: [] };

  it("names the direction each unsettled item still needs", () => {
    const local = lockByName(t1, { app: { hash: "a", capturedAt: t1 }, hotkeys: { hash: "h", capturedAt: t0 } });
    const remote = lockByName(t1, { app: { hash: "a2", capturedAt: t0 }, hotkeys: { hash: "h2", capturedAt: t1 } });
    expect(remoteItemVerdicts(local, remote, none)).toEqual({ "obsidian/app": "push", "obsidian/hotkeys": "pull" });
  });

  it("leaves a settled item out of the table entirely", () => {
    const same = { app: { hash: "a", capturedAt: t0 } };
    expect(remoteItemVerdicts(lockByName(t0, same), lockByName(t1, same), none)).toEqual({});
  });

  it("leaves out an item whose only difference runs in a direction the rule closes", () => {
    // The remote is ahead on dataview and the rule is push only: nothing to do, so nothing to say.
    const local = lockByName(t0, { "plugin-dataview": { hash: "a", capturedAt: t0 } });
    const remote = lockByName(t1, { "plugin-dataview": { hash: "b", capturedAt: t1 } });
    expect(remoteItemVerdicts(local, remote, { pull: ["community/dataview"], push: [] })).toEqual({});
  });

  it("calls an item only the remote has a pull", () => {
    const local = lockByName(t0, { app: { hash: "a", capturedAt: t0 } });
    const remote = lockByName(t1, { app: { hash: "a", capturedAt: t0 }, themes: { hash: "t", capturedAt: t1 } });
    expect(remoteItemVerdicts(local, remote, none)).toEqual({ "obsidian/themes": "pull" });
  });

  it("says it cannot judge when a side stamps no entry with a capture time", () => {
    const unstamped = lockByName(t0, { app: { hash: "a" } });
    expect(remoteItemVerdicts(unstamped, lockByName(t1, { app: { hash: "b", capturedAt: t1 } }), none)).toBeNull();
  });
});

describe("remoteItemCounts · counts the verdict table", () => {
  it("adds up what each direction still needs", () => {
    expect(remoteItemCounts({ "obsidian/app": "push", "obsidian/hotkeys": "pull", "obsidian/themes": "pull" })).toEqual({ push: 1, pull: 2 });
  });

  it("passes the cannot-judge answer straight through", () => {
    expect(remoteItemCounts(null)).toBeNull();
  });

  it("counts an empty table as nothing waiting", () => {
    expect(remoteItemCounts({})).toEqual({ push: 0, pull: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/status.test.ts -t remoteItemVerdicts`
Expected: FAIL —— 未导出。

- [ ] **Step 3: 写实现**

`src/core/status.ts` —— 用判定表替换 Task 1 那版计数循环:

```ts
// What one item still needs with this remote. Absent from the table means "nothing to do", which
// merges three cases that are one fact for the reader (spec 3.3's redefinition of "in sync"): the
// two copies agree; the only difference runs in a direction this remote closes; the item exists on
// one side only and that direction is closed.
export type ItemVerdict = "pull" | "push";

export function remoteItemVerdicts(
  local: StoreLock | null,
  remote: StoreLock,
  ignore: DirectionIgnores
): Record<string, ItemVerdict> | null {
  if (!hasPerItemPayload(remote)) return null;
  if (local !== null && !hasPerItemPayload(local)) return null;
  const refs = [...new Set([...(local === null ? [] : lockEntryList(local.items)), ...lockEntryList(remote.items)].map(([ref]) => ref))];
  const out: Record<string, ItemVerdict> = {};
  for (const ref of refs) {
    const freshness = itemFreshness(local === null ? undefined : lockEntry(local, ref), lockEntry(remote, ref));
    if (freshness === "newer" && !ignore.pull.includes(ref)) out[ref] = "pull";
    else if (freshness === "older" && !ignore.push.includes(ref)) out[ref] = "push";
  }
  return out;
}

// The status bar's and the header pills' totals, counted off the SAME table the rows read, so a row
// and the number above it can never disagree about what is waiting.
export function remoteItemCounts(verdicts: Record<string, ItemVerdict> | null): RemoteItemCounts | null {
  if (verdicts === null) return null;
  let push = 0;
  let pull = 0;
  for (const v of Object.values(verdicts)) {
    if (v === "pull") pull++;
    else push++;
  }
  return { push, pull };
}
```

`RemoteCheck` 增加字段,`checkRemote` 一处算、两处用:

```ts
export interface RemoteCheck {
  state: RemoteState;
  remoteCapturedAt: string | null;
  items: RemoteItemCounts | null;
  // ref -> the direction that item still needs. null when this remote cannot be judged item by item
  // (see remoteItemCounts). The panel's rows read THIS; `items` is just its tally.
  itemVerdicts: Record<string, ItemVerdict> | null;
}
```

`checkRemote` 里把 `remoteItemCounts(localLock, remote, ignoreRefs)` 换成:

```ts
  const verdicts = remoteItemVerdicts(localLock, remote, ignore);
  const counts = remoteItemCounts(verdicts);
```

两个早退分支(没有 lock / 解析失败 / 版本太新)补 `itemVerdicts: null`。`main.ts` 里那处手写的 `{ state: "unknown", remoteCapturedAt: null, items: null }` 与 `SyncCenterView.ts` 的 `remoteIcon({...})` 同样补 `itemVerdicts: null`。

- [ ] **Step 4: 跑全套**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 三绿。2c 写的那批 `remoteItemCounts` 测试签名变了,改成传判定表(上面 Step 1 已给出替代断言,删掉旧的那个 describe)。

- [ ] **Step 5: 提交**

```bash
git add src/core/status.ts src/main.ts src/ui/SyncCenterView.ts tests/status.test.ts
git commit -m "feat(core): one table says what each item still needs with a remote"
```

---

### Task 3:行状态改读判定表

**Files:**
- Modify: `src/core/remoteRows.ts`(`remoteRowStatuses` 改签名;`remoteFlowFor` 退役)
- Modify: `src/ui/SyncCenterView.ts`(`remoteRows()`)
- Test: `tests/remoteRows.test.ts`(重写受影响的断言)

**Interfaces:**
- Consumes: Task 2 的 `ItemVerdict`
- Produces:
  - `remoteRowStatuses(input: { entries: readonly RemoteDiffEntry[]; verdicts: Record<string, ItemVerdict>; refOf: (group: string) => string | undefined; localGroupNames: readonly string[] }): GroupStatus[]`
  - `remoteFlowFor` **删除**

**这一步是本计划的重头。** 2b 的「整库一个方向」是权宜:那时唯一的证据是 `diffRemote` 的「两边字节等不等」,没有逐项方向可用。现在有了 —— 判定表按项给出方向,而且已经和四档规则相交过。于是:

- 行的**状态**来自判定表:`pull` → `store-newer`,`push` → `local-changed`,不在表里 → `in-sync`。
- 行的**变更文件**仍来自 `diffRemote`(卡片 `Files` 的证据),但它不再决定状态。**一个字节不同却不在判定表里的项,就是「一致」** —— spec 3.3 那条重定义在界面上的落点。
- **`lockDiffers` 那条通路自然归位**:远端只是版本信息更新时,两边 lock 条目按 `lockEntriesEquivalent` 就是不等(版本属于内容,只有 `display`/`capturedAt` 不算),判定表给出 `pull`,于是它是一行普通的待拉行 —— 有勾选框、进 `Pull N`、能被单独跳过。2b 起悬空的那条路到此闭合,不需要新控件也不需要新文案。

- [ ] **Step 1: 写失败测试**

重写 `tests/remoteRows.test.ts` 里 `remoteFlowFor` 那个 describe(整块删除)与 `remoteRowStatuses` 的断言:

```ts
import { remoteRowStatuses, skipRefsForSelection } from "../src/core/remoteRows";
import { RemoteDiffEntry } from "../src/core/status";

const entry = (group: string, kinds: ("added" | "updated" | "deleted")[]): RemoteDiffEntry => ({
  group,
  files: kinds.map((kind, i) => ({ itemRel: `f${i}.json`, kind, local: null, remote: null })),
});

describe("remoteRowStatuses", () => {
  const local = ["appearance", "hotkeys", "dataview"];
  const refOf = (g: string): string | undefined =>
    g === "hotkeys" ? "obsidian/hotkeys" : g === "appearance" ? "obsidian/appearance" : g === "dataview" ? "community/dataview" : undefined;

  it("takes each row's direction from the verdict table, not from the file diff", () => {
    const rows = remoteRowStatuses({
      entries: [entry("hotkeys", ["updated"]), entry("dataview", ["updated"])],
      verdicts: { "obsidian/hotkeys": "pull", "community/dataview": "push" },
      refOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "hotkeys")?.state).toBe("store-newer");
    expect(rows.find((r) => r.group === "dataview")?.state).toBe("local-changed");
  });

  it("calls an item in sync when its bytes differ but nothing flows in an allowed direction", () => {
    // spec 3.3: the remote edited a Push only item. Different bytes, no pending work.
    const rows = remoteRowStatuses({
      entries: [entry("dataview", ["updated"])],
      verdicts: {},
      refOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "dataview")?.state).toBe("in-sync");
  });

  it("still carries the changed files, so the card can show what the row stays quiet about", () => {
    const rows = remoteRowStatuses({
      entries: [entry("dataview", ["updated", "added"])],
      verdicts: {},
      refOf,
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "dataview")?.changes).toEqual({ added: ["f1.json"], updated: ["f0.json"], deleted: [] });
  });

  it("gives a row to an item the verdict table names but the file diff never mentioned", () => {
    // Version info moved on the remote and nothing else — a real pull, with no file-level delta.
    const rows = remoteRowStatuses({ entries: [], verdicts: { "obsidian/hotkeys": "pull" }, refOf, localGroupNames: local });
    expect(rows.find((r) => r.group === "hotkeys")?.state).toBe("store-newer");
  });

  it("keeps an entry with no local counterpart — the remote has items this device does not", () => {
    const rows = remoteRowStatuses({
      entries: [entry("themes", ["added"])],
      verdicts: {},
      refOf: (g) => (g === "themes" ? undefined : refOf(g)),
      localGroupNames: local,
    });
    expect(rows.find((r) => r.group === "themes")?.state).toBe("store-newer");
  });

  it("drops the store-metadata pseudo-entry, which is bookkeeping and never an item", () => {
    const rows = remoteRowStatuses({ entries: [entry("", ["updated"])], verdicts: {}, refOf, localGroupNames: local });
    expect(rows.every((r) => r.group !== "")).toBe(true);
  });

  it("says nothing is waiting when the table is empty and the diff found nothing", () => {
    const rows = remoteRowStatuses({ entries: [], verdicts: {}, refOf, localGroupNames: local });
    expect(rows.every((r) => r.state === "in-sync")).toBe(true);
    expect(rows).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRows.test.ts`
Expected: FAIL —— `remoteRowStatuses` 还收 `flow`,也还没有 `verdicts`。

- [ ] **Step 3: 写实现**

`src/core/remoteRows.ts` —— 删掉 `RemoteFlow` / `remoteFlowFor`,`remoteRowStatuses` 改成:

```ts
// The remote relation's rows, in the SAME shape the device relation produces, so one renderer draws
// both. Two inputs, two jobs, kept apart on purpose:
//
//   `verdicts` says what each item still NEEDS (core/status.ts's remoteItemVerdicts, already
//   intersected with this remote's four-stop rules) — that is the row's STATE.
//   `entries` says which files differ — that is the card's EVIDENCE, and it no longer decides the
//   state. An item whose bytes differ but whose difference runs in a closed direction is in sync
//   (spec 3.3), and the card is where it still answers what changed over there.
//
// An item the table names but the diff never mentioned still gets its row: the remote can be ahead
// on bookkeeping alone (a newer recorded version, same bytes), which is a real pull.
export function remoteRowStatuses(input: {
  entries: readonly RemoteDiffEntry[];
  verdicts: Record<string, ItemVerdict>;
  refOf: (group: string) => string | undefined;
  localGroupNames: readonly string[];
}): GroupStatus[] {
  const { entries, verdicts, refOf, localGroupNames } = input;
  const changesByGroup = new Map<string, FileChanges>();
  for (const e of entries) {
    // "" is diffRemote's store-metadata pseudo-entry and OTHER_STORE_FILES_GROUP its unattributable
    // one. Neither is an item, so neither is ever a row.
    if (e.group === "" || e.group === OTHER_STORE_FILES_GROUP) continue;
    if (e.files.length === 0) continue;
    changesByGroup.set(e.group, changesOf(e));
  }
  const stateOf = (group: string): GroupState => {
    const ref = refOf(group);
    // A row with no ref carries no rule and no lock entry to judge; the file diff is all there is,
    // so a difference reads as an incoming one. (Plan 3b gives those items a ref of their own.)
    if (ref === undefined) return changesByGroup.has(group) ? "store-newer" : "in-sync";
    const verdict = verdicts[ref];
    return verdict === "pull" ? "store-newer" : verdict === "push" ? "local-changed" : "in-sync";
  };
  const names = [...new Set([...localGroupNames, ...changesByGroup.keys()])];
  return names.map((group) => {
    const changes = changesByGroup.get(group);
    const status: GroupStatus = { group, state: stateOf(group) };
    return changes === undefined ? status : { ...status, changes };
  });
}
```

`src/ui/SyncCenterView.ts` 的 `remoteRows(name)`:

```ts
    const check = this.host.remoteCheck(name)?.check;
    const verdicts = check?.itemVerdicts ?? {};
    …
    return remoteRowStatuses({
      entries: folded,
      verdicts,
      refOf: (g) => this.itemRefFor(g) ?? findGroupByName(this.groups, g)?.ref,
      localGroupNames,
    }).map(…);
```

`remoteFlowFor` 的 import 删除。

- [ ] **Step 4: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机(dev vault,照 2b/2c 的 fixture 做法;**记得两边 lock 的条目都要带 `capturedAt`**,否则判定表恒为 null):
1. 远端在 hotkeys 上更新 → 那一行 `To pull`,勾选、`Pull 1 item` 能跑。
2. 把 dataview 设成 `Push only`,再让**远端**改它 → 那一行落进 `In sync` 折叠区、无勾选框、不计入 `To pull`(spec 3.3)。
3. 同一项改成本地更新 → 它回到 `To push`,说明忽略集是按方向的,不是一刀切。
4. 只改远端 lock 里某项的版本信息(内容不动)→ 那一项出现在 `To pull`,可勾可跑(`lockDiffers` 归位)。
5. 设备关系一个像素不变。
6. `dev:errors` 无捕获。

- [ ] **Step 5: 提交**

```bash
git add src/core/remoteRows.ts src/ui/SyncCenterView.ts tests/remoteRows.test.ts
git commit -m "feat(panel): a row's direction is its own, and in sync means nothing left to do"
```

---

### Task 4:安静的行,有问必答的卡片

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`stateClauseText`、`renderFilesRow` 的徽章)
- Test: `tests/panelRelation.test.ts`(续写:纯文案生产者)

**Interfaces:**
- Consumes: Task 3 的行状态
- Produces: `function withheldChangeClause(remoteName: string, files: number): string`(`src/ui/panelModel.ts`)

**spec 3.3 接受的代价,由 5.4 补偿:** 列表保持安静(那一行读作一致),但卡片点开就得说清楚对面变了什么。spec 5.4 的原话:「`Push only` 且远端更新时,卡里照常显示对面变了什么…… `Files` 的徽章在这里**没有方向**(这些文件不会流动),改用中性字形,悬停说明这些变化留在对面」。State 行的定稿措辞也在那里。

- [ ] **Step 1: 写失败测试**

追加到 `tests/panelRelation.test.ts`:

```ts
import { withheldChangeClause } from "../src/ui/panelModel";

describe("withheldChangeClause", () => {
  it("names the remote, the size of the change, and why it stays there", () => {
    expect(withheldChangeClause("main", 3)).toBe("main changed 3 files. Push only, so they stay there.");
  });

  it("keeps the singular honest", () => {
    expect(withheldChangeClause("main", 1)).toBe("main changed 1 file. Push only, so they stay there.");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/panelRelation.test.ts -t withheldChangeClause`
Expected: FAIL —— 未导出。

- [ ] **Step 3: 写实现**

`src/ui/panelModel.ts`:

```ts
// The card's answer for a row the LIST keeps quiet about (spec 3.3's accepted cost, paid back by
// 5.4): the remote edited an item that only travels the other way. The row reads as in sync because
// there is nothing to do; the card says what moved over there and why it stays.
export function withheldChangeClause(remoteName: string, files: number): string {
  return `${remoteName} changed ${files} file${files === 1 ? "" : "s"}. Push only, so they stay there.`;
}
```

`SyncCenterView.ts` 的 `stateClauseText`,remote 关系那一支加一条:一行判定为「无待办」却带着变更文件时,说这句而不是 `In sync.`:

```ts
      if (r.remote !== undefined) {
        const changed = r.status.changes === undefined ? 0 : this.folderChangeCount(r.status.changes);
        // Nothing to do AND files that differ = the difference runs the way this remote does not.
        if (changed > 0) return withheldChangeClause(r.remote, changed);
        return `${fate.sentence}.`;
      }
```

`renderFilesRow` 在同一情形下改用中性徽章:方向图标换成 `files` 字形(Lucide `files`),aria 写 `${changed} file${s} changed at ${remoteName} — they stay there`。**这是这一轮唯一的新字形**,它表达的是「有文件,但不流动」,与 `cloud-upload`/`cloud-download` 是不同含义,所以不共用;记得在 `tests/fateChipIcons.test.ts` 的碰撞守卫里登记(若它进了任何一个字形登记表)。

- [ ] **Step 4: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机:把某项设成 `Push only` 并让远端改它 → 行在 `In sync` 折叠区里安静;点开卡片,State 读作 `main changed 2 files. Push only, so they stay there.`,`Files` 行的徽章是中性字形,展开仍能逐文件看差异。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SyncCenterView.ts src/ui/panelModel.ts tests
git commit -m "feat(panel): the list stays quiet, the card answers"
```

---

### Task 5:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(`core/status.ts`、`core/remoteRows.ts` 两条)
- Modify: `docs/design/DESIGN.md`(Type sections 里 remote 那段、Unified card)
- Modify: `docs/GUIDE.md`(Transport 一节)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

- [ ] **Step 1: ARCHITECTURE.md**

`core/status.ts` 那条:`checkRemote` 现在收**两个**忽略集(`DirectionIgnores`),因为它答的是两个问题;`remoteItemVerdicts` 是逐项判定的唯一生产者,`remoteItemCounts` 只是它的计数,`RemoteCheck.itemVerdicts` 是面板行状态的来源。`core/remoteRows.ts` 那条:`remoteFlowFor` 已退役;`remoteRowStatuses` 的状态来自判定表、变更文件只作卡片证据,并写明「表里没有 = 一致」合并了哪三种情形。

- [ ] **Step 2: DESIGN.md**

Type sections 里 remote 那段补:一行的方向是它自己的,不再是整库一个方向;**一致的含义变了** —— 在允许流动的方向上没有待办,所以一个只推的项被对面改了会落进 `In sync`,卡片里才说 `<remote> changed N files. Push only, so they stay there.`,`Files` 徽章在这一情形下用中性字形。

- [ ] **Step 3: GUIDE.md**

Transport 一节补一句:**一致**在这里的意思是「在你允许的方向上没有待办」。把一项设成只推之后,对面自己改了它不会再催你 —— 想知道对面改了什么,点开那一项的卡片。

- [ ] **Step 4: CHANGELOG.md**

2.25.0 条目追加一条,产品视角:每一行现在自己判断还有什么要做 —— 一个只往一个方向走的项,被对面改了不再挂在待办里(点开卡片仍看得到对面改了什么);只有版本信息更新的项也重新变回一行可勾可跑的待拉行。

- [ ] **Step 5: 核对**

`grep -rn "remoteFlowFor" src/ docs/` 除 `docs/superpowers/` 下的历史计划外无命中。

- [ ] **Step 6: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: in sync means nothing left to do in a direction you allow"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超基线 0 error / 57 warn)。
- `grep -rn "remoteFlowFor" src/` 无命中。
- **设备关系下逐像素不变**:与 2c 的截图比对通过。
- 真机冒烟:Task 3 的六条 + Task 4 的一条全过。
- **`lockDiffers` 闭合**:只改远端某项的版本信息,该项出现在 `To pull`、可勾、跑完消失。

## 交给 3b / 3c 的边界

- **逐键扣留的一切**(3.1/3.2 的合并语义、3.4.2 的重新盖章、3.4.3 的指纹快路、3.4.4 与 3.6 的派生 lock)全在 3b。本轮的判定表只到 item 级:带扣留键的项在 3b 之前仍按整项比。
- **并发**(3.7):vault 类型的写前复核、过期判断中止,在 3c。
- **只有远端才有的项**仍然没有 ref —— 它的行由文件差异定状态(见 `stateOf` 的注释),取消勾选对它无效。3b 给它一个 ref 时一并解决。
- **加密项**(3.8)的解密后比对属于 Plan 4;在那之前,加密项的指纹按设计永不相等,会持续判为有待办。
