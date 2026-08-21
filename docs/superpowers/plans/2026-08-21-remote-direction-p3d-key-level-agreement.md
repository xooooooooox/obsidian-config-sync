# 2.25.0 · Plan 3d:键级的「一致」 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「一致」在键这一级也成立。带**两个方向都不流动**的键的项,两侧按设计就不同 —— 本轮把这类键在比较时蒙掉:卡片的 `Files` 不再永远挂着这一行,行的判定也不再被一个任何 Pull / Push 都清不掉的指纹差异钉住。

**Architecture:** 一个新事实 ——「哪些键两个方向都不走」(`unexchangedPatternsFor`)—— 喂给两处比较。**卡片侧**:`diffRemote` 的 `filesMatch` 把这些键蒙掉再比字节。**行侧**:`itemFreshness` 今天「两侧都有指纹且内容记录相等就判等」,而这类项的指纹按设计永不相等,于是退回按捕获时间比 —— 对面每捕获一次就永久点亮一个箭头。修法是给判定表和整库状态各加一个 `settled` 入参:一组**已由蒙键内容比较证明无事可做**的 ref,它们不再产生任何方向。这组 ref 由 `checkRemote` 通过一次定向的文件比较得出(只针对有键规则的项,数量由用户决定,通常个位数)。

**Tech Stack:** TypeScript(strict)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 3.3 的逐键部分与 3.4 第 3 条;验收第 5 条)

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b / 3c | 数据模型 → 逐项方向 → 派生 lock → 逐键扣留的传输 | **DONE**,均已合入 main |
| **3d** | **本文件** | 键级的「一致」 |
| 3e | 卡片 `Keys` 区(5.4),键级规则的写入口 | 计划未写 |
| 3f | 并发(3.7) | 计划未写 |
| 4 | 加密(3.8/3.9) | 未开始 |

## 3c 留下的两个可观测事实(本轮要消灭的就是它们)

3c 的真机冒烟末尾实测到:

1. **行是安静的,卡片不是。** `deepDiff` 仍报 `plugin-dataview: 1`,因为 `filesMatch`(`core/status.ts`)在比字节,而那个键按设计就不同。
2. **行的安静是巧合,不是结论。** 推送之后两边条目的 `capturedAt` 相同,`itemFreshness` 落进 `undatable`,于是没有判定 —— 看着对,理由是错的。**对面单独再捕获一次**(哪怕只改了那个不流动的键),它的 `capturedAt` 就领先,判定立刻变成 `pull`,而拉取什么都不会写,箭头永久留在那里。

## Global Constraints

