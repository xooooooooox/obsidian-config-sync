# 2.25.0 · Plan 3c:逐键扣留的传输语义 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pull 与 push 真正遵守键级规则:**拉**以本地那份为底稿,远端的值盖上来,被扣留的键不盖;**推**以远端那份为底稿,我的值盖上去,被扣留的键不盖 —— 对面那个键的值原封不动。随之把两处记账修对:pull 后这类项重新盖章(拿到的是混合内容,不能照搬对面的条目),push 送出的派生 lock 里这类项按**实际发出去的内容**重算指纹。

**Architecture:** 一个纯模块 `core/keyWithholding.ts` 提供两样东西:**按 rel 查这一方向该扣哪些键**(与 `skipRelPredicate` 同形,只是它答的是键而不是整项),以及**一个叠加函数** `overlayWithheld({keep, take, patterns})` —— 两个方向共用同一个函数,区别只在谁当底稿。三个传输点各接一处:`planImport` 在建远端文件映射时就把内容改写成合并后的样子(于是 `classifyMerge` 直接看到的就是将要写进去的东西);`pushExternal` 在写循环里把要发的内容叠加出来;`derivedPushLock` 对被改写过的项按发出内容重算指纹。

**Tech Stack:** TypeScript(strict)、vitest。`core/keyWithholding.ts` 零 IO、零 DOM,可纯单测。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 3.1、3.2、3.4 第 2/3 条中的记账部分、3.6 表里「内容被改写过的项重算指纹」那一格;验收第 3/4/9 条)

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b | 数据模型、关系轴、统一渲染、收尾、逐项方向、派生 lock | **DONE**,均已合入 main |
| **3c** | **本文件** | 逐键扣留的传输语义 |
| 3d | 键级的「一致」:`filesMatch` 蒙键比较(3.3)、指纹快路失效(3.4.3) | 计划未写 |
| 3e | 卡片 `Keys` 区(5.4),键级规则的**写入口** | 计划未写 |
| 3f | 并发(3.7) | 计划未写 |
| 4 | 加密(3.8/3.9) | 未开始 |

**为什么传输在比较之前、UI 在最后:** 传输是这条链上唯一会**写坏数据**的一段(推送把对面的值删掉,是本轮最不能出错的一件事),先把它做对;比较做错只是显示得难看。UI 放最后,是因为在 3c/3d 落地之前给用户一个能设的控件,等于给他一个不生效的开关。

## Global Constraints

