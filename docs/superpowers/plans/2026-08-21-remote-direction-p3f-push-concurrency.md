# 2.25.0 · Plan 3f:推送期间对面变了 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3c 把推送从「覆盖」升级成了「读-改-写」,于是出现了一个真实的时间窗:读到对面的值,写回时对面刚捕获过,把旧值复活。本轮补上两道闸 —— **写前复核**(被改写过的文件落盘前再读一次,对不上就中止整次推送,一个字节都不写)与**过期判断中止**(面板上的判断可能来自五分钟前的缓存;推送那一刻若某个勾中的项方向已经变了,停下来请用户重看)。

**Architecture:** `pushExternal` 从「边读边写」改成**先算完、再复核、最后落盘**三段。今天它一个循环里读对面、算内容、立刻写;vault 类型的写是即时且持久的,所以中途中止会留下半推的 store。三段之后,第一个字节落盘之前所有复核都已经做完,「中止 = 什么都没发生」对两种传输都成立(git 本来就靠克隆做到这一点,vault 靠这个顺序)。判断新鲜度要用 `itemFreshness`,它今天私藏在 `core/status.ts` 里,而 `status.ts` 依赖 `ConfigSyncCore.ts` —— 所以先把它抽进 `core/lockFreshness.ts`,两边都从那里读,不制造环。

**Tech Stack:** TypeScript(strict)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §3.7

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b / 3c / 3d / 3e | 数据模型 → 统一面板 → 逐项方向 → 派生 lock → 逐键扣留 → 键级一致 → Keys 写入口 | **DONE**,均已合入 main |
| **3f** | **本文件** | 推送期间对面变了(spec 3.7) |
| 4 | 加密(3.8/3.9) | 未开始 |

## Global Constraints