- **蒙掉的是「两个方向都不走」的键,不是「有规则」的键。** 一个只往一个方向走的键,两侧不同就是真的有事可做(那个方向跑一次就收敛),蒙掉它等于骗自己。与 3b 里 `deepDiff` 取两个阻塞集**交集**是同一条推理。
- **设备关系一个像素都不许变。** 本轮只动 remote 关系下的比较。
- **不许为了安静而丢掉真差异。** 只有蒙键之后仍然相等,才算无事可做;蒙键之后仍不同的项,方向照旧由两边条目的时间决定。
- **额外的文件读取只发生在有键规则的项上。** 没有键规则的 remote 走的路径与今天逐字节相同(`withheldPatternPredicate` 已有那条 `anyKeyRules` 快路)。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/remoteRules.ts`(改) | 新增 `unexchangedPatternsFor` —— 哪些键两个方向都不走 |
| `src/core/keyWithholding.ts`(改) | 新增 `unexchangedPatternPredicate`(按 rel 查)与 `sameApartFromWithheld`(蒙键之后是否相等) |
| `src/core/status.ts`(改) | `diffRemote` 蒙键比较;`remoteItemVerdicts` / `perItemRemoteState` 收 `settled`;`checkRemote` 算出它 |
| `src/main.ts`(改) | 两个调用点各传一个 predicate / 一个比较器 |
| `tests/keyWithholding.test.ts`、`tests/status.test.ts`(改) | 两处比较的行为 |

---

### Task 1:两个方向都不走的键,比较时蒙掉

**Files:**
- Modify: `src/core/remoteRules.ts`、`src/core/keyWithholding.ts`、`src/core/status.ts`(`diffRemote`)、`src/main.ts`(`deepDiff` 那个 host 方法)
- Test: `tests/keyWithholding.test.ts`、`tests/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // core/remoteRules.ts
  export function unexchangedPatternsFor(items: RemoteItems | undefined, ref: ItemRef): string[]

  // core/keyWithholding.ts
  export function unexchangedPatternPredicate(items: RemoteItems | undefined, ...groupLists: SyncGroup[][]): (rel: string) => string[]
  export function sameApartFromWithheld(input: { a: string | null; b: string | null; patterns: readonly string[] }): boolean

  // core/status.ts
  diffRemote(ctx, reader, opts: { skipRefs: ItemRef[]; unexchanged: (rel: string) => string[] })
  ```

**`sameApartFromWithheld` 为什么不复用 `overlayWithheld`:** 那个函数**生产要写出去的内容**,解析失败必须抛(否则会把一个扣留的键送出去)。这个函数只**回答一个问题**,而它的调用点已经有一个正确的退路 —— 比不了就按字节比,也就是今天的行为。同一段代码服务两种失败语义,才是真的错。

- [ ] **Step 1: 写失败测试**

追加到 `tests/keyWithholding.test.ts`:

```ts
describe("sameApartFromWithheld", () => {
  it("calls two documents the same when they differ only in a key that travels neither way", () => {
    expect(sameApartFromWithheld({ a: '{"x":1,"mine":"a"}', b: '{"x":1,"mine":"b"}', patterns: ["mine"] })).toBe(true);
  });

  it("still sees a difference in any other key", () => {
    expect(sameApartFromWithheld({ a: '{"x":1,"mine":"a"}', b: '{"x":2,"mine":"a"}', patterns: ["mine"] })).toBe(false);
  });

  it("ignores key order and formatting, the way the store's two writers legitimately differ", () => {
    expect(sameApartFromWithheld({ a: '{"a":1,"b":2}', b: '{\n  "b": 2,\n  "a": 1\n}\n', patterns: [] })).toBe(true);
  });

  it("one side missing the file entirely is a difference, not a match", () => {
    expect(sameApartFromWithheld({ a: null, b: '{"x":1}', patterns: ["x"] })).toBe(false);
    expect(sameApartFromWithheld({ a: null, b: null, patterns: [] })).toBe(true);
  });

  it("falls back to a byte comparison when a side is not JSON — answering a question, not writing a file", () => {
    expect(sameApartFromWithheld({ a: "not json", b: "not json", patterns: ["x"] })).toBe(true);
    expect(sameApartFromWithheld({ a: "not json", b: "other", patterns: ["x"] })).toBe(false);
  });
});

describe("unexchangedPatternPredicate", () => {
  const groups: SyncGroup[] = [
    { name: "plugin-dataview", ref: "community/dataview", path: "{configDir}/plugins/dataview/data.json", type: "file", devices: "all" },
  ];

  it("names only the keys that travel in NEITHER direction", () => {
    const rules: RemoteItems = { community: { dataview: { keys: { stuck: { direction: "none" }, oneWay: { direction: "push" } } } } };
    expect(unexchangedPatternPredicate(rules, groups)("store/configdir/plugins/dataview/data.json")).toEqual(["stuck"]);
  });

  it("counts a key narrowed to nothing by its item's own direction", () => {
    const rules: RemoteItems = { community: { dataview: { direction: "pull", keys: { stuck: { direction: "push" } } } } };
    expect(unexchangedPatternPredicate(rules, groups)("store/configdir/plugins/dataview/data.json")).toEqual(["stuck"]);
  });
});
```

追加到 `tests/status.test.ts`(该文件已有 `diffRemote` 的用例与 `fakeReader`,照其写法):

```ts
describe("diffRemote · keys that travel neither way", () => {
  it("does not report a file whose only difference is such a key", async () => {
    // …seed a local store and a remote whose demo/data.json differs ONLY in `mine`
    const entries = await diffRemote(ctx, reader, { skipRefs: [], unexchanged: () => ["mine"] });
    expect(entries).toEqual([]);
  });

  it("still reports the file as soon as anything else differs", async () => {
    const entries = await diffRemote(ctx, reader, { skipRefs: [], unexchanged: () => ["mine"] });
    expect(entries.flatMap((e) => e.files.map((f) => f.itemRel))).toEqual(["data.json"]);
  });
});
```

**注意**:第二条的两侧内容要在 `mine` 之外再差一个键。夹具照该文件既有 `diffRemote` 用例的搭法写(`setup()` + `io.seed` + `fakeReader`),不要另起一套。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/keyWithholding.test.ts tests/status.test.ts`
Expected: FAIL —— 三个新导出都不存在;`diffRemote` 不认识 `unexchanged`。