- **push 必须保留对面的值,这一条不能省**(spec 3.2)。store 里存的是整份文档,不是补丁。把被扣留的键直接删掉再推,对面 store 里那份就真的没有这个键了,他下次 apply 会把活配置里这个键一并删掉 —— 我们并不想动他的值,结果把他的值删了。
- **对面也没有那个键时,整个省略**(spec 3.2 末句)。同理,拉的时候本地没有那份文件,被扣留的键就不写进来。
- **键级规则只对「文件型项的 JSON 副本」成立**(spec 5.4 的四种没有 Keys 区的情形):文件夹项整包走,非 JSON 文件整份走,整份加密的项整份走。判定放在 `core/keyWithholding.ts` 一处。
- **只有真的有键规则时才改写内容。** 没有规则的项一个字节都不许重新序列化 —— 否则每次推送都会因为格式差异重写全店。
- **字节稳定。** 改写后按 store 的既有约定序列化(`JSON.stringify(x, null, 2) + "\n"`,与 capture 一致),这样内容没变时推送仍然跳过写入。
- **读规则只有一条路**:`core/remoteRules.ts` 的 `keyDirection` / `itemDirection`。本轮新增的模块**不许自己解释 `RemoteItems` 的形状**,只许经由它。
- **lock 绝不学 remote**(spec 3.4 第 1 条)。重算的指纹写进**派生** lock,本地 lock 一个字节不动。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/keyWithholding.ts`(新建) | **唯一**的键级扣留规则:哪些键在这个方向上不流动,以及两份文档如何叠加 |
| `src/core/ConfigSyncCore.ts`(改) | `planImport` 拉侧改写、`applyImport` 记账、`pushExternal` 推侧改写与指纹收集 |
| `src/core/derivedLock.ts`(改) | 被改写过的项按实际发出的内容重算指纹 |
| `tests/keyWithholding.test.ts`(新建) | 纯规则单测 |
| `tests/core.test.ts` / `tests/derivedLock.test.ts`(改) | 三个接线点的行为 |

---

### Task 1:扣留规则与叠加

**Files:**
- Modify: `src/core/remoteRules.ts`(新增 `withheldPatternsFor`)
- Create: `src/core/keyWithholding.ts`
- Test: `tests/remoteRules.test.ts`(续写)、`tests/keyWithholding.test.ts`(新建)

**Interfaces:**
- Consumes:`keyDirection` / 私有的 `ruleFor`(`core/remoteRules.ts`)、`directionFlows`(`core/types.ts`)、`mergePreservingSanitized` / `sanitizeJson` / `isPlainObject`(`core/sanitize.ts`)、`resolveGroupByStoreRel`(`core/pathing.ts`)
- Produces:
  ```ts
  // core/remoteRules.ts —— 「这个 remote 对这一项怎么办」只有这一个回答处
  export function withheldPatternsFor(items: RemoteItems | undefined, ref: ItemRef, dir: "push" | "pull"): string[]

  // core/keyWithholding.ts —— 内容侧
  export function withheldPatternPredicate(items: RemoteItems | undefined, dir: "push" | "pull", ...groupLists: SyncGroup[][]): (rel: string) => string[]
  export function overlayWithheld(input: { rel: string; keep: string | null; take: string; patterns: readonly string[] }): string
  ```

**为什么分两个模块:** 「哪些键在这个方向上不流动」是**规则**问题,`core/remoteRules.ts` 的模块注释已经写死了那条纪律 ——「每个消费者都来这里问,所以『这个 remote 对这一项怎么办』只有一个答案」。「一份文档怎么叠在另一份上」是**内容**问题,与规则无关,归新模块。

**`keep` / `take` 是什么:** `take` 那一侧的值全面胜出,只有匹配扣留模式的键保住 `keep` 那一侧的值(包括只有 `keep` 有的键)。拉的时候 `keep` 是本地那份、`take` 是远端那份;推的时候正好反过来。**一个函数两个方向**,因为这本来就是同一件事,区别只在谁当底稿(spec 3.1 / 3.2 明写这一点)。`keep` 为 `null`(那一侧根本没有这份文件)时,被扣留的键**整个省略**。

- [ ] **Step 1: 写失败测试**

先追加到 `tests/remoteRules.test.ts`(该文件已有 `RULES` 夹具与 `ItemRef` 引入,按其既有写法):

```ts
describe("withheldPatternsFor", () => {
  const KEYED: RemoteItems = {
    community: {
      dataview: { keys: { "*Token*": { direction: "none" }, defaultView: { direction: "push" } } },
      "config-sync": { direction: "pull", keys: { passphrase: { direction: "both" } } },
    },
  };

  it("names the keys that do not travel in the asked direction", () => {
    expect(withheldPatternsFor(KEYED, "community/dataview", "pull").sort()).toEqual(["*Token*", "defaultView"]);
    expect(withheldPatternsFor(KEYED, "community/dataview", "push")).toEqual(["*Token*"]);
  });

  it("intersects with the item's own direction, so a key can never travel further than its item", () => {
    // The item is Pull only; the key says both ways, which resolves to pull — so a PUSH withholds it.
    expect(withheldPatternsFor(KEYED, "community/config-sync", "push")).toEqual(["passphrase"]);
    expect(withheldPatternsFor(KEYED, "community/config-sync", "pull")).toEqual([]);
  });

  it("has nothing to say about an item with no key rules", () => {
    expect(withheldPatternsFor(KEYED, "obsidian/app", "pull")).toEqual([]);
    expect(withheldPatternsFor(undefined, "community/dataview", "pull")).toEqual([]);
  });
});
```

再新建 `tests/keyWithholding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overlayWithheld, withheldPatternPredicate } from "../src/core/keyWithholding";
import { ItemRef, RemoteItems, SyncGroup } from "../src/core/types";

const RULES: RemoteItems = {
  community: {
    dataview: { keys: { "*Token*": { direction: "none" }, defaultView: { direction: "push" } } },
    "config-sync": { direction: "pull", keys: { passphrase: { direction: "both" } } },
  },
};

describe("withheldPatternPredicate", () => {
  const groups: SyncGroup[] = [
    { name: "plugin-dataview", ref: "community/dataview" as ItemRef, path: "{configDir}/plugins/dataview/data.json", type: "file", devices: "all" },
    { name: "snippets", ref: "obsidian/snippets" as ItemRef, path: "{configDir}/snippets", type: "folder", devices: "all" },
    { name: "vimrc", ref: "obsidian/vimrc" as ItemRef, path: ".obsidian.vimrc", type: "file", devices: "all" },
  ];

  it("answers for a file item's JSON store copy, sidecars included", () => {
    const at = withheldPatternPredicate(RULES, "push", groups);
    expect(at("store/configdir/plugins/dataview/data.json")).toEqual(["*Token*"]);
    expect(at("store/configdir/plugins/dataview/data.json.__scopes__.desktop.json")).toEqual(["*Token*"]);
  });

  it("says nothing for a folder item, a non-JSON file, or bookkeeping", () => {
    const rules: RemoteItems = { obsidian: { snippets: { keys: { a: { direction: "none" } } }, vimrc: { keys: { a: { direction: "none" } } } } };
    const at = withheldPatternPredicate(rules, "push", groups);
    expect(at("store/configdir/snippets/one.css")).toEqual([]); // a folder travels whole
    expect(at("store/obsidian.vimrc")).toEqual([]); // no keys in this file
    expect(at("store.lock.json")).toEqual([]);
  });

  it("is a constant answer when the remote has no key rules at all", () => {
    const at = withheldPatternPredicate({ community: { dataview: { direction: "none" } } }, "push", groups);
    expect(at("store/configdir/plugins/dataview/data.json")).toEqual([]);
  });
});