- **git 类型保持不动**(spec 3.7 第一段)。它的乐观并发控制已经是安全的:克隆 → 改 → 提交 → 普通 push,非快进就被拒,什么都没写进去。本轮新增的复核对它是一次克隆内的本地读,不改变它的任何行为。
- **中止就是什么都没写。** 这是本轮唯一有意义的承诺,也是三段式存在的理由:vault 的 `writeFile` 直接落盘且持久(`external/localPath.ts`),所以任何一次复核都必须发生在**第一次写之前**。
- **不是重试。** 推送不是幂等操作(spec 3.7 原话),复核失败就抛错走错误卡,由用户重看再决定。
- **只复核被改写过的文件。** 逐字节转发的文件没有读-改-写窗口:它的内容不取决于对面现在是什么。多读一遍没有收益,只有成本。
- **过期判断中止只针对用户勾中的项**(spec 3.7 第三段)。一次「推送全部」不该因为对面在某个没勾的项上更新就整体停摆。
- **错误文案是产品视角**:说对面变了、说什么都没写、说下一步做什么;不出现 rel、克隆、缓存这类实现词(rel 只在开发者看得到的日志里)。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/lockFreshness.ts`(新建) | 从 `status.ts` 迁出的逐项新鲜度判定,`ConfigSyncCore` 与 `status` 共用 |
| `src/core/status.ts`(改) | 改为 import,自身不再持有那几个私有件 |
| `src/core/ConfigSyncCore.ts`(改) | `pushExternal` 三段化 + 两道闸 |
| `src/main.ts`(改) | `pushTo` 多收一个「用户勾了哪些项」 |
| `src/ui/SyncCenterView.ts`(改) | 动作条把勾中的 ref 一并交出去 |
| 测试 | `tests/core.test.ts`(新 describe)、`tests/status.test.ts`(迁移后仍绿) |

---

### Task 1:把逐项新鲜度搬到两边都能用的地方

**Files:**
- Create: `src/core/lockFreshness.ts`
- Modify: `src/core/status.ts`
- Test: 无新增 —— 这是一次**纯搬家**,`tests/status.test.ts` 既有的一整套就是它的守卫

**Interfaces:**
- Produces(全部原样迁出,签名不变):
  ```ts
  export type ItemFreshness = "equal" | "newer" | "older" | "undatable" | "absent";
  export function itemFreshness(mine: StoreLockEntry | undefined, theirs: StoreLockEntry | undefined): ItemFreshness;
  export function hasPerItemPayload(lock: StoreLock): boolean;
  ```
  私有随迁:`lockValuesEqual`、`lockEntriesEquivalent`、`entryTime`、`NON_CONTENT_LOCK_ENTRY_KEYS`。

**为什么必须搬:** `pushExternal` 要判断「对面这一项是不是比我新」,而 `itemFreshness` 在 `status.ts`,`status.ts` 又 `import ... from "./ConfigSyncCore"`。反向 import 会成环。搬到一个谁都不依赖的叶子模块是唯一不别扭的解法 —— 而且它本来就是**关于两条 lock 条目**的判断,与状态面板无关。

- [ ] **Step 1: 建文件,原样搬**

新建 `src/core/lockFreshness.ts`,把 `status.ts` 里那五段(含全部注释,一个字不改)剪过去,顶部加模块注释:

```ts
// Whether one item's two lock entries describe the same content, and which side moved last. Lives in
// its own leaf module because BOTH the panel (status.ts) and the push seam (ConfigSyncCore.ts) ask
// it, and status.ts already imports the seam — the two would otherwise be a cycle. It is a judgement
// about two lock entries; neither the panel nor the transport is part of the question.
```

- [ ] **Step 2: status.ts 改为 import**

删掉那五段,`import { hasPerItemPayload, itemFreshness, ItemFreshness } from "./lockFreshness";`。

- [ ] **Step 3: 跑全套**

Run: `npx vitest run` 与 `npx tsc --noEmit`
Expected: 全绿,**一条测试都不用改** —— 改了就说明这次搬家不是纯的,停下来看。

- [ ] **Step 4: 提交**

```bash
git add src/core/lockFreshness.ts src/core/status.ts
git commit -m "refactor(core): item freshness is a judgement about two lock entries, not about the panel"
```

---

### Task 2:先算完,再复核,最后落盘

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`pushExternal`)
- Test: `tests/core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PUSH_RACE_MESSAGE = "The other end changed while this push was being prepared. Nothing was written — compare again, then push.";
  ```
  `pushExternal` 的签名不变。

**三段是什么:**

| 段 | 做什么 | 允许写吗 |
|---|---|---|
| 算 | 遍历要推的 rel:读本地、读对面、算出**要发的内容**(带扣留键的项在这里叠加) | 否 |
| 复核 | 对**每个被改写过的** rel 再读一次对面,与算的时候读到的比 | 否 |
| 落盘 | 写文件、镜像删除、派生 lock、`finalize()` | 是 |

- [ ] **Step 1: 写失败测试**

追加到 `tests/core.test.ts` 的 `describe("pushExternal")`:

```ts
  it("aborts the whole push, writing nothing, when a rewritten file changed under it", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: { community: { demo: { ...pluginSource("1.0.0") } } }, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "mine", localOnly: "mine" }, null, 2) + "\n",
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, JSON.stringify({
      version: 1,
      groups: [
        { name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" },
        { name: "hotkeys", path: "{configDir}/hotkeys.json", type: "file", devices: "all" },
      ],
    }));
    const groups = await readGroups(ctx);
    const fw = fakeWriter({
      "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "store/configdir/plugins/demo/data.json": JSON.stringify({ theme: "theirs", localOnly: "theirs" }, null, 2) + "\n",
    });
    // The far end captures again between the plan and the write: the SECOND read of that file
    // answers something else.
    let reads = 0;
    const racing = {
      ...fw.writer,
      async readFile(rel: string): Promise<string> {
        const content = await fw.writer.readFile(rel);
        if (rel !== "store/configdir/plugins/demo/data.json") return content;
        reads += 1;
        return reads === 1 ? content : JSON.stringify({ theme: "theirs", localOnly: "MOVED" }, null, 2) + "\n";
      },
    };
    const rules: RemoteItems = { community: { demo: { keys: { localOnly: { direction: "none" } } } } };
    await expect(
      pushExternal(ctx, racing, { skipRefs: [], withheldPush: withheldPatternPredicate(rules, "push", groups), expectPush: [] })
    ).rejects.toThrow(PUSH_RACE_MESSAGE);
    // The promise this abort makes: NOTHING was written, not even the files that were fine.
    expect(fw.writeLog).toEqual([]);
    expect(fw.finalized).toBe(0);
  });

  it("does not re-read a file it forwards byte for byte — there is no window to lose", async () => {
    const { io, ctx } = setup();
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }),
      "cs/store/configdir/hotkeys.json": '{"a":1}',
    });
    await seedGroups(ctx, '{"version":1,"groups":[]}');
    const fw = fakeWriter({ "store.lock.json": JSON.stringify({ capturedAt: "t", items: {}, version: 3 }), "store/configdir/hotkeys.json": '{"a":9}' });
    const reads: string[] = [];
    const counting = { ...fw.writer, async readFile(rel: string): Promise<string> { reads.push(rel); return fw.writer.readFile(rel); } };
    await pushExternal(ctx, counting, { skipRefs: [], withheldPush: () => [], expectPush: [] });
    expect(reads.filter((r) => r === "store/configdir/hotkeys.json")).toHaveLength(1);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core.test.ts -t "pushExternal"`
Expected: FAIL —— `expectPush` 不认识;第一条即使去掉那个参数也会失败,因为今天边算边写,`writeLog` 里会留下 hotkeys。

- [ ] **Step 3: 写实现**

`pushExternal` 的循环拆成三段。第一段只算:

```ts
  interface PlannedWrite {
    rel: string;
    name: string;
    itemRel: string;
    content: string;      // what we will send
    theirs: string | null; // what the far end held when we planned, null = it had none
    rewritten: boolean;    // content was computed FROM `theirs` — the only case with a window
  }
  const planned: PlannedWrite[] = [];
  const rewritten = new Map<string, Record<string, string>>();
  for (const rel of pushableRels) {
    if (rel === LOCK_REL) continue;
    const { name, itemRel } = groupForStoreRel(manifest.groups, rel);
    const mine = await ctx.io.read(`${ctx.rootPath}/${rel}`);
    const theirs = remoteFiles.has(rel) ? await writer.readFile(rel) : null;
    const patterns = opts.withheldPush(rel);
    const content = patterns.length === 0 ? mine : overlayWithheld({ rel, keep: theirs, take: mine, patterns });
    if (patterns.length > 0) { …unchanged rewritten bookkeeping… }
    planned.push({ rel, name, itemRel, content, theirs, rewritten: patterns.length > 0 });
  }