- [ ] **Step 3: 写实现**

`src/core/remoteRules.ts`:

```ts
// The keys this remote exchanges in NEITHER direction. Narrower than "has a rule" on purpose: a key
// that still travels one way converges the next time that direction runs, so a difference in it is
// real work and must keep showing. Only these two-way-closed keys differ BY DESIGN, forever.
export function unexchangedPatternsFor(items: RemoteItems | undefined, ref: ItemRef): string[] {
  const keys = ruleFor(items, ref)?.keys;
  if (keys === undefined) return [];
  return Object.keys(keys).filter((pattern) => keyDirection(items, ref, pattern) === "none");
}
```

`src/core/keyWithholding.ts` —— 第二个 predicate 与 `withheldPatternPredicate` 只差问的那句话,把两者共同的部分抽成一个内部工厂(`relPatternPredicate(items, patternsFor, groupLists)`),不要复制粘贴一遍 rel 解析与记忆化。

```ts
// Are these two copies the same once the keys that travel neither way are masked off? Answers a
// QUESTION, so a side it cannot parse falls back to the byte comparison the caller would have done
// anyway — unlike `overlayWithheld`, which PRODUCES the content a run sends and must refuse rather
// than let a withheld key slip out. `null` on one side only is a difference; on both, a match.
export function sameApartFromWithheld(input: { a: string | null; b: string | null; patterns: readonly string[] }): boolean {
  const { a, b, patterns } = input;
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  let pa: unknown;
  let pb: unknown;
  try {
    pa = JSON.parse(a);
    pb = JSON.parse(b);
  } catch {
    return false; // not JSON: the byte comparison above already had its say
  }
  return jsonEqualIgnoring(pa, pb, [...patterns]);
}
```

`jsonEqualIgnoring` 用既有件拼:`sanitizeJson(value, patterns)` 去掉受规则约束的键,再用 `core/merge.ts` 的 `jsonSortedView` / `sortKeysDeep` 做与键序无关的比较 —— **不要新写一个深比较**,那正是 `lockValuesEqual` 注释里点名的重复。

`src/core/status.ts` 的 `diffRemote`:选项加 `unexchanged`(必填,与 `skipRefs` 同一条纪律),`filesMatch` 收 rel:

```ts
  const filesMatch = (name: string, rel: string, remoteContent: string, localContent: string): boolean => {
    // Keys this remote exchanges neither way differ by design and always will (spec 3.3): a file
    // whose ONLY difference is one of them has nothing waiting, and saying otherwise puts a row on
    // the card that no run can ever clear.
    const patterns = opts.unexchanged(rel);
    if (patterns.length > 0 && sameApartFromWithheld({ a: remoteContent, b: localContent, patterns })) return true;
    if (remoteContent === localContent) return true;
    …unchanged switch-list branch…
  };
```

`src/main.ts` 的 `deepDiff`:

```ts
        const entries = await diffRemote(ctx, reader, {
          skipRefs,
          unexchanged: unexchangedPatternPredicate(remote.items, this.compiledGroups),
        });
```