describe("overlayWithheld", () => {
  const call = (keep: string | null, take: string, patterns: string[]): unknown =>
    JSON.parse(overlayWithheld({ rel: "store/configdir/plugins/demo/data.json", keep, take, patterns }));

  it("takes everything except the withheld keys, which stay as the kept side had them", () => {
    expect(call('{"a":1,"secret":"mine"}', '{"a":2,"secret":"theirs"}', ["secret"])).toEqual({ a: 2, secret: "mine" });
  });

  it("keeps a withheld key the taken side does not have at all", () => {
    expect(call('{"a":1,"secret":"mine"}', '{"a":2}', ["secret"])).toEqual({ a: 2, secret: "mine" });
  });

  it("omits a withheld key entirely when the kept side has no copy of the file", () => {
    expect(call(null, '{"a":2,"secret":"theirs"}', ["secret"])).toEqual({ a: 2 });
  });

  it("reaches nested keys, the way every other key rule in this codebase does", () => {
    expect(call('{"o":{"secret":"mine","b":1}}', '{"o":{"secret":"theirs","b":2}}', ["secret"])).toEqual({ o: { secret: "mine", b: 2 } });
  });

  it("writes the store's own JSON shape, so an unchanged item stays byte-identical", () => {
    const out = overlayWithheld({ rel: "r", keep: '{"a":1}\n', take: '{\n  "a": 1\n}\n', patterns: ["secret"] });
    expect(out).toBe('{\n  "a": 1\n}\n');
  });

  it("refuses rather than guessing when a side is not JSON: a rule we cannot honour must not be silently skipped", () => {
    expect(() => overlayWithheld({ rel: "store/configdir/x.json", keep: "{", take: "{}", patterns: ["s"] })).toThrow("store/configdir/x.json");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/keyWithholding.test.ts tests/remoteRules.test.ts`
Expected: FAIL —— `Cannot find module '../src/core/keyWithholding'`,以及 `withheldPatternsFor` 尚未导出。

- [ ] **Step 3: 写实现**

先在 `src/core/remoteRules.ts` 末尾加规则侧那一半(`ruleFor` 就在同一文件里,不必导出):

```ts
// The key patterns this remote does NOT let travel in the asked direction. The pattern IS the key as
// far as a rule is concerned, so the answer comes from `keyDirection` above — already intersected
// with the item's own direction, because a key can never travel further than the item it lives in.
export function withheldPatternsFor(items: RemoteItems | undefined, ref: ItemRef, dir: "push" | "pull"): string[] {
  const keys = ruleFor(items, ref)?.keys;
  if (keys === undefined) return [];
  return Object.keys(keys).filter((pattern) => !directionFlows(keyDirection(items, ref, pattern))[dir]);
}
```

`directionFlows` 从 `./types` 补进该文件既有的 import。

再新建 `src/core/keyWithholding.ts`:

```ts
import { withheldPatternsFor } from "./remoteRules";
import { resolveGroupByStoreRel } from "./pathing";
import { isPlainObject, mergePreservingSanitized, sanitizeJson } from "./sanitize";
import { ItemRef, RemoteItems, SyncGroup } from "./types";

// A key rule can only exist where there are keys: a folder item travels as a whole, and so does a
// file with no JSON in it. Both are structural facts about the item, not choices, and the card says
// so in as many words rather than showing an empty Keys area.
function relCanHaveKeys(rel: string, groups: SyncGroup[][]): { ref: ItemRef } | null {
  if (!rel.endsWith(".json")) return null;
  for (const list of groups) {
    const group = resolveGroupByStoreRel(list, rel);
    if (group === undefined) continue;
    return group.type === "file" && group.ref !== undefined ? { ref: group.ref } : null;
  }
  return null;
}

// The per-rel form, shaped like ConfigSyncCore's `skipRelPredicate` because it answers the same sort
// of question one level down: that one says whether a rel travels at all, this one says which keys
// inside it do not.
export function withheldPatternPredicate(
  items: RemoteItems | undefined,
  dir: "push" | "pull",
  ...groupLists: SyncGroup[][]
): (rel: string) => string[] {
  const anyKeyRules = Object.values(items ?? {}).some((byId) => Object.values(byId).some((rule) => rule.keys !== undefined));
  if (!anyKeyRules) return () => [];
  const memo = new Map<string, string[]>();
  return (rel: string): string[] => {
    const hit = memo.get(rel);
    if (hit !== undefined) return hit;
    const owner = relCanHaveKeys(rel, groupLists);
    const patterns = owner === null ? [] : withheldPatternsFor(items, owner.ref, dir);
    memo.set(rel, patterns);
    return patterns;
  };
}

// Lay one side's document over the other's, holding the withheld keys back. `take` wins every key it
// has; a key matching a withheld pattern keeps `keep`'s value, including one only `keep` has. On a
// PULL `keep` is this vault's store copy and `take` is the remote's; on a PUSH they swap, and that
// swap is the whole difference between the two directions.
//
// `keep: null` means that side has no copy of the file at all, so a withheld key has no value to
// hold on to and is dropped rather than taken from `take` — the far end must not receive a key we
// promised never to send it, and this vault must not receive one we promised never to accept.
export function overlayWithheld(input: { rel: string; keep: string | null; take: string; patterns: readonly string[] }): string {
  const patterns = [...input.patterns];
  const take = parseOrThrow(input.rel, input.take);
  const kept = input.keep === null ? null : parseOrThrow(input.rel, input.keep);
  const merged = kept === null ? sanitizeJson(take, patterns) : mergePreservingSanitized(kept, take, patterns);
  // The store's own JSON shape (capture writes exactly this), so an item whose merged content did
  // not change is byte-identical to what is already there and the seam skips the write.
  return JSON.stringify(merged, null, 2) + "\n";
}

// A file we cannot parse is a rule we cannot honour, and honouring it is the whole point: pushing
// the file whole would hand the far end a key we promised to withhold. Refuse, naming the file.
function parseOrThrow(rel: string, raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${rel} has per-key rules for this remote but is not valid JSON, so those keys cannot be held back: ${(e as Error).message}`);
  }
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) {
    throw new Error(`${rel} has per-key rules for this remote but holds no keys to apply them to`);
  }
  return parsed;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/keyWithholding.test.ts tests/remoteRules.test.ts`
Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/remoteRules.ts src/core/keyWithholding.ts tests/keyWithholding.test.ts tests/remoteRules.test.ts
git commit -m "feat(core): the keys a remote holds back, and how two copies lay over each other"
```

---

### Task 2:拉

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`planImport` 约 `:1466`、`PendingPull` 约 `:1437`、`applyImport` 的条目采纳段约 `:1596`)
- Test: `tests/core.test.ts`(`describe("planImport")` / `describe("applyImport")` 续写)

**Interfaces:**
- Consumes:`withheldPatternPredicate` / `overlayWithheld`(Task 1)
- Produces:
  - `planImport(ctx, reader, opts: { skipRefs: ItemRef[]; withheldPull: (rel: string) => string[] })`
  - `PendingPull` 新增 `mergedRefs: string[]` —— 这次拉取里内容被改写过的项
  - `applyImport` 对 `mergedRefs` 里的项**不照搬对面的条目**,改为按合并后的实际内容重新盖章

**为什么记账必须跟着改(spec 3.4 第 2 条):** 今天对远端 lock 条目是原样照搬,理由写在注释里 ——「这些条目描述的就是我逐字节拷贝过来的内容」。带扣留键的项不再成立:拿到的是「他那份,但某些键还是我的」,谁的条目都不描述它。代码里已有同形状的分支(用户选了保留本地的冲突项走的就是重新盖章),复用它。

- [ ] **Step 1: 写失败测试**

追加到 `tests/core.test.ts`:

```ts
describe("pull with per-key withholding", () => {
  const RULES: RemoteItems = { community: { demo: { keys: { localOnly: { direction: "none" } } } } };
  const MANIFEST_DEMO = JSON.stringify({
    version: 1,
    groups: [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }],
  });

  it("takes the remote's other keys and leaves a withheld key at this vault's own value", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "mine", localOnly: "keep-me" }, null, 2) + "\n",
    });
    await seedGroups(ctx, MANIFEST_DEMO);
    const groups = await readGroups(ctx);
    const reader = fakeReader({
      "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "theirs", localOnly: "theirs" }, null, 2) + "\n",
    });
    const withheldPull = withheldPatternPredicate(RULES, "pull", groups);
    const pending = await planImport(ctx, reader, { skipRefs: [], withheldPull });
    await applyImport(ctx, pending, []);
    const written = JSON.parse(await io.read("cs/store/configdir/plugins/demo/data.json"));
    expect(written).toEqual({ theme: "theirs", localOnly: "keep-me" });
  });

  it("writes nothing when only the withheld key differs", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "same", localOnly: "mine" }, null, 2) + "\n",
    });
    await seedGroups(ctx, MANIFEST_DEMO);
    const groups = await readGroups(ctx);
    const reader = fakeReader({
      "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "same", localOnly: "theirs" }, null, 2) + "\n",
    });
    const pending = await planImport(ctx, reader, { skipRefs: [], withheldPull: withheldPatternPredicate(RULES, "pull", groups) });
    expect(pending.plan.auto.writeFiles).toEqual([]);
    expect(pending.plan.conflicts).toEqual([]);
  });

  it("re-stamps a merged item instead of adopting the remote's entry for it", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "mine", localOnly: "keep-me" }, null, 2) + "\n",
    });
    await seedGroups(ctx, MANIFEST_DEMO);
    const groups = await readGroups(ctx);
    const remoteLock = JSON.stringify({
      capturedAt: "2026-08-01T00:00:00.000Z",
      items: { community: { demo: { ...pluginSource("9.9.9"), hash: "sha256:theirs", capturedAt: "2026-08-01T00:00:00.000Z" } } },
      version: 3,
    });
    const reader = fakeReader({
      "store.lock.json": remoteLock,
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "theirs", localOnly: "theirs" }, null, 2) + "\n",
    });
    const pending = await planImport(ctx, reader, { skipRefs: [], withheldPull: withheldPatternPredicate(RULES, "pull", groups) });
    await applyImport(ctx, pending, []);
    const lock = parseStoreLock(await io.read("cs/store.lock.json"), groups);
    const entry = lockEntry(lock, "community/demo");
    // Their fingerprint describes their file; we hold a hybrid, so ours describes it instead.
    expect(entry?.hash).not.toBe("sha256:theirs");
    expect(entry?.capturedAt).toBe(ctx.now());
    // What the entry SAYS about the item — where it came from — is still theirs to tell.
    expect(entry?.source).toEqual({ kind: "plugin", version: "9.9.9" });
  });
});
```

`fakeReader` / `readGroups` / `pluginSource` / `parseStoreLock` / `lockEntry` 该文件均已有;`RemoteItems` 从 `../src/core/types` 引入,`withheldPatternPredicate` 从 `../src/core/keyWithholding` 引入。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.ts -t "pull with per-key withholding"`
Expected: FAIL —— `planImport` 还不认识 `withheldPull` 这个参数(类型错),三条全红。