```

第二段复核 —— **在任何写之前**:

```ts
  // The read-modify-write window (spec 3.7): a rewritten file's content was computed FROM what the
  // far end held, so if that changed under us, writing would resurrect the value we merged against.
  // Checked for ALL of them before the first byte lands, which is what makes the abort total: a
  // vault writer's writes are immediate and durable, so a mid-loop refusal would leave a half-pushed
  // store. Not a retry — a push is not idempotent, so the user decides what to do next.
  for (const p of planned) {
    if (!p.rewritten) continue;
    const now = remoteFiles.has(p.rel) ? await writer.readFile(p.rel) : null;
    if (now !== p.theirs) throw new Error(PUSH_RACE_MESSAGE);
  }
```

第三段照旧写(用 `planned` 里的值),镜像删除、派生 lock、`finalize()` 全部不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core.test.ts -t "pushExternal"`,再 `npx vitest run`
Expected: 全绿。既有 push 测试一条都不该改 —— 三段化不改变任何成功路径的结果。

- [ ] **Step 5: 提交**

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "fix(push): plan it all, check it all, then write — an abort leaves nothing behind"
```

---

### Task 3:过期的判断不推送

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`pushExternal` 的 opts 与闸)
- Modify: `src/main.ts`(`pushTo` 多收一个参数)
- Modify: `src/ui/SyncCenterView.ts`(动作条交出勾中的 ref)
- Test: `tests/core.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ConfigSyncCore
  pushExternal(ctx, writer, opts: { skipRefs: ItemRef[]; withheldPush: (rel: string) => string[]; expectPush: readonly string[] })
  export const PUSH_STALE_MESSAGE = "…"; // 见下

  // SyncCenterHost
  pushTo(remote: Remote, skipRefs: ItemRef[], expectPush: ItemRef[]): Promise<GroupResult[] | null>;
  ```

**`expectPush` 是什么,为什么必须由调用方给:** 它是**用户勾中的那些项** —— 也就是「用户是照着哪几行的判断按下按钮的」。推送集合本身推不出它:`skipRefs` 里既有没勾的行,也有规则扣下的项,两者混在一起。而这道闸的含义正是「**你据以行动的那个判断已经过期了**」,所以判断的来源必须说出来,不能猜。一个没有判断可言的调用方(将来某个「全推」入口)传 `[]`,那道闸就不响 —— 这是诚实,不是漏洞。

**文案(产品视角):**

```ts
export const PUSH_STALE_MESSAGE =
  "Some of the items you picked changed at the other end since you last compared. Nothing was written — refresh the comparison and pick again.";