其余 `diffRemote` 调用点(测试)传 `unexchanged: () => []`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/keyWithholding.test.ts tests/status.test.ts`
Expected: PASS。

- [ ] **Step 5: 三绿并提交**

```bash
git add src tests
git commit -m "fix(panel): a key that travels neither way is not a difference to report"
```

---

### Task 2:行的判定不再被一个清不掉的指纹钉住

**Files:**
- Modify: `src/core/status.ts`(`remoteItemVerdicts`、`perItemRemoteState`、`checkRemote`)
- Modify: `src/main.ts`(`refreshRemoteChecks` 的 `checkRemote` 调用点)
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function remoteItemVerdicts(local: StoreLock | null, remote: StoreLock, ignore: DirectionIgnores, settled: ReadonlySet<string>): Record<string, ItemVerdict> | null
  // perItemRemoteState(local, remote, ignore, settled) —— 私有,签名跟着变

  export async function checkRemote(
    localLock: StoreLock | null,
    reader: ExternalStoreReader,
    ignore: DirectionIgnores,
    opts: {
      groups: readonly SyncGroup[];
      // Items whose two copies differ BY DESIGN. `sameApartFromWithheld(ref)` is the only way to
      // tell whether such an item still needs anything — its fingerprints never match.
      keyRuled: { refs: readonly string[]; sameApartFromWithheld: (ref: string) => Promise<boolean> };
    }
  ): Promise<RemoteCheck>
  ```

**为什么必须是内容比较:** 指纹快路对这类项按设计永远失效,而退回捕获时间是错的 —— 对面单捕获一次就永久领先。两边的 lock 里没有任何字段能回答「除去那些键之外我们一样吗」,只有文件能。代价可接受:只对有键规则的项发生,而每次比较本来就已经克隆了一整个 git 仓库(spec 3.8 对派生密钥用的是同一条推理)。

**`groups` 从可选变必填**:今天它是 `groups?`,注释解释了「有些调用方手上没有编译清单」。改成 opts 里的必填字段,那些调用方写 `groups: []` —— 说出来的和从前一样,只是不再靠忘记来表达。

- [ ] **Step 1: 写失败测试**

追加到 `tests/status.test.ts`:

```ts
describe("remoteItemVerdicts · items settled by content", () => {
  const t0 = "2026-08-01T00:00:00.000Z";
  const t1 = "2026-08-02T00:00:00.000Z";
  const none = { pull: [], push: [] };

  it("drops the verdict for an item whose copies differ only in keys that travel neither way", () => {
    // The remote captured later and its fingerprint differs — by design, and forever.
    const local = lockByName(t0, { "plugin-dataview": { hash: "a", capturedAt: t0 } });
    const remote = lockByName(t1, { "plugin-dataview": { hash: "b", capturedAt: t1 } });
    expect(remoteItemVerdicts(local, remote, none, new Set(["community/dataview"]))).toEqual({});
  });

  it("leaves every other item exactly as it was", () => {
    const local = lockByName(t0, { "plugin-dataview": { hash: "a", capturedAt: t0 }, app: { hash: "x", capturedAt: t0 } });
    const remote = lockByName(t1, { "plugin-dataview": { hash: "b", capturedAt: t1 }, app: { hash: "y", capturedAt: t1 } });
    expect(remoteItemVerdicts(local, remote, none, new Set(["community/dataview"]))).toEqual({ "obsidian/app": "pull" });
  });
});

describe("checkRemote · key-ruled items", () => {
  it("asks the content comparison once per key-ruled item and lets it settle the row", async () => {
    const asked: string[] = [];
    const check = await checkRemote(localLock, fakeReader(remoteFiles(newerRemote)), NO_IGNORES, {
      groups: [],
      keyRuled: {
        refs: ["community/dataview"],
        sameApartFromWithheld: async (ref) => {
          asked.push(ref);
          return true; // masked-equal: nothing waiting
        },
      },
    });
    expect(asked).toEqual(["community/dataview"]);
    expect(check.itemVerdicts?.["community/dataview"]).toBeUndefined();
  });

  it("keeps the verdict when the masked comparison still sees a difference", async () => {
    const check = await checkRemote(localLock, fakeReader(remoteFiles(newerRemote)), NO_IGNORES, {
      groups: [],
      keyRuled: { refs: ["community/dataview"], sameApartFromWithheld: async () => false },
    });
    expect(check.itemVerdicts?.["community/dataview"]).toBe("pull");
  });
});
```