- [ ] **Step 3: 写实现**

`planImport`:选项加一个必填字段(与 `skipRefs` 同一条纪律:没有默认值,调用方必须说明它要什么),在建远端文件映射时叠加:

```ts
export async function planImport(
  ctx: CoreContext,
  reader: ExternalStoreReader,
  opts: { skipRefs: ItemRef[]; withheldPull: (rel: string) => string[] }
): Promise<PendingPull> {
```

```ts
  const remoteFileMap = new Map<string, string>();
  const mergedRefs = new Set<string>();
  for (const rel of files) {
    if (rel === LOCK_REL || isLegacyManifestRel(rel) || skipped(rel)) continue;
    const raw = await reader.readFile(rel);
    const patterns = opts.withheldPull(rel);
    if (patterns.length === 0) {
      remoteFileMap.set(rel, raw);
      continue;
    }
    // What lands in the plan is the MERGED content, not theirs: the planner's job is to describe
    // what a pull would write, and this is what it would write. It also settles the comparison for
    // free — a file whose only difference is a withheld key now equals ours and never shows up.
    const localAbs = `${ctx.rootPath}/${rel}`;
    const keep = (await ctx.io.exists(localAbs)) ? await ctx.io.read(localAbs) : null;
    remoteFileMap.set(rel, overlayWithheld({ rel, keep, take: raw, patterns }));
    const ref = resolveGroupByStoreRel(localGroups, rel)?.ref ?? resolveGroupByStoreRel(remoteGroups, rel)?.ref;
    if (ref !== undefined) mergedRefs.add(ref);
  }
```