```

- [ ] **Step 1: 写失败测试**

```ts
  it("refuses to push a picked item the far end has moved past since the comparison", async () => {
    const { io, ctx } = setup();
    const AT = "2026-08-11T10:00:00.000Z";
    const LATER = "2026-08-11T11:00:00.000Z";
    io.seed({
      "cs/store.lock.json": JSON.stringify({ capturedAt: AT, items: { community: { demo: { ...pluginSource("1.0.0"), capturedAt: AT, hash: "sha256:mine" } } }, version: 3 }),
      "cs/store/configdir/plugins/demo/data.json": '{"theme":"mine"}',
    });
    await seedGroups(ctx, JSON.stringify({ version: 1, groups: [{ name: "plugin-demo", path: "{configDir}/plugins/demo/data.json", type: "file", devices: "all" }] }));
    const fw = fakeWriter({
      "store.lock.json": JSON.stringify({ capturedAt: LATER, items: { community: { demo: { ...pluginSource("1.0.0"), capturedAt: LATER, hash: "sha256:theirs" } } }, version: 3 }),
      "store/configdir/plugins/demo/data.json": '{"theme":"theirs"}',
    });
    await expect(
      pushExternal(ctx, fw.writer, { skipRefs: [], withheldPush: () => [], expectPush: ["community/demo"] })
    ).rejects.toThrow(PUSH_STALE_MESSAGE);
    expect(fw.writeLog).toEqual([]);
  });

  it("says nothing about an item the caller never claimed to have judged", async () => {
    // …same fixture, expectPush: [] → the push goes through, exactly as before this guard existed.
  });

  it("lets a picked item through when the far end has not moved past it", async () => {
    // …same fixture with the remote entry at AT (or older) → pushes normally.
  });
```

- [ ] **Step 2: 实现**

闸放在版本闸之后、算之前(一个字节都没写,也没白算):

```ts
  // The judgement the user acted on can be up to a refresh cycle old, while this push reads the far
  // end fresh (spec 3.7's third layer). What they picked is ITEMS, not bytes — so if any picked item
  // has moved past us over there since, the pick was made on an answer that no longer holds. Stop and
  // let them look again rather than overwriting on the strength of a stale reading.
  if (opts.expectPush.length > 0 && localLockRaw !== null && remoteLockRaw !== null) {
    const mineLock = parseStoreLock(localLockRaw, manifest.groups);
    const theirsLock = parsedOrNull(remoteLockRaw, manifest.groups);
    if (theirsLock !== null) {
      const stale = opts.expectPush.filter((ref) => itemFreshness(lockEntry(mineLock, ref), lockEntry(theirsLock, ref)) === "newer");
      if (stale.length > 0) throw new Error(PUSH_STALE_MESSAGE);
    }
  }
