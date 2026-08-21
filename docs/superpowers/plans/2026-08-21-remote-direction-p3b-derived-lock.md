# 2.25.0 · Plan 3b:派生 lock —— 送出去的账本描述我们真正送出去的东西 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 推送不再把本地 `store.lock.json` 原样发给对面。发出去的是一份**派生 lock**:参与这次推送的项用我们的条目,没参与的项**保留对面原来那条**,`syncedWatermark` 也留对面的。本地 lock 一个字节不动。

**Architecture:** 一个纯函数 `derivedPushLock({local, remote, skipRefs})` 加一处接线。`pushExternal` 今天把 `store.lock.json` 当成普通文件走内容循环 —— 改成把它从循环里摘出来,在内容写完之后按上面的规则算出内容再写。规则不引入新格式:输出仍是一份 `store.lock.json`,字段一个不多一个不少(spec 3.6)。`skipRefs` 直接沿用 `pushExternal` 已经算好的那一套 —— 它同时包含**规则扣下的项**(`Neither way` / `Pull only`)和**这次运行没勾的行**,而两者对账本的要求是同一条:**这次没送出去的内容,不该由我们的条目去描述**。

**Tech Stack:** TypeScript(strict)、vitest。`core/derivedLock.ts` 零 IO、零 DOM,可纯单测。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 3.4 第 4 条与 3.6 整节;验收第 9 条)

## Plan 3 拆分的一次修订

3a 结尾把「逐键扣留的一切」都划给 3b。写计划时发现**派生 lock 并不依赖逐键扣留**,而逐键扣留依赖的东西比预想多,于是拆开:

| # | 计划 | 为什么单独成篇 |
|---|---|---|
| **3b** | **派生 lock(本文件)** | 3a 一落地,四档规则就在真实推送里生效了,而账本仍整份覆盖 —— 这是**今天就在发生的缺陷**(`excludeSelf` 那条已经这样错了一年),且与键级规则无关。自己就能真机验收(spec 验收第 9 条) |
| 3c | 逐键扣留 | 合并语义(3.1/3.2)、pull 后重新盖章(3.4.2)、指纹快路(3.4.3),**外加卡片的 `Keys` 区(5.4)** —— 没有那块 UI,键级规则根本没有写入口,真机验收第 3/4 条无从做起。派生 lock 的「内容被改写过的项按实际发出内容重算指纹」那一格也在这里补上 |
| 3d | 并发 | vault 类型的写前复核、过期判断中止(3.7) |

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a | 数据模型、关系轴、统一渲染、收尾、逐项方向 | **DONE**,均已合入 main |
| **3b** | **本文件** | 派生 lock |
| 3c / 3d | 逐键扣留 / 并发 | 计划未写 |
| 4 | 加密 | 未开始 |

## Global Constraints