返回值带上它:

```ts
  return { plan, remoteGroups, remoteLockRaw, remoteFiles: files, skipRefs: opts.skipRefs, mergedRefs: [...mergedRefs] };
```

`PendingPull` 补字段与注释:

```ts
  // The items whose remote content this plan REWROTE, because some of their keys do not pull with
  // this remote. Carried for the bookkeeping: their content is a hybrid of both sides, so the
  // remote's lock entry does not describe what we are about to hold (see applyImport).
  mergedRefs: string[];
```

`applyImport` 的采纳循环,加一道与 `localWonRefs` 并列的门:

```ts
    const mergedRefs = new Set<string>(pending.mergedRefs);
```

```ts
      for (const [ref, entry] of lockEntryList(remoteLock.items)) {
        if ((pending.skipRefs as string[]).includes(ref)) continue;
        if (localWonRefs.has(ref)) continue;
        // A merged item's content is neither side's, so neither side's fingerprint describes it.
        // Its entry is seeded from theirs — where the item came from is still theirs to tell — and
        // the restamp loop below replaces the two fields that describe CONTENT.
        if (mergedRefs.has(ref)) {
          const carried = lockEntryTail(lockEntry(localLock, ref));
          for (const key of Object.keys(entry)) delete carried[key];
          setLockEntry(mergedItems, ref, { ...entry, ...carried });
          continue; // deliberately NOT added to adoptedRefs: the restamp below must reach it
        }
        ...
      }
```

重新盖章那一段今天的门是 `!hasChanges(r.changes)` 就跳过 —— 合并结果与本地相同时确实什么都没写,条目也就不该动,这正是我们要的行为,不必改。