```

**注意**:`localLockRaw` 今天是在函数末尾才读的(派生 lock 那段)。把那一行读提到前面来,两处共用 —— 同一份字节,同一个理由(applyImport 的注释也写着这条:闸检查过的字节就是后面用的字节)。

`src/main.ts` 的 `pushTo` 与 host 类型加第三个参数;`SyncCenterView` 的动作条把勾中的行的 ref 传过去(`skipRefsForSelection` 已经在算勾选,同一处顺手产出 `expectPush`;没有 ref 的行本来就进不了 skip 列表,也进不了这里)。

- [ ] **Step 3: 三绿并提交**

```bash
git add src tests
git commit -m "feat(push): a pick made on an answer that has since changed is not acted on"
```

---

### Task 4:真机冒烟

**Files:** 无(验证任务)

**能真机验的与不能的,先说清楚:** 写前复核那道闸要求在「算」与「落盘」之间恰好让对面变一次 —— 手工掐不准这个时机,所以它由 Task 2 那条**确定性单测**守着(第二次读返回不同内容的 writer)。真机这一轮验的是**它不会误伤**,以及过期判断那道闸(那个能手工造)。

- [ ] **Step 1** `npm run smoke:install`,`obsidian command id=app:reload`,remote 指向 scratchpad 的 `remote-vault2`。
- [ ] **Step 2 常态不误伤**:给一个项设一个 `Neither way` 的键(经面板),两边给不同值,推送。Expected:正常推完,对面那个键原封未动 —— 复核那道闸对没有并发的推送完全无感。
- [ ] **Step 3 连推两次**:第二次不写任何文件(复核不该把稳态推成一次重写)。
- [ ] **Step 4 过期判断中止**:在面板上比较出一项待推 → **不刷新面板**,直接去改夹具里那一项的 lock 条目(`capturedAt` 调到更新、换个 `hash`)→ 回面板勾中它按 Push。Expected:报 `Some of the items you picked changed at the other end since you last compared. Nothing was written — refresh the comparison and pick again.`,且**对面的文件一个字节没变**。
- [ ] **Step 5 刷新之后可以推**:点刷新重新比较,该项现在读作待拉;把它设成 `Push only` 再推,或直接拉一次再推。Expected:能正常完成 —— 这道闸拦的是过期的判断,不是用户的意图。

---

### Task 5:文档追平

- [ ] `docs/ARCHITECTURE.md`:`pushExternal` 一条改写成三段(算 / 复核 / 落盘),写明**为什么顺序是承诺的一部分**(vault 的写即时且持久,git 靠克隆),以及 `expectPush` 为什么必须由调用方给。新增 `core/lockFreshness.ts` 一条(为什么从 status.ts 迁出:环)。
- [ ] `docs/GUIDE.md`:Transport 一节补两句 —— 推送中途发现对面刚变过会**整次停下**,不会推一半;以及照着旧比较结果按下 Push 时会被拦住,请刷新再看。
- [ ] `CHANGELOG.md`:

> Fixed a push racing another device's save. Config Sync now works out everything it is going to send, checks that the other end still looks the way it did, and only then writes — if anything moved in between it stops with nothing written, instead of quietly restoring the value that other device had just changed
>
> Added a guard against acting on a comparison that has gone stale: if an item you picked has moved on at the other end since you last compared, Push stops and asks you to look again rather than overwriting it

```bash
git add docs CHANGELOG.md
git commit -m "docs: a push that finds the other end moved stops with nothing written"
```

---

## 完成标准

- 三绿,lint 不超基线。
- **中止 = 什么都没写**:Task 2 的两条单测(含 `writeLog` 为空、`finalized` 为 0)。
- Task 4 的四步真机全过。
- 既有 push 测试**一条未改** —— 成功路径的结果不因三段化而变。

## 交给 Plan 4 的边界

- **加密**(3.8/3.9)整块:解密后比明文、每个 remote 一份可选密码短语(含 spec 5.7 的 `Passphrase` 表单行)、转码、信封复用、三种「无法比对」的说法。本轮的复核比的是**字节**,加密项的密文字节本来就每次不同 —— 但那类文件今天不会被改写(`relCanHaveKeys` 只认明文 JSON),所以两道闸都碰不到它们。Plan 4 让加密项也能被逐键改写时,复核的比较对象要跟着换成**解密后的明文**,否则每一次推送都会误报一次并发。
- **拉取侧没有这两道闸**。spec 3.7 只谈推送:拉取写的是本机 store,冲突弹窗已经把「两边都变了」摆在用户面前。真要补,是另一份计划。