- **lock 绝不学 remote**(spec 3.4 第 1 条)。派生 lock 里不许出现任何与 remote 有关的新字段 —— 它是被推送的文件之一,任何 remote 字段推到对面都指向一个不存在的 remote。这是禁令,不是省事。
- **没有新格式**(spec 3.6)。输出是一份 `store.lock.json`,字段一个不多一个不少,只是值按表算出来。`store-lock.schema.json` **不改**。
- **本地 lock 一个字节不动。** 派生只发生在推送的写路径上。
- **`syncedWatermark` 保留对面原有的值**(spec 3.6)。它的定义是「这个 store 跟到了它所拉取的 remote 的哪一步,只有 pull 会推动它」,我们的推送不是他们的 pull。**这是对今天行为的修正。**
- **稳态必须安静。** 内容没变时连推两次,第二次不许重写 lock(否则 git 每次被搅一遍,面板那一行也到不了 `In sync`)。派生输出的字段序与 capture 写盘的一致,加 `JSON.stringify(x, null, 2) + "\n"`,靠 `pushExternal` 既有的「内容相同则跳过」达成。
- **未知字段照旧往两个方向都保住**(既有的 carrying 纪律):对面条目里我们不认识的字段随推送回去,不被剥掉。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/derivedLock.ts`(新建) | **唯一**的派生规则实现。纯函数,输入是两份已解析的 `StoreLock` 与跳过集,输出一份 `StoreLock`。放在独立模块而不是塞进 `ConfigSyncCore.ts`:它零 IO,而 `ConfigSyncCore.ts` 已经是本仓最大的文件 |
| `src/core/ConfigSyncCore.ts`(改) | `pushExternal` 把 `store.lock.json` 从内容循环里摘出来,改由派生规则写 |
| `tests/derivedLock.test.ts`(新建) | 纯规则的单测 |
| `tests/core.test.ts`(改) | `pushExternal` 那个 describe 续写接线后的行为;一处既有断言随之更新 |

---

### Task 1:派生规则

**Files:**
- Create: `src/core/derivedLock.ts`
- Test: `tests/derivedLock.test.ts`

**Interfaces:**
- Consumes:`lockEntry` / `lockEntryList` / `lockEntryTail` / `lockTail` / `lockWatermark` / `derivedLockCapturedAt` / `setLockEntry` / `STORE_LOCK_VERSION`(均在 `core/manifest.ts`),类型 `StoreLock` / `LockItems`(`core/types.ts`)
- Produces:
  ```ts
  export function derivedPushLock(input: {
    local: StoreLock;
    remote: StoreLock | null;
    skipRefs: readonly string[];
  }): StoreLock
  ```

**规则表(spec 3.6,逐格实现):**

| 字段 | 规则 |
|---|---|
| 参与推送的项的条目 | 取我们的 |
| 不参与推送的项的条目 | **保留对面原有的条目**;对面没有就不写 |
| 只有对面才有的项(不在跳过集里) | **不写** —— 推送会镜像删除它的文件,留着条目就是描述一份已经不存在的内容 |
| 顶层 `capturedAt` | 派生值:合并后条目集里最新的捕获时间 |
| `syncedWatermark` | 保留对面原有的值;对面没有 lock 时才用我们的 |
| `version` | `STORE_LOCK_VERSION`(对面是旧格式时,条目已由 `parseStoreLock` 重新键入) |

- [ ] **Step 1: 写失败测试**

新建 `tests/derivedLock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { derivedPushLock } from "../src/core/derivedLock";
import { LockItems, StoreLock } from "../src/core/types";

const t0 = "2026-08-01T00:00:00.000Z";
const t1 = "2026-08-02T00:00:00.000Z";
const t2 = "2026-08-03T00:00:00.000Z";

// `StoreLock` carries an index signature for its unknown top-level keys, so the tail spreads in
// without a cast — and `LockItems` keeps the entries honestly typed rather than asserted into shape.
const lock = (capturedAt: string, items: LockItems, tail: Record<string, unknown> = {}): StoreLock => ({ capturedAt, items, ...tail });