`resolveGroupByStoreRel` 该文件已 import;`overlayWithheld` 从 `./keyWithholding` 补 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core.test.ts -t "pull with per-key withholding"`
Expected: PASS(3 条)。

- [ ] **Step 5: 跟上所有调用点**

`planImport` 的选项多了一个必填字段,现有调用点全要跟:

Run: `npx vitest run`
Expected: 类型错先由 `npx tsc --noEmit` 暴露。逐个改:
- `src/main.ts` 的 `pullFrom`:`withheldPull: withheldPatternPredicate(remote.items, "pull", this.compiledGroups)` —— 注意它要的是**已编译的本地清单**,与 `refsBlockedFor` 同一个 `remote.items` 来源。
- 测试里的其余调用点一律传 `withheldPatternPredicate(undefined, "pull")`,读起来就是「这个 remote 没有键规则」。

- [ ] **Step 6: 提交**

```bash
git add src/core src/main.ts tests
git commit -m "feat(pull): a key you hold back keeps this vault's own value"
```

---

### Task 3:推,以及它送出去的指纹

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`pushExternal` 的写循环与末尾的派生 lock 段)
- Modify: `src/core/derivedLock.ts`(新增 `rewrittenHashes` 入参)
- Test: `tests/core.test.ts`、`tests/derivedLock.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function derivedPushLock(input: {
    local: StoreLock;
    remote: StoreLock | null;
    skipRefs: readonly string[];
    rewrittenHashes: ReadonlyMap<string, string | null>; // ref -> fingerprint of what we actually sent; null = not fingerprintable
  }): StoreLock
  ```
  `pushExternal(ctx, writer, opts: { skipRefs: ItemRef[]; withheldPush: (rel: string) => string[] })`

**为什么指纹必须重算(spec 3.6):** lock 文件本身就是被推送的文件之一,而它正是对面设备判断「我和我的 remote 谁更新」的依据。带扣留键的项,我们发出去的内容不是本地那份;把本地的指纹原样发过去,对面就拿到一本指纹与自己文件对不上的账本。

- [ ] **Step 1: 写失败测试**

`tests/derivedLock.test.ts` 顶部加一个包装,免得十条既有测试各自补一遍空 Map:

```ts
const derived = (input: Omit<Parameters<typeof derivedPushLock>[0], "rewrittenHashes"> & { rewrittenHashes?: ReadonlyMap<string, string | null> }): StoreLock =>
  derivedPushLock({ rewrittenHashes: new Map(), ...input });
```

把既有十条里的 `derivedPushLock(` 换成 `derived(`,再追加两条:

```ts
  it("fingerprints a rewritten item by what was actually sent, not by what we hold", () => {
    const local = lock(t1, { community: { demo: { hash: "sha256:mine", capturedAt: t1 } } });
    const out = derived({ local, remote: null, skipRefs: [], rewrittenHashes: new Map([["community/demo", "sha256:sent"]]) });
    expect(out.items["community"]?.["demo"]?.hash).toBe("sha256:sent");
  });

  it("drops the fingerprint of a rewritten item that cannot be fingerprinted at all", () => {
    const local = lock(t1, { community: { demo: { hash: "sha256:mine", capturedAt: t1 } } });
    const out = derived({ local, remote: null, skipRefs: [], rewrittenHashes: new Map([["community/demo", null]]) });
    expect(out.items["community"]?.["demo"]).toEqual({ capturedAt: t1 });
  });
```

`tests/core.test.ts` 的 `describe("pushExternal")` 追加:

```ts
  it("withheld key: the far end keeps its own value, and everything else of ours lands", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { community: { demo: { ...pluginSource("1.0.0"), hash: "sha256:mine" } } }, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "mine", localOnly: "mine" }, null, 2) + "\n",
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }] }));
    const groups = await readGroups(ctx);
    const fw = fakeWriter({
      "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "theirs", localOnly: "theirs" }, null, 2) + "\n",
    });
    const rules: RemoteItems = { community: { demo: { keys: { localOnly: { direction: "none" } } } } };
    await pushExternal(ctx, fw.writer, { skipRefs: [], withheldPush: withheldPatternPredicate(rules, "push", groups) });
    expect(JSON.parse(fw.files["store/configdir/plugins/demo/data.json"] ?? "")).toEqual({ theme: "mine", localOnly: "theirs" });
    // The bookkeeping we sent describes THAT file, not the one on this device.
    const pushed = parseStoreLock(fw.files["store.lock.json"] ?? "");
    expect(pushed.items["community"]?.["demo"]?.hash).not.toBe("sha256:mine");
  });

  it("writes nothing when only a withheld key differs", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { community: { demo: { ...pluginSource("1.0.0") } } }, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "same", localOnly: "mine" }, null, 2) + "\n",
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }] }));
    const groups = await readGroups(ctx);
    const rules: RemoteItems = { community: { demo: { keys: { localOnly: { direction: "none" } } } } };
    const fw = fakeWriter({
      "store.lock.json": JSON.stringify({ capturedAt: "t", items: { community: { demo: { ...pluginSource("1.0.0") } } }, version: 3 }),
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "same", localOnly: "theirs" }, null, 2) + "\n",
    });
    await pushExternal(ctx, fw.writer, { skipRefs: [], withheldPush: withheldPatternPredicate(rules, "push", groups) });
    expect(fw.writeLog).not.toContain("store/configdir/plugins/demo/data.json");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/derivedLock.test.ts tests/core.test.ts -t "withheld"`
Expected: FAIL —— `pushExternal` 不认识 `withheldPush`;`derivedPushLock` 不认识 `rewrittenHashes`。

- [ ] **Step 3: 写实现**

`derivedLock.ts`,先把 `rewrittenHashes` 加进入参与开头那行解构(`const { local, remote, skipRefs, rewrittenHashes } = input;`),再在写我们自己的条目那一步套上重算的指纹:

```ts
  for (const [ref, entry] of lockEntryList(local.items)) {
    if (withheld.has(ref)) continue;
    const carried = lockEntryTail(lockEntry(remote, ref));
    for (const key of Object.keys(entry)) delete carried[key];
    const sent: StoreLockEntry = { ...entry, ...carried };
    // An item whose content we rewrote on the way out (some of its keys stay behind) is not
    // described by our fingerprint — the far end holds a different file, and its own devices read
    // this entry to decide whether they are behind. `null` = not fingerprintable at all, and an
    // absent fingerprint is never a difference, so the field goes rather than lying.
    if (rewrittenHashes.has(ref)) {
      const hash = rewrittenHashes.get(ref) ?? null;
      if (hash === null) delete sent.hash;
      else sent.hash = hash;
    }
    setLockEntry(items, ref, sent);
  }