夹具(`localLock` / `newerRemote` / `remoteFiles` / `NO_IGNORES`)照该文件既有 `checkRemote` 用例的搭法,`plugin-dataview` 那条两侧 `hash` 不同且远端 `capturedAt` 更新。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/status.test.ts -t "settled by content"` 与 `-t "key-ruled items"`
Expected: FAIL —— 第四个参数不存在。

- [ ] **Step 3: 写实现**

`remoteItemVerdicts` / `perItemRemoteState` 各加一个 `settled` 入参,在循环开头一行:

```ts
  for (const ref of refs) {
    // Proven to have nothing waiting by the masked content comparison (spec 3.3/3.4.3). Its
    // fingerprints will never agree — that is what the rule MEANS — so the entries must not be
    // allowed to speak for it at all, in either function.
    if (settled.has(ref)) continue;
```

`checkRemote`:签名换成 opts,在算判定之前问一遍:

```ts
  const settled = new Set<string>();
  for (const ref of opts.keyRuled.refs) {
    if (await opts.keyRuled.sameApartFromWithheld(ref)) settled.add(ref);
  }
  const verdicts = remoteItemVerdicts(localLock, remote, ignore, settled);
  const counts = remoteItemCounts(verdicts);
  const perItem = perItemRemoteState(localLock, remote, ignore, settled);
```

**顺序要点:** 提前返回的三条(无 lock、解析失败、版本更新)都在这之前,所以不可比的 remote 一次文件都不会多读。

`src/main.ts` 的 `refreshRemoteChecks`:

```ts
        const unexchanged = unexchangedPatternPredicate(remote.items, this.compiledGroups);
        const check = await checkRemote(localLock, reader, ignore, {
          groups: this.compiledGroups,
          keyRuled: {
            refs: refsWithKeyRules(remote.items),
            sameApartFromWithheld: (ref) => storeItemsAgree({ ctx, reader, groups: this.compiledGroups, ref, unexchanged }),
          },
        });
```

两个新件都放 `core/keyWithholding.ts`,因为它们是同一条规则的两端:

```ts
// Every item this remote has key rules for. The refs that need the content comparison — and the
// only ones that pay for it.
export function refsWithKeyRules(items: RemoteItems | undefined): string[]

// One item's two copies, compared with the keys that travel neither way masked off. Reads the item's
// store rels from BOTH sides — this vault's through `io`, the far end's through the reader it was
// already using — and answers false as soon as any of them disagrees. An item with no store copy on
// either side agrees trivially.
export async function storeItemsAgree(input: {
  io: FileIO;
  rootPath: string;
  reader: { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> };
  groups: readonly SyncGroup[];
  ref: string;
  unexchanged: (rel: string) => string[];
}): Promise<boolean>
```

`storeItemsAgree` 的 rel 列表:该 ref 的 group 若是 `type: "file"`,就是主文件加两个 sidecar(`sidecarStoreSuffix`);`folder` 型项**不可能有键规则**(`relCanHaveKeys` 已经这么规定),所以直接答 `true`,并把这条写进注释 —— 将来若放宽 `relCanHaveKeys`,这里要一起放宽。

- [ ] **Step 4: 跑测试确认通过 + 跟上调用点**

`checkRemote` 的 16 个调用点(1 生产 + 15 测试)全部要跟。测试统一写:

```ts
{ groups: [], keyRuled: { refs: [], sameApartFromWithheld: async () => true } }
```

Run: `npx tsc --noEmit`、`npx vitest run`、`npx eslint .`
Expected: 三绿,lint 不超基线。

- [ ] **Step 5: 提交**

```bash
git add src tests
git commit -m "fix(remote): an item that differs by design stops asking to be pulled"
```

---

### Task 3:真机冒烟

**Files:** 无(验证任务)

夹具与 3c 同一套(scratchpad 的 `remote-vault2`,`dataview` 的 `prettyRenderInlineFields` 设为 `direction: "none"`,两边各自不同的值)。

- [ ] **Step 1: 装上并重载**

`npm run smoke:install`,在 `dev/vault` 下 `obsidian command id=app:reload`。

- [ ] **Step 2: 卡片不再挂着那一行(本轮的第一个目标)**

Run:`host.deepDiff(remote)`。
Expected:`plugin-dataview` **不在结果里**;把两边的另一个普通键改成不同的值,它立刻又出现。

- [ ] **Step 3: 对面单独捕获一次,行仍然安静(本轮的第二个目标)**

把夹具里 `dataview` 那条 lock 条目的 `capturedAt` 往后调一天、`hash` 改一个值(模拟对面重新捕获,而唯一变化的是那个不流动的键),然后 `refreshRemoteChecks()`。
Expected:`itemVerdicts["community/dataview"]` 仍是 undefined。**这一步是 3c 冒烟里那个「安静得没有道理」的直接反例 —— 改动之前它会变成 `pull`,而任何 Pull 都清不掉它。**

- [ ] **Step 4: 真差异照旧报出来**

在对面改一个普通键,`refreshRemoteChecks()`。Expected:该项判定为 `pull`,卡片里也列出那份文件。跑一次 Pull,判定消失。

- [ ] **Step 5: 没有键规则的 remote 一切照旧**

把 `items` 整个删掉再比一次:结果与 3b 冒烟一致(逐字节),没有额外的文件读取路径被触发。

---

### Task 4:文档追平

**Files:** `docs/ARCHITECTURE.md`、`docs/GUIDE.md`、`CHANGELOG.md`

- [ ] **Step 1: ARCHITECTURE.md**

`core/keyWithholding.ts` 那条补三件事:`unexchangedPatternsFor` 与 `withheldPatternsFor` 的区别(**两个方向都不走** vs. 某一个方向不走)、`sameApartFromWithheld` 为什么容忍非 JSON 而 `overlayWithheld` 必须抛、以及 `storeItemsAgree` 是**指纹快路的替代品**而不是补充。`core/status.ts` 那条补 `settled` 的含义与它为什么必须同时作用于判定表和整库状态。

- [ ] **Step 2: GUIDE.md**

Transport 一节补一句:一个设成两边都不走的设置,两边各留各的值,**Config Sync 从此不再把它算成待办** —— 不会在卡片里挂一行你永远处理不掉的差异。

- [ ] **Step 3: CHANGELOG.md**

2.25.0 追加:

> Fixed a setting held back in both directions reading as unfinished work forever. Those two values are meant to differ, so they no longer count as a difference: the item stops asking to be pulled every time the other device saves, and its card stops listing a file you could never reconcile

- [ ] **Step 4: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: a difference by design is not a difference to act on"
```

---

## 完成标准

- 三绿,lint 不超基线。
- Task 3 五步全过,其中第 3 步是本轮的关键反例。
- **没有键规则的 remote 走的路径与 3c 之前逐字节相同**(`anyKeyRules` 快路仍在,且 `keyRuled.refs` 为空时不读任何额外文件)。

## 交给 3e / 3f 的边界

- **键级规则的写入口**(卡片 `Keys` 区,spec 5.4)在 3e。在那之前键规则只能手写 `data.json`,冒烟仍按 3c 的做法。
- **`Can't compare`**(加密项未解锁,spec 3.8 的第三态)不在本轮:本轮的内容比较遇到密文会照旧判为不同,与今天一致。Plan 4 处理。
- **并发**(3.7)在 3f。
- **一个已知的诚实缺口**:蒙键之后仍不同、而两边条目的时间又排不出先后(`undatable`)时,本轮仍然不给方向 —— 与今天所有 `undatable` 的处理一致。要改就是给行一个「有差异但说不清方向」的状态,那是新的 UI 语汇,不在 2.25.0。