describe("derivedPushLock", () => {
  it("sends our entry for an item this push sends", () => {
    const local = lock(t1, { community: { dataview: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { community: { dataview: { hash: "theirs", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["community"]?.["dataview"]).toEqual({ hash: "mine", capturedAt: t1 });
  });

  it("keeps the far end's own entry for an item this push does not send", () => {
    const local = lock(t1, { community: { "config-sync": { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { community: { "config-sync": { hash: "theirs", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.items["community"]?.["config-sync"]).toEqual({ hash: "theirs", capturedAt: t0 });
  });

  it("writes no entry at all for a withheld item the far end has never had", () => {
    const local = lock(t1, { community: { "config-sync": { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, {});
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.items["community"]?.["config-sync"]).toBeUndefined();
  });

  it("drops an entry only the far end has: push mirror-deletes that item's files", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { obsidian: { app: { hash: "theirs", capturedAt: t0 } }, community: { gone: { hash: "g", capturedAt: t0 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["community"]?.["gone"]).toBeUndefined();
  });

  it("carries a field only their entry had onto the entry we send", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t1 } } });
    const remote = lock(t0, { obsidian: { app: { hash: "theirs", capturedAt: t0, futureField: 7 } } });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.items["obsidian"]?.["app"]).toEqual({ hash: "mine", capturedAt: t1, futureField: 7 });
  });

  it("leaves their watermark where it is — our push is not their pull", () => {
    const local = lock(t1, {}, { syncedWatermark: t1 });
    const remote = lock(t0, {}, { syncedWatermark: t2 });
    expect(derivedPushLock({ local, remote, skipRefs: [] }).syncedWatermark).toBe(t2);
  });

  it("uses our own watermark only when the far end has no lock at all", () => {
    const local = lock(t1, {}, { syncedWatermark: t1 });
    expect(derivedPushLock({ local, remote: null, skipRefs: [] }).syncedWatermark).toBe(t1);
  });

  it("derives capturedAt from the entries it actually wrote, kept ones included", () => {
    const local = lock(t1, { obsidian: { app: { hash: "mine", capturedAt: t0 } } });
    const remote = lock(t0, { community: { "config-sync": { hash: "theirs", capturedAt: t2 } } });
    const out = derivedPushLock({ local, remote, skipRefs: ["community/config-sync"] });
    expect(out.capturedAt).toBe(t2);
  });

  it("declares the format this build writes", () => {
    expect(derivedPushLock({ local: lock(t1, {}), remote: null, skipRefs: [] }).version).toBe(3);
  });

  it("keeps an unknown top-level key from either side, the far end's winning a collision", () => {
    const local = lock(t1, {}, { mineOnly: 1, shared: "ours" });
    const remote = lock(t0, {}, { theirsOnly: 2, shared: "theirs" });
    const out = derivedPushLock({ local, remote, skipRefs: [] });
    expect(out.mineOnly).toBe(1);
    expect(out.theirsOnly).toBe(2);
    expect(out.shared).toBe("theirs");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/derivedLock.test.ts`
Expected: FAIL —— `Cannot find module '../src/core/derivedLock'`。

- [ ] **Step 3: 写实现**

新建 `src/core/derivedLock.ts`:

```ts
import {
  derivedLockCapturedAt,
  lockEntry,
  lockEntryList,
  lockEntryTail,
  lockTail,
  lockWatermark,
  setLockEntry,
  STORE_LOCK_VERSION,
} from "./manifest";
import { LockItems, StoreLock } from "./types";

// The lock a push SENDS, which is not the lock this device HAS. The file describes the store the far
// end will be holding once this push lands, and a push does not send everything: an item withheld by
// this remote's rules, or simply left unticked for this run, keeps whatever is already over there.
// Our entry for such an item would fingerprint a file we never wrote — and that entry is exactly what
// the far end's own devices read to decide whether they are behind (spec 3.4.4 / 3.6).
//
// No new format: the result is a store.lock.json, field for field. Only the values are computed
// differently, so the lock's schema stays where it is. The local lock is never touched.
export function derivedPushLock(input: {
  local: StoreLock;
  remote: StoreLock | null;
  skipRefs: readonly string[];
}): StoreLock {
  const { local, remote, skipRefs } = input;
  const withheld = new Set<string>(skipRefs);
  const items: LockItems = {};
  for (const [ref, entry] of lockEntryList(local.items)) {
    if (withheld.has(ref)) continue;
    // A field only THEIR entry carried is not ours to drop — the same carry applyImport performs in
    // the other direction, so a newer build's per-item field survives a round trip through us.
    const carried = lockEntryTail(lockEntry(remote, ref));
    for (const key of Object.keys(entry)) delete carried[key];
    setLockEntry(items, ref, { ...entry, ...carried });
  }
  // Their entries for the items we withheld. Iterating THEIR lock rather than the skip set keeps the
  // output order a function of the two documents alone — a stable byte sequence is what lets an
  // unchanged push skip the write entirely. An item only they have and we did not withhold is
  // deliberately absent: push mirror-deletes its files, so an entry would describe nothing.
  if (remote !== null) {
    for (const [ref, entry] of lockEntryList(remote.items)) {
      if (withheld.has(ref)) setLockEntry(items, ref, entry);
    }
  }
  // Field order follows parseStoreLock's, the same as capture's and the pull merge's: capturedAt,
  // items, then the tail with version/syncedWatermark riding it.
  return {
    capturedAt: derivedLockCapturedAt(items, [], local.capturedAt),
    items,
    version: STORE_LOCK_VERSION,
    // Only a pull moves a watermark, and this push is not their pull. Overwriting it with ours —
    // what a verbatim push does today — tells their devices they have already seen a lineage they
    // never pulled, and that claim then suppresses a pull they actually need.
    syncedWatermark: remote !== null ? lockWatermark(remote) : lockWatermark(local),
    // Unknown TOP-LEVEL keys from both sides, THEIRS winning a collision. The mirror of the pull
    // merge's rule and the same argument: the file being written belongs to the store it describes,
    // and this one describes theirs. A key only we carry still rides over rather than being dropped.
    ...lockTail(local),
    ...lockTail(remote),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/derivedLock.test.ts`
Expected: PASS(10 个)。

- [ ] **Step 5: 提交**

```bash
git add src/core/derivedLock.ts tests/derivedLock.test.ts
git commit -m "feat(core): the lock a push sends describes the store the far end will have"
```

---

### Task 2:推送改用它

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`pushExternal`,约 `:1688-1744`)
- Test: `tests/core.test.ts`(`describe("pushExternal")`,约 `:1679`)

**Interfaces:**
- Consumes:`derivedPushLock`(Task 1)、`parseStoreLock`(`core/manifest.ts`)
- Produces:`pushExternal` 签名不变。行为变化三条:(1) `store.lock.json` 不再走内容循环;(2) 远端 lock 只读一次,版本闸与派生共用同一份字节;(3) 本地 lock 无法解析时推送**明确失败**,不再把一份坏账本推给对面。

**今天错在哪(一句话):** 一个设了 `excludeSelf` 的 remote,push 跳过 self 的内容文件、也豁免它的镜像删除,**却仍然把本地 lock 原样推过去** —— 对面 lock 里的 self 条目被我们的覆盖,描述的是一份我们根本没发的文件。3a 之后每一个 `Neither way` / `Pull only` 的项都在犯同一个错。

- [ ] **Step 1: 写失败测试**

追加到 `tests/core.test.ts` 的 `describe("pushExternal")` 内(`fakeWriter` / `setup` / `seedGroups` 已在该文件上方):

```ts
  it("withheld item: the far end keeps its own lock entry, and ours never lands on top of it", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({
        capturedAt: "2026-08-02T00:00:00.000Z",
        items: {
          community: { "config-sync": { hash: "sha256:mine", capturedAt: "2026-08-02T00:00:00.000Z" } },
          obsidian: { hotkeys: { hash: "sha256:h-mine", capturedAt: "2026-08-02T00:00:00.000Z" } },
        },
        version: 3,
      }),
      "cs/store/configdir/plugins/config-sync/data.json": '{"mine":true}',
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({
      "store.lock.json": JSON.stringify({
        capturedAt: "2026-08-01T00:00:00.000Z",
        items: {
          community: { "config-sync": { hash: "sha256:theirs", capturedAt: "2026-08-01T00:00:00.000Z" } },
        },
        version: 3,
        syncedWatermark: "2026-08-01T00:00:00.000Z",
      }),
      "store/configdir/plugins/config-sync/data.json": '{"theirs":true}',
    });
    await pushExternal(ctx, fw.writer, { skipRefs: [SELF_ITEM_REF] });
    const pushed = parseStoreLock(fw.files["store.lock.json"] ?? "");
    // Their content was never sent, so their entry still describes it.
    expect(pushed.items["community"]?.["config-sync"]?.hash).toBe("sha256:theirs");
    // What we DID send is ours.
    expect(pushed.items["obsidian"]?.["hotkeys"]?.hash).toBe("sha256:h-mine");
    // Their lineage is theirs to move.
    expect(pushed.syncedWatermark).toBe("2026-08-01T00:00:00.000Z");
  });

  it("pushing twice with nothing changed rewrites nothing at all, the lock included", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { obsidian: { hotkeys: { hash: "sha256:h" } } }, version: 3 }),
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "store.lock.json": "{}", "store/configdir/hotkeys.json": '{"a":9}' });
    await pushExternal(ctx, fw.writer, { skipRefs: [] });
    const first = [...fw.writeLog];
    expect(first).toContain("store.lock.json");
    fw.writeLog.length = 0;
    await pushExternal(ctx, fw.writer, { skipRefs: [] });
    expect(fw.writeLog).toEqual([]);
  });

  it("a lock at the far end that cannot be parsed does not stop the push", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "store.lock.json": "not json at all" });
    await pushExternal(ctx, fw.writer, { skipRefs: [] });
    expect(parseStoreLock(fw.files["store.lock.json"] ?? "").version).toBe(STORE_LOCK_VERSION);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.ts -t "pushExternal"`
Expected:**第一条 FAIL** —— 对面的 `config-sync` 条目被我们的覆盖成 `sha256:mine`,`syncedWatermark` 也变成我们的。它是本任务真正的驱动测试。

**第二、三条改前改后都 PASS,这是预期的,不要为了让它们先红而改写它们。** 今天的推送逐字节转发本地 lock,所以「稳态不重写」和「坏账本不挡路」这两条恰好成立;而改完之后成立的理由完全不同(派生输出必须字节稳定;远端 lock 从此**会被解析**,于是第一次有了抛错的可能)。它们守的是这次改动可能打破的不变量,先写下来是为了打破的那一刻立刻知道。

- [ ] **Step 3: 写实现**

`src/core/ConfigSyncCore.ts`,`pushExternal` 内。远端 lock 的读取合并成一次:

```ts
  const remoteFiles = new Set(remoteRels.filter((r) => !isLegacyManifestRel(r)));
  // Read ONCE: the version gate below and the derived lock further down must see the same bytes, for
  // the same reason applyImport parses the bytes its own gate read.
  const remoteLockRaw = remoteFiles.has(LOCK_REL) ? await writer.readFile(LOCK_REL) : null;
  // The version gate, push side: refused before the first writeFile — pushing this build's store over a remote
  // written by a newer one would overwrite a shape we cannot read with one it cannot read back.
  assertStoreLockVersionUnderstood(remoteLockRaw);
  for (const rel of pushableRels) {
    if (rel === LOCK_REL) continue; // not content: derived and written below
    ...
  }
```

镜像删除的循环不动 —— `wanted` 仍由 `pushableRels` 建,`LOCK_REL` 还在里面,所以对面的账本不会被当成多余文件删掉。

删除循环之后、`finalize()` 之前,写账本:

```ts
  // The bookkeeping goes last, and goes DERIVED. It is the one file whose content is not simply
  // ours: it describes the store the far end holds after this push, and this push did not send
  // everything (spec 3.6). Absent local lock = nothing to describe, and today's behaviour stands.
  const localLockRaw = rels.includes(LOCK_REL) ? await ctx.io.read(`${ctx.rootPath}/${LOCK_REL}`) : null;
  if (localLockRaw !== null) {
    const derived = derivedPushLock({
      local: parseStoreLock(localLockRaw, manifest.groups),
      // A lock at the far end we cannot parse holds no entries we could preserve. The version gate
      // above already refused a lock from a NEWER build, so what is left here is a damaged file —
      // and push is the operation that replaces it, exactly as capture replaces a damaged local one.
      remote: parsedOrNull(remoteLockRaw, manifest.groups),
      skipRefs: opts.skipRefs,
    });
    const content = JSON.stringify(derived, null, 2) + "\n";
    const existed = remoteFiles.has(LOCK_REL);
    if (!existed || remoteLockRaw !== content) {
      const { name, itemRel } = groupForStoreRel(manifest.groups, LOCK_REL);
      await writer.writeFile(LOCK_REL, content);
      const result = resultFor(name);
      result.filesWritten.push(LOCK_REL);
      (existed ? result.changes.updated : result.changes.added).push(itemRel);
    }
  }
  await writer.finalize();
```

同文件内的私有辅助(放在 `pushExternal` 上方):

```ts
// A remote lock this build cannot parse, told apart from one that is not there: both leave the push
// with no far-end entries to preserve, and the difference is not one the caller can act on.
function parsedOrNull(raw: string | null, groups: readonly SyncGroup[]): StoreLock | null {
  if (raw === null) return null;
  try {
    return parseStoreLock(raw, groups);
  } catch {
    return null;
  }
}
```

本地 lock 的解析**不加 try**:一份读不懂的本地账本是这台设备的问题,推送应当当场报错,而不是把它发给整个 fleet。

import 处只需补 `derivedPushLock`(`./derivedLock`);`parseStoreLock` 该文件 `:5` 已 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core.test.ts -t "pushExternal"`
Expected: 三条新测试 PASS。

- [ ] **Step 5: 跟上一处既有断言**

`tests/core.test.ts` 的 `"a lock file alone (no store/** tree) also satisfies the store-presence check"` 断言推过去的字节与本地 v1 字节相同。现在推的是派生文档(v1 的 `groups` 已被 `parseStoreLock` 重新键入),所以改成断言语义:

```ts
    const pushed = parseStoreLock(fw.files["store.lock.json"] ?? "");
    expect(pushed.capturedAt).toBe("t");
    expect(pushed.version).toBe(STORE_LOCK_VERSION);
```

`STORE_LOCK_VERSION` 与 `parseStoreLock` 该文件已 import(`:4` / `:6`)。

**跑整套**,确认没有别的测试压在「推送即逐字节转发本地 lock」这个假设上:

Run: `npx vitest run`
Expected: 全绿。`tests/versionGates.test.ts` 里那条 `"a remote lock with no version at all still pulls and pushes as today"` 只断言内容文件,不受影响 —— 若它挂了,说明改动越界了,停下来看。

- [ ] **Step 6: 三绿**

Run: `npx tsc --noEmit` / `npx eslint .`
Expected: 0 error;warning 不超过 57。

- [ ] **Step 7: 提交**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "fix(push): stop overwriting the far end's bookkeeping for what we never sent"
```

---

### Task 3:真机冒烟

**Files:** 无(验证任务)

夹具照 memory 里那份 `config-sync-2-25-0-remote-direction.md` 的配方重建(从 `dev/vault/9-Aux/config-sync/` 复制出 `remote-vault2/`,给 lock 条目补 `capturedAt`)。命令都在 `dev/vault` 下跑(obsidian-cli 按 CWD 路由)。

- [ ] **Step 1: 装上这次构建**

Run: `npm run build`,再 `obsidian command id=app:reload`(**不要** `plugin:reload` —— 会留下幽灵实例)。

- [ ] **Step 2: 摆一个不推的项**

面板切到该 remote,把 `Config Sync` 那一项设成 `Neither way`;另找一个普通项(如 `Hotkeys`)保持 `Both ways` 并让它有待推内容。

- [ ] **Step 3: 推**

点 `Push N items`,等运行结束。

- [ ] **Step 4: 去对面核对账本(spec 验收第 9 条后半)**

Run: `cat <fixture>/store.lock.json`
Expected:
- `Config Sync` 那一项的条目**仍是对面原来那条**(`hash` / `capturedAt` 与推送前一致),没有被我们的覆盖;
- `Hotkeys` 的条目是我们的;
- `syncedWatermark` 与推送前一致。

推送前先留一份副本(`cp <fixture>/store.lock.json /tmp/…/before.json`)以便逐字段比。

- [ ] **Step 5: 稳态**

再推一次(内容不变)。Expected:运行报告没有文件写入;git 类型的 remote 无新提交;面板那一行是 `In sync`。

- [ ] **Step 6: 拉回去不倒退**

在对面改一个**参与双向**的项,回来 Pull。Expected:拉得进来,且拉完之后 `Config Sync` 那一项的行状态没有被这次往返搅动。

---

### Task 4:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(模块清单补 `core/derivedLock.ts`;Transport 一节补派生 lock 一段)
- Modify: `docs/GUIDE.md`(Transport 一节)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

- [ ] **Step 1: ARCHITECTURE.md**

模块清单里 `core/merge.ts` 附近新增一条:`core/derivedLock.ts` —— 推送发出去的那份 `store.lock.json` 的唯一构造规则;为什么它不是本地那份(不参与这次推送的项保留对面的条目、`syncedWatermark` 只由 pull 推动),以及**它不引入新格式**,schema 不变。

Transport 一节补一段:push 把 `store.lock.json` 从内容循环里摘了出来 —— 它是唯一一个内容不等于本地字节的文件。同时写明这修掉了什么:`excludeSelf`(今天的 `Neither way`)一直跳过内容却照推账本,对面因此拿到一本指纹与自己文件对不上的账本。

- [ ] **Step 2: GUIDE.md**

Transport 一节补一句(用户视角,不出现 lock / 指纹这类实现词):一个你设成不往那边送的项,推送不再把它的记录一并带过去 —— 对面那台设备关于它自己那份的记录,仍然是它自己的。

- [ ] **Step 3: CHANGELOG.md**

2.25.0 条目追加一条:

> Fixed a push overwriting the other side's record of things it never sent. An item you keep out of a remote — Config Sync's own settings, or anything you set to travel one way — left the far end holding bookkeeping that described a file we never wrote, and that bookkeeping is what its own devices read to decide whether they are behind. Their record of those items now stays theirs, and so does the mark of how far they have pulled

- [ ] **Step 4: 核对**

Run: `grep -rn "derivedPushLock" src/`
Expected:只有 `core/derivedLock.ts`(定义)与 `core/ConfigSyncCore.ts`(唯一调用点)。

- [ ] **Step 5: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: the bookkeeping a push sends is not the bookkeeping this device keeps"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超基线 0 error / 57 warn)。
- 真机冒烟 Task 3 六步全过,其中第 4 步是 spec 验收第 9 条的后半。
- **本地 `store.lock.json` 在整轮冒烟里字节未变**(推送只读它)。
- `store-lock.schema.json` 未改。

## 交给 3c / 3d 的边界

- **3.6 表里「内容被改写过的项按实际发出的内容重算指纹」那一格本轮不实现**:今天没有任何东西会改写推送内容,那一格要等逐键扣留落地。届时 `derivedPushLock` 增一个入参(ref → 实际发出内容的指纹),本模块是唯一改动点。
- **逐键扣留的全部**(3.1/3.2 合并语义、3.4.2 pull 后重新盖章、3.4.3 指纹快路、卡片 `Keys` 区)在 3c。
- **并发**(3.7)在 3d。
- **只有远端才有的项**仍无 ref(3a 留下的边界),派生 lock 对它的处理是「不写条目」,与推送镜像删除它的文件一致 —— 3c 给它 ref 时复核这一条仍然成立。