```

`pushExternal` 的写循环:

```ts
  const rewritten = new Map<string, Record<string, string>>(); // ref -> rel -> the content we sent
  for (const rel of pushableRels) {
    if (rel === LOCK_REL) continue;
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    const mine = await ctx.io.read(`${ctx.rootPath}/${rel}`);
    const existed = remoteFiles.has(rel);
    const theirs = existed ? await writer.readFile(rel) : null;
    const patterns = opts.withheldPush(rel);
    // Their value for a withheld key is not ours to delete: the store holds whole documents, not
    // patches, so sending the file without that key would make their next Apply drop it from their
    // live config. Push already reads their copy (for the skip-if-identical test below), so this
    // costs nothing new.
    const content = patterns.length === 0 ? mine : overlayWithheld({ rel, keep: theirs, take: mine, patterns });
    if (patterns.length > 0) {
      const ref = resolveGroupByStoreRel(manifest.groups, rel)?.ref;
      if (ref !== undefined) rewritten.set(ref, { ...(rewritten.get(ref) ?? {}), [rel]: content });
    }
    if (existed && theirs === content) continue; // unchanged: skip the write
    await writer.writeFile(rel, content);
    const result = resultFor(name);
    result.filesWritten.push(rel);
    (existed ? result.changes.updated : result.changes.added).push(itemRel);
  }
```

派生 lock 之前,把每个被改写的项的**实际发出内容**折成一个指纹。文件型项的指纹算法是「主文件 + 各 class 的 sidecar」,`fileStoreCopyHash` 已经是这条规则的唯一实现,直接喂它:

```ts
  // The fingerprint of what we SENT, per rewritten item. Same hashing rule as everywhere else
  // (fileStoreCopyHash), fed the content this run produced rather than the copy on disk.
  const rewrittenHashes = new Map<string, string | null>();
  for (const [ref, byRel] of rewritten) {
    const group = manifest.groups.find((g) => g.ref === ref);
    if (group === undefined) continue;
    if (!storeContentIsHashable(group)) {
      rewrittenHashes.set(ref, null);
      continue;
    }
    const storeRel = `store/${groupStorePath(group.path)}`;
    const base = byRel[storeRel];
    if (base === undefined) {
      rewrittenHashes.set(ref, null); // we rewrote only sidecars: no base to anchor the hash
      continue;
    }
    const sidecars: Record<"desktop" | "mobile", string | null> = { desktop: null, mobile: null };
    for (const cls of DEVICE_CLASSES) sidecars[cls] = byRel[storeRel + sidecarStoreSuffix(cls)] ?? null;
    rewrittenHashes.set(ref, await fileStoreCopyHash(group.name, base, sidecars));
  }
```

**注意 sidecar 的一个坑:** 上面只把**这次改写过**的 sidecar 放进 `byRel`。一个项若有 sidecar 而它没有被改写(不可能 —— 同一项的规则对它的每个 JSON rel 都成立),`sidecars` 会缺一份,指纹就与实际发出的内容不符。实现时按上面的写法(同项的所有 JSON rel 都会进 `rewritten`)是自洽的;**如果你改了 `relCanHaveKeys` 的判定范围,这里要一起改。**

最后把它传下去:

```ts
    const derived = derivedPushLock({
      local: parseStoreLock(localLockRaw, manifest.groups),
      remote: parsedOrNull(remoteLockRaw, manifest.groups),
      skipRefs: opts.skipRefs,
      rewrittenHashes,
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/derivedLock.test.ts` 与 `npx vitest run tests/core.test.ts -t "pushExternal"`
Expected: 全 PASS。

- [ ] **Step 5: 跟上所有调用点**

`src/main.ts` 的 `pushTo`:`withheldPush: withheldPatternPredicate(remote.items, "push", this.compiledGroups)`;测试里其余调用点传 `withheldPatternPredicate(undefined, "push")`。

Run: `npx tsc --noEmit`、`npx vitest run`、`npx eslint .`
Expected: 三绿,lint 不超基线。

- [ ] **Step 6: 提交**

```bash
git add src tests
git commit -m "feat(push): a key you hold back keeps whatever the far end already has"
```

---

### Task 4:真机冒烟

**Files:** 无(验证任务)

夹具与 3b 同一套(scratchpad 里的 `remote-vault2`,配方见 memory)。键级规则**还没有 UI**(3e 才有),所以本轮用 `obsidian eval` 直接写进 `settings.remotes[0].items` 再 `saveSettings()` —— 写的是与将来那个控件完全相同的持久化形状。

- [ ] **Step 1: 装上并重载**

Run: `npm run smoke:install`,再在 `dev/vault` 下 `obsidian command id=app:reload`。

- [ ] **Step 2: 给一个项设一个不流动的键**

挑一个两边都有、且是文件型 JSON 的项(例如 `plugin-dataview`),给它一个键规则 `direction: "none"`,并在**两边**给那个键不同的值。

- [ ] **Step 3: 推(spec 验收第 4 条)**

推送后**去对面 vault 核对那个键**:值必须原封未动;同一份文件里其它键是我们的。**这一条必须真机比对,不能只看本地报告。**

- [ ] **Step 4: 拉(spec 验收第 3 条)**

在对面改那个键,回来 Pull:其它键进来,该键本地值纹丝不动。

- [ ] **Step 5: 稳态(spec 验收第 5 条)**

反复拉推同一项:不出现「推完还有差异、拉完还有差异」的常亮态 —— **注意本轮只保证 `Pull` / `Push` 按钮跑完不再写文件;面板行上的常亮态要等 3d**(见下面的边界)。

- [ ] **Step 6: 账本(spec 验收第 9 条前半)**

去对面核对 `store.lock.json`:被改写过的那一项,其指纹与对面自己的文件对得上 —— 验法:在对面那份 store 上重新算一遍该项的指纹(或直接确认「连推两次,第二次不写任何文件」,那正是指纹自洽的可观测后果)。

---

### Task 5:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(模块清单补 `core/keyWithholding.ts`;Transport 一节补两侧合并)
- Modify: `docs/GUIDE.md`(Transport 一节)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

- [ ] **Step 1: ARCHITECTURE.md**

模块清单在 `core/derivedLock.ts` 旁边新增 `core/keyWithholding.ts`:一个方向上哪些键不流动,以及两份文档如何叠加(`keep` / `take` 的含义、`keep: null` 为什么是丢弃而不是接受)。Transport 一节写明三个接线点,以及**为什么推送必须先读对面的值**:store 存的是整份文档而不是补丁,删键等于替对面删他的设置。

- [ ] **Step 2: GUIDE.md**

Transport 一节补一段(用户视角):你可以让一个项里的某个键不去某个 remote,或不从它进来。**你扣下的键,对面那份保持他自己的值** —— 不是被清空。同样,他那边的这个键也进不了你这儿。

- [ ] **Step 3: CHANGELOG.md**

2.25.0 追加:

> Added holding a single setting back from a remote instead of the whole item. Pull takes everything else and leaves your value where it is; Push sends everything else and leaves **their** value where it is — a key you hold back is never blanked out on the other side, which is what would happen if it were simply left out

- [ ] **Step 4: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: what a held-back key does on each side of a run"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超基线 0 error / 57 warn)。
- Task 4 六步全过,其中第 3/4 步是 spec 验收第 3/4 条。
- **没有键规则的项一个字节都没被重新序列化**:连推两次,第二次不写任何文件(与 3b 的稳态检查同法)。
- 本地 `store.lock.json` 在推送里字节未变。

## 交给 3d / 3e / 3f 的边界

- **面板上的常亮态本轮不消除。** `diffRemote` 的 `filesMatch`(`core/status.ts:583`)仍在比字节,所以一个带扣留键的项在**卡片的 Files 里**会一直显示有差异,即使 Pull/Push 都已无事可做。3d 用同一套 `withheldPatternsFor` 给它蒙上键再比。
- **指纹快路**(spec 3.4.3)也在 3d:`itemFreshness` 今天「两侧都有指纹且相等就判等」,而这类项的指纹按设计永不相等,必须把「这一项对这个 remote 有没有键规则」作为输入传进去。
- **键级规则的写入口**(卡片 `Keys` 区,spec 5.4)在 3e。在那之前只能手写 `data.json`,本轮的冒烟就是这么做的。
- **并发**(3.7)在 3f。
- **加密项的键级扣留**(spec 3.9 第四个使用点)属于 Plan 4:异密码时「只搬密文串」的便利没有了,每个加密字段都要过一遍明文。本轮的 `overlayWithheld` 只处理明文 JSON;整份加密的项由 `relCanHaveKeys` 之外的既有规则挡掉。
