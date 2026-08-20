# 2.25.0 · Plan 2c:收尾 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把统一面板欠的三件事补完:config-sync 自己那一项在两段关系下各有一副面孔、每一项的方向在面板上就能改(于是 Settings 里那个单项开关可以整块撤掉)、状态栏同时报两段且单位统一为**项**。

**Architecture:** 三块彼此独立,共用一个事实来源。① **项计数**:每个 remote 的待推/待拉**项数**由两边 store lock 的逐项比对得出(`checkRemote` 早就在做这件事,只是把结果收成了一个整库状态),所以计数是**免费的** —— 不需要一次真正的比较,periodic check 拿到的两个 lock 文件就够。② **self 的两副面孔**:设备关系下它仍是钉在顶部、没有勾选框的特殊行(今天的 `renderSelfRow`,一行不动);remote 关系下它就是列表里的普通一行 —— 让它进 `remoteRows()` 即可,2b 已经把路铺好。③ **方向控件**:卡片新增一行 `This remote`,四档写回 `Remote.items`(Plan 1 的 `withItemDirection`),Settings 那个只管 self 一项的开关随之失去存在理由。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian API。`core/status.ts` / `core/remoteRules.ts` 保持零 DOM 可单测。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`(实现 5.5、5.6、5.7 的删除部分,以及 5.4 里 `This remote` 那一行)

## 迭代全景(2.25.0 第 2 块的最后一份)

| # | 计划 | 状态 |
|---|---|---|
| 1 | 数据模型与迁移 | **DONE**,已合入 main |
| 2a | 关系轴与 View 选择器 | **DONE**,已合入 main |
| 2b | 统一渲染 | **DONE**,已合入 main(真机冒烟过) |
| **2c** | **收尾(本文件)** | self 两副面孔、`This remote` 行、撤 Settings 开关、状态栏统一为项 |
| 3 | 四档方向规则落地 | 传输语义、派生 lock、方向感知忽略集、「一致」重定义 |
| 4 | 加密 | 解密后比对、per-remote 密码短语、转码、信封复用 |

## Global Constraints

- **设备关系下一个像素都不许变。** 与 2b 同一条:统一是让同一套组件在另一段关系下换一套词。每个 Task 的冒烟都要复核。
- **单位统一为项。** spec 5.5:状态栏今天 `↑↓` 数项、`⇡⇣` 数 remote,同一行里两种单位。本轮之后 `⇡⇣` 也是项数,「跨几个 remote」进悬停。面板顶部那两颗药丸读同一个生产者(见 Task 2 的说明)。
- **不许有不工作的控件。** 仓库明令 "a dead affordance reads as a broken one"。所以顺序是:先有 `This remote` 行(Task 4),才撤 Settings 那个开关(Task 5) —— 中间不留「设过就改不回来」的窗口。
- **文案即终稿,取自 spec。** 四档的词:`Both ways` / `Push only` / `Pull only` / `Neither way`(`Push only` 与 `Neither way` 在 spec 5.3/5.4 里逐字出现,另两个是它们的补集)。命运句 `Doesn't sync with this remote` 与桶词 2b 已落地,不再改。
- **图标只从既有词汇里取。** 推 = `cloud-upload`、拉 = `cloud-download`(`actionIcons.ts` 的 `ACTION_ICON`),两向 = `arrow-up-down`,都不走 = `circle-slash`。一个字形一个含义,不新造。
- **写 `Remote.items` 只有一条路**:`core/remoteRules.ts` 的 `withItemDirection`。视图不自己拼 `items` 对象。

---

### Task 1:每个 remote 的待推/待拉**项数**

**Files:**
- Modify: `src/core/status.ts`(`RemoteCheck`、`checkRemote`,新增两个导出)
- Test: `tests/status.test.ts`(续写)

**Interfaces:**
- Consumes: 该文件已有的 `hasPerItemPayload` / `lockEntryList` / `lockEntry` / `itemFreshness`(都在 `perItemRemoteState` 上下文里)
- Produces:
  - `interface RemoteItemCounts { push: number; pull: number }`
  - `function remoteItemCounts(local: StoreLock | null, remote: StoreLock, ignoreRefs: string[]): RemoteItemCounts | null`
  - `RemoteCheck` 增加 `items: RemoteItemCounts | null`
  - `function sumRemoteItemCounts(checks: readonly RemoteCheck[]): { push: number; pull: number; remotes: number; uncounted: number }`

**为什么计数是免费的:** `perItemRemoteState` 已经逐项走过两边 lock 的 `itemFreshness`,只是把结果折成了一个整库状态。数一遍 newer / older,就是「有几项要拉 / 要推」。**不读任何额外文件**,periodic check 的两个 lock 就够。

**`null` 的含义**(必须写进注释):这个 remote **数不出项来** —— 有一侧还是 v1/v2 lock,或者远端不可读。它不贡献数字,但要被 `uncounted` 记上一笔,悬停里说清楚,否则「4 项要推」会读成「一共只有 4 项要推」。

- [ ] **Step 1: 写失败测试**

追加到 `tests/status.test.ts`。**用该文件已经在用的 `lockByName`(`tests/lock.ts`)造锁** —— 它按组名描述,内部经 `lockRefFor` 落到 ref,与真实读路径同一个生产者;别手写 `items` 两层结构。`hasPerItemPayload` 问的是**有没有条目带 `capturedAt`**,所以「数不出来的一侧」就是条目不带时间戳的那种锁:

```ts
import { remoteItemCounts, sumRemoteItemCounts, RemoteCheck } from "../src/core/status";
import { lockByName } from "./lock";

describe("remoteItemCounts", () => {
  const t0 = "2026-08-01T00:00:00.000Z";
  const t1 = "2026-08-02T00:00:00.000Z";

  it("counts the items each side is ahead on, not the remotes", () => {
    const local = lockByName(t1, { app: { hash: "a", capturedAt: t1 }, hotkeys: { hash: "h", capturedAt: t0 } });
    const remote = lockByName(t1, { app: { hash: "a2", capturedAt: t0 }, hotkeys: { hash: "h2", capturedAt: t1 } });
    expect(remoteItemCounts(local, remote, [])).toEqual({ push: 1, pull: 1 });
  });

  it("counts nothing for items whose copies are identical", () => {
    const same = { app: { hash: "a", capturedAt: t0 } };
    expect(remoteItemCounts(lockByName(t0, same), lockByName(t1, same), [])).toEqual({ push: 0, pull: 0 });
  });

  it("ignores the refs this remote never exchanges", () => {
    // `lockRefFor([])` maps the plugin group name to `community/config-sync` — the same ref the
    // ignore list speaks, which is exactly why the fixture goes through lockByName.
    const local = lockByName(t1, { "plugin-config-sync": { hash: "a", capturedAt: t1 } });
    const remote = lockByName(t1, { "plugin-config-sync": { hash: "b", capturedAt: t0 } });
    expect(remoteItemCounts(local, remote, ["community/config-sync"])).toEqual({ push: 0, pull: 0 });
  });

  it("says it cannot count when a side stamps no entry with a capture time", () => {
    const unstamped = lockByName(t0, { app: { hash: "a" } });
    expect(remoteItemCounts(unstamped, lockByName(t1, { app: { hash: "b", capturedAt: t1 } }), [])).toBeNull();
  });

  it("counts every remote item as a pull when this device has no lock yet", () => {
    const remote = lockByName(t1, { app: { hash: "a", capturedAt: t1 }, hotkeys: { hash: "h", capturedAt: t1 } });
    expect(remoteItemCounts(null, remote, [])).toEqual({ push: 0, pull: 2 });
  });
});

describe("sumRemoteItemCounts", () => {
  const check = (items: { push: number; pull: number } | null): RemoteCheck => ({ state: "unknown", remoteCapturedAt: null, items });

  it("adds the item counts up and says how many remotes they came from", () => {
    expect(sumRemoteItemCounts([check({ push: 2, pull: 0 }), check({ push: 1, pull: 3 })])).toEqual({ push: 3, pull: 3, remotes: 2, uncounted: 0 });
  });

  it("counts a remote as contributing only when it has something waiting", () => {
    expect(sumRemoteItemCounts([check({ push: 0, pull: 0 }), check({ push: 1, pull: 0 })])).toEqual({ push: 1, pull: 0, remotes: 1, uncounted: 0 });
  });

  it("keeps a remote it cannot count apart from one with nothing to do", () => {
    expect(sumRemoteItemCounts([check(null), check({ push: 0, pull: 0 })])).toEqual({ push: 0, pull: 0, remotes: 0, uncounted: 1 });
  });

  it("says nothing is waiting when there are no remotes at all", () => {
    expect(sumRemoteItemCounts([])).toEqual({ push: 0, pull: 0, remotes: 0, uncounted: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/status.test.ts -t remoteItemCounts`
Expected: FAIL —— 未导出。

- [ ] **Step 3: 写实现**

`src/core/status.ts`,`RemoteCheck` 改成:

```ts
export interface RemoteItemCounts {
  push: number; // items this store is ahead on — Push would update the remote
  pull: number; // items the remote is ahead on — Pull would update this store
}

export interface RemoteCheck {
  state: RemoteState;
  remoteCapturedAt: string | null;
  // Per-ITEM counts, when both sides carry the per-item lock payload; null when they cannot be
  // counted item by item (one side still on a v1/v2 lock, or the remote is unreadable). null is
  // NOT zero: a remote nobody can count must not silently read as a remote with nothing to do.
  items: RemoteItemCounts | null;
}
```

`perItemRemoteState` 正下方加:

```ts
// How many ITEMS each side is ahead on. The same walk perItemRemoteState does — it already asks
// `itemFreshness` per ref — kept as its own function because the two answers are different
// questions: that one collapses to a single whole-store word, this one is the number the panel and
// the status bar show. Reads only the two locks already in hand: no extra file reads, so a periodic
// check pays nothing for it.
//
// `local === null` is the bootstrap device: it has no store of its own yet, so every item the
// remote holds is an item waiting to come in.
export function remoteItemCounts(local: StoreLock | null, remote: StoreLock, ignoreRefs: string[]): RemoteItemCounts | null {
  if (!hasPerItemPayload(remote)) return null;
  if (local !== null && !hasPerItemPayload(local)) return null;
  const refs = [...new Set([...(local === null ? [] : lockEntryList(local.items)), ...lockEntryList(remote.items)].map(([ref]) => ref))]
    .filter((r) => !ignoreRefs.includes(r));
  let push = 0;
  let pull = 0;
  for (const ref of refs) {
    const freshness = itemFreshness(local === null ? undefined : lockEntry(local, ref), lockEntry(remote, ref));
    if (freshness === "newer") pull++;
    else if (freshness === "older") push++;
  }
  return { push, pull };
}

// The whole-fleet total the status bar and the header pills both read. `remotes` is how many
// remotes actually contribute a number (the hover says "across N remotes"), `uncounted` how many
// could not be counted at all — reported separately because "0 waiting" and "cannot say" are
// different facts and a single number would merge them.
export function sumRemoteItemCounts(checks: readonly RemoteCheck[]): { push: number; pull: number; remotes: number; uncounted: number } {
  let push = 0;
  let pull = 0;
  let remotes = 0;
  let uncounted = 0;
  for (const c of checks) {
    if (c.items === null) {
      uncounted++;
      continue;
    }
    push += c.items.push;
    pull += c.items.pull;
    if (c.items.push > 0 || c.items.pull > 0) remotes++;
  }
  return { push, pull, remotes, uncounted };
}
```

`checkRemote` 的每一个 `return` 都要带上 `items`。三处早退是 `items: null`(没有 lock / 解析失败 / 版本太新),两处有 lock 的分支这样填:

```ts
  if (localLock === null) return { state: "remote-newer", remoteCapturedAt: remote.capturedAt, items: remoteItemCounts(null, remote, ignoreRefs) };
  const counts = remoteItemCounts(localLock, remote, ignoreRefs);
  const perItem = perItemRemoteState(localLock, remote, ignoreRefs);
  if (perItem !== null) return { state: perItem, remoteCapturedAt: remote.capturedAt, items: counts };
  …
  return { state, remoteCapturedAt: remote.capturedAt, items: counts };
```

- [ ] **Step 4: 跑全套**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 三绿。`RemoteCheck` 多一个必填字段,凡是手写 `RemoteCheck` 字面量的地方(测试、`remoteIcon` 的调用点)编译器会逐个指出来 —— **补 `items: null`,不要把字段改成可选**:可选会让「忘了填」和「数不出来」变成同一件事。

- [ ] **Step 5: 提交**

```bash
git add src/core/status.ts tests/status.test.ts
git commit -m "feat(core): a remote check counts the items each side is ahead on"
```

---

### Task 2:状态栏两段,单位统一为项

**Files:**
- Modify: `src/ui/statusBar.ts`(`statusBarAriaLabel`)
- Modify: `src/main.ts`(`updateStatusIndicators`)
- Modify: `src/ui/SyncCenterView.ts`(`renderHeader` 的两颗 remote 药丸)
- Test: `tests/statusBar.test.ts`(续写;若无此文件则新建)

**Interfaces:**
- Consumes: Task 1 的 `sumRemoteItemCounts`
- Produces: `function statusBarAriaLabel(segments: StatusBarSegment[], span: { remotes: number; uncounted: number }): string`

**这一步动的是意义,不是形状:** `statusBarSegments` 的签名与输出一个字不改 —— 它照旧收 `{push, pull}`,只是**传进去的东西从「几个 remote」变成「几项」**。变的是 aria/悬停:项数不说明分布,所以「跨几个 remote」补在那里(spec 5.5)。

**面板顶部那两颗药丸(`renderHeader`)跟着一起换。** 严格说 spec 5.5 只点名了状态栏,但顶部药丸今天读的是同一个 `remoteDirectionCounts`;只改一处,同一个屏幕上就会同时出现「4 项要推」和「1 个 remote 要推」,正是这条 spec 要修的那种不一致。所以两处一起换,`remoteDirectionCounts` 随之退役(它没有别的调用点,连同它在 `tests/status.test.ts` 里的 describe 一并删掉)。

- [ ] **Step 1: 写失败测试**

追加到 `tests/statusBar.test.ts`:

```ts
import { statusBarSegments, statusBarAriaLabel } from "../src/ui/statusBar";

describe("statusBarAriaLabel", () => {
  const segs = statusBarSegments({ up: 13, down: 0 }, { push: 4, pull: 0 }, true);

  it("names the remote numbers as items, and says how far they are spread", () => {
    expect(statusBarAriaLabel(segs, { remotes: 2, uncounted: 0 })).toBe("Config Sync — 13 to capture · 4 to push across 2 remotes");
  });

  it("keeps the singular honest", () => {
    expect(statusBarAriaLabel(segs, { remotes: 1, uncounted: 0 })).toBe("Config Sync — 13 to capture · 4 to push across 1 remote");
  });

  it("says nothing about spread when no remote segment is showing", () => {
    const local = statusBarSegments({ up: 13, down: 0 }, { push: 0, pull: 0 }, true);
    expect(statusBarAriaLabel(local, { remotes: 0, uncounted: 0 })).toBe("Config Sync — 13 to capture");
  });

  it("owns up to a remote it could not count", () => {
    expect(statusBarAriaLabel(segs, { remotes: 2, uncounted: 1 })).toBe(
      "Config Sync — 13 to capture · 4 to push across 2 remotes · 1 remote can't be counted yet"
    );
  });

  it("still says all-in-sync with nothing at all waiting", () => {
    expect(statusBarAriaLabel([], { remotes: 0, uncounted: 0 })).toBe("Config Sync — all in sync");
  });
});
```

**同时**:`tests/statusBar.test.ts` 里既有的三条 `statusBarAriaLabel` 断言现在少一个参数,给它们补上 `{ remotes: 0, uncounted: 0 }`,期望字符串一字不改 —— 没有 remote 段时这个参数什么也不加,这三条正是那条规则的守卫。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/statusBar.test.ts -t statusBarAriaLabel`
Expected: FAIL —— 多一个参数,且 `across` 那半句还不存在。

- [ ] **Step 3: 写实现**

`src/ui/statusBar.ts`:

```ts
// `span` describes what the push/pull NUMBERS are spread across. The numbers themselves are items
// (spec 5.5: one unit on this line, never "items" beside "remotes"), and an item count says nothing
// about how many remotes are involved — so that goes here, where a hover can carry it.
export function statusBarAriaLabel(segments: StatusBarSegment[], span: { remotes: number; uncounted: number }): string {
  if (segments.length === 0 && span.uncounted === 0) return "Config Sync — all in sync";
  const phrase = (s: StatusBarSegment): string =>
    s.kind === "up"
      ? `${s.count} to capture`
      : s.kind === "down"
        ? `${s.count} to apply`
        : s.kind === "push"
          ? `${s.count} to push`
          : `${s.count} to pull`;
  const parts = segments.map(phrase);
  const remoteShowing = segments.some((s) => s.kind === "push" || s.kind === "pull");
  if (remoteShowing && span.remotes > 0) parts.push(`across ${span.remotes} remote${span.remotes === 1 ? "" : "s"}`);
  if (span.uncounted > 0) parts.push(`${span.uncounted} remote${span.uncounted === 1 ? "" : "s"} can't be counted yet`);
  return `Config Sync — ${parts.join(" · ")}`;
}
```

`across …` 是**上一段的续写而不是独立一段**,所以它跟在 push/pull 后面用同一个 `·` 连接;`renderStatusBarItem` 里那行调用改成:

```ts
export function renderStatusBarItem(el: HTMLElement, segments: StatusBarSegment[], span: { remotes: number; uncounted: number }): void {
  …
  el.setAttribute("aria-label", statusBarAriaLabel(segments, span));
}
```

`src/main.ts` 的 `updateStatusIndicators`:

```ts
    const checks = [...this.remoteChecks.values()].map((v) => v.check);
    const remoteItems = sumRemoteItemCounts(checks);
    …
      renderStatusBarItem(sb, statusBarSegments({ up, down }, remoteItems, this.settings.statusBarRemote), remoteItems);
```

(`remoteStates` 那一行还被上面的 ribbon dot 用着 —— `remoteNewer` 保留,别顺手删。)

`src/ui/SyncCenterView.ts` 的 `renderHeader`:

```ts
    const { push, pull, remotes: spread } = sumRemoteItemCounts(this.host.remotes().map((r) => this.host.remoteCheck(r.name)?.check).filter((c): c is RemoteCheck => c !== undefined));
```

两颗药丸的 aria 改成项:

```ts
        pills.createSpan({ cls: "config-sync-pill is-push", attr: { "aria-label": `${push} item${push === 1 ? "" : "s"} to push across ${spread} remote${spread === 1 ? "" : "s"}` } }),
```

拉那一颗同形(`is-pull` / `to pull`)。`remoteDirectionCounts` 与它的 import 一并删除;`tests/status.test.ts` 里 `describe("remoteDirectionCounts")` 整块删除。

- [ ] **Step 4: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机(dev vault,照 2b 那份 fixture 的做法造一个 vault remote):状态栏出现 `⇡N` / `⇣N` 且 N 是**项数**(与面板顶部那两颗药丸相等),悬停读出 `… across 1 remote`;把 remote 的 lock 改成 v1 形状,状态栏那两段消失、悬停读出 `1 remote can't be counted yet`。

- [ ] **Step 5: 提交**

```bash
git add src/ui/statusBar.ts src/main.ts src/ui/SyncCenterView.ts src/core/status.ts tests
git commit -m "feat(status bar): both relations, counted in items"
```

---

### Task 3:self 项的两副面孔

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`remoteRows`、`renderItemMode` 里那条 selfnote)
- Modify: `styles.css`(删 `.config-sync-remote-selfnote`)

**Interfaces:**
- Consumes: 2b 的 `remoteRows` / `deviceRows`
- Produces: 无新导出

**两副面孔各自的理由(写进注释):** 设备关系下 config-sync 管的是**它自己** —— 它有专属的侧栏目的地和 Adopt 引导,钉在顶部、没有勾选框是因为「自己管自己」不该混进批量运行。remote 关系下它没有这层特殊性:store 里的那一份就是一项普通内容,和别的项一样有方向、有勾选框。

- [ ] **Step 1: 让 self 进 remote 的行集**

`remoteRows()` 里两处过滤删掉 —— `localGroupNames` 不再排除 `SELF_GROUP_NAME`,`.filter((status) => status.group !== SELF_GROUP_NAME)` 整行删掉。注释改成:

```ts
    // config-sync's own item is an ordinary row HERE (spec 5.6): the store's copy of it travels to a
    // remote like any other item. Under the device relation it stays the pinned self row instead —
    // there it is the plugin managing itself, which is not batch work.
    const localGroupNames = this.familyGroups().map((g) => g.name);
```

`deviceRows()` 不动(它继续 `continue` 掉 self)。`renderTypeSection` 的 `showSelf` 已经在 2b 里门在了设备关系上,也不动。

- [ ] **Step 2: 撤掉复述那句小字**

`renderItemMode` 末尾这一整块删除:

```ts
    if (relation.kind === "remote") {
      const remote = this.host.remotes().find((x) => x.name === relation.name);
      if (remote !== undefined && selfStaysOut(remote)) {
        main.createDiv({ cls: "config-sync-remote-selfnote", text: "Config Sync's own settings stay out of this remote" });
      }
    }
```

它是 2b 的临时物:那时 self 不出行,只好用一句小字说这件事;现在那件事就写在它自己那一行上(`Doesn't sync with this remote`),再说一遍就是复述。`selfStaysOut()` 若就此没有调用点,连同 `styles.css` 的 `.config-sync-remote-selfnote` 一起删(先 `grep -rn "selfStaysOut\|remote-selfnote" src/ styles.css` 确认)。

- [ ] **Step 3: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机:remote 关系下 `Config Sync` 是列表里的普通一行(有勾选框、可点开卡片);设备关系下它仍钉在 Community 分区顶部、没有勾选框,侧栏那个 Config Sync 目的地照旧。

- [ ] **Step 4: 提交**

```bash
git add src/ui/SyncCenterView.ts styles.css
git commit -m "feat(panel): config-sync's own item is an ordinary row under a remote"
```

---

### Task 4:卡片的 `This remote` 行 —— 四档写回

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`SyncCenterHost` 声明、`renderUnifiedCard`、`deriveRemoteRow` 的 chips)
- Modify: `src/main.ts`(host 实现)
- Modify: `src/ui/fateChipIcons.ts`(三个新 chip 的字形)
- Test: `tests/fateChipIcons.test.ts`(该文件已在守「每个 chip 都有字形」这条,新增 chip 要跟着补)

**Interfaces:**
- Consumes: `itemDirection` / `withItemDirection`(`core/remoteRules.ts`)、`RemoteDirection`(`core/types.ts`)
- Produces:
  - `SyncCenterHost.setRemoteItemDirection(remoteName: string, ref: ItemRef, direction: RemoteDirection): Promise<void>`
  - 新 chip 字符串:`"push only"` / `"pull only"` / `"neither way"`

**这一行为什么必须先于 Task 5:** 撤掉 Settings 那个开关之后,`direction` 只剩这一个入口。先做控件、再撤开关,中间没有「设过就改不回来」的窗口。

- [ ] **Step 1: chip 字形**

`src/ui/fateChipIcons.ts` 的 `FATE_CHIP_ICON` 加三行(位置按字母序无所谓,跟着既有风格排在末尾即可):

```ts
  // The remote relation's direction chips. Same two glyphs the Pull/Push buttons and the View
  // picker badges use (ACTION_ICON) — one form, one meaning — plus the "nothing flows" slash.
  "push only": "cloud-upload",
  "pull only": "cloud-download",
  "neither way": "circle-slash",
```

`tests/fateChipIcons.test.ts` 里那条「每个 chip 都有字形」的断言若是按固定名单写的,把三个新名字加进名单。

- [ ] **Step 2: 行上的 chip(只在非默认档时出现)**

`deriveRemoteRow` 里,`chips: []` 换成按方向查表 —— 默认档 `both` 不出 chip(spec 5.3:四档 chip 只在非默认档时出现):

```ts
    const direction4 = ref === null || remote === undefined ? "both" : itemDirection(remote.items, ref);
    const chips = direction4 === "push" ? ["push only"] : direction4 === "pull" ? ["pull only"] : direction4 === "none" ? ["neither way"] : [];
```

`excluded` 改成读同一个值(`direction4 === "none"`),别再单独算一次 —— 一个事实一个来源。

- [ ] **Step 3: 卡片那一行**

`renderUnifiedCard` 里,**紧跟在 2b 那行 `if (remoteRelation) this.renderRemoteOnOffRow(fields, r);` 之后**再加一行 —— spec 5.4 的行序是 `On pull`/`State` → `Files` → `This remote`,卡内的 on/off 清单属于 `Files` 那一段的延伸:

```ts
    if (remoteRelation) this.renderThisRemoteRow(fields, r);
```

新方法,复用既有的 `renderCardMenuRow`(label + 菜单 chip,`After install` / `Enablement` 已经是这个形状):

```ts
  // spec 5.4's `This remote` row: which way this ONE item flows with the remote on screen. Four
  // stops, and the row's own chip above repeats the non-default ones (deriveRemoteRow). A row
  // without a ref cannot carry a rule — the store holds items the remote declares and this device
  // does not, and a rule keyed by nothing has nowhere to live — so it renders no control at all
  // rather than one that would silently do nothing.
  private renderThisRemoteRow(fields: HTMLElement, r: StatusRow): void {
    const relation = this.relation;
    if (relation.kind !== "remote") return;
    const ref = this.itemRefFor(r.group.name) ?? r.group.ref ?? null;
    const remote = this.host.remotes().find((x) => x.name === relation.name);
    if (ref === null || remote === undefined) return;
    const current = itemDirection(remote.items, ref);
    this.renderCardMenuRow(fields, "This remote", REMOTE_DIRECTION_LABEL[current], `Choose which way ${relation.name} exchanges this item`, () => {
      const menu = new Menu();
      for (const d of REMOTE_DIRECTION_ORDER) {
        menu.addItem((item) =>
          item
            .setTitle(REMOTE_DIRECTION_LABEL[d])
            .setIcon(REMOTE_DIRECTION_ICON[d])
            .setChecked(d === current)
            .onClick(() => void this.host.setRemoteItemDirection(relation.name, ref, d).then(() => this.reload()))
        );
      }
      return menu;
    });
  }
```

三张表放在 `SyncCenterView.ts` 顶部的常量区(与 `AVAILABILITY_FOLD_TEXT` 那些同一段):

```ts
// spec 5.3/5.4's four stops, copy final. `Both ways` is the default and the only one that leaves the
// row without a chip.
const REMOTE_DIRECTION_ORDER: readonly RemoteDirection[] = ["both", "push", "pull", "none"];
const REMOTE_DIRECTION_LABEL: Record<RemoteDirection, string> = {
  both: "Both ways",
  push: "Push only",
  pull: "Pull only",
  none: "Neither way",
};
const REMOTE_DIRECTION_ICON: Record<RemoteDirection, string> = {
  both: "arrow-up-down",
  push: "cloud-upload",
  pull: "cloud-download",
  none: "circle-slash",
};
```

- [ ] **Step 4: host 声明与实现**

`SyncCenterHost`(`pullFrom` / `pushTo` 旁边):

```ts
  // Writes ONE item's direction for ONE remote. The rules live on the remote (spec 2.4), so this is
  // a settings write, not an item write — and it invalidates the reader cache, because the next
  // comparison must be made under the new rules rather than reuse the answer from the old ones.
  setRemoteItemDirection(remoteName: string, ref: ItemRef, direction: RemoteDirection): Promise<void>;
```

`src/main.ts`(与 `pullFrom` / `pushTo` 同一个 host 对象里):

```ts
      setRemoteItemDirection: async (remoteName, ref, direction) => {
        if (!this.settingsWritable()) return;
        const next = this.settings.remotes.map((r) => (r.name === remoteName ? { ...r, items: withItemDirection(r.items, ref, direction) } : r));
        this.settings.remotes = next;
        await this.saveSettings();
        // Same pair SettingTab.saveRemotes does after any remote edit.
        this.clearReaderCache();
        await this.refreshRemoteChecks();
      },
```

`withItemDirection` 与 `RemoteDirection` 的 import 按需补(`main.ts` 已经从 `./core/remoteRules` 引了 `refsBlockedFor`)。

- [ ] **Step 5: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机:
1. remote 关系下点开任一项的卡片 → `This remote` 行显示 `Both ways`,菜单四项、当前项打勾。
2. 选 `Neither way` → 该行变灰、无勾选框、命运句 `Doesn't sync with this remote`、行上出现 `circle-slash` chip;`Pull N` 的 N 少一。
3. 选 `Push only` → chip 变 `cloud-upload`;拉方向的运行不再带它。
4. 改完之后比较会重跑(reader cache 已失效),不是拿旧答案糊上去。
5. 只有远端才有的项(没有 ref):卡片里**不画** `This remote` 行。
6. `dev:errors` 无捕获。

- [ ] **Step 6: 提交**

```bash
git add src/ui/SyncCenterView.ts src/ui/fateChipIcons.ts src/main.ts tests/fateChipIcons.test.ts
git commit -m "feat(panel): an item's direction for one remote is set on its card"
```

---

### Task 5:撤掉 Settings 里那个开关

**Files:**
- Modify: `src/ui/SettingTab.ts`(`renderRemoteForm` 末尾那一段 `selfLine`)
- Modify: `styles.css`(`.config-sync-remote-selfline` / `-selftext` / `-selfname` / `-selfdesc`)

**Interfaces:**
- Consumes: Task 4 的 `This remote` 行(它是这个开关的去处)
- Produces: 无

**这是删除,不是搬家(写进提交信息):** 那个开关只能表达一项(config-sync 自己)的一档(`none`),而 `Remote.items` 现在对**每一项**都能表达**四档** —— 面板上那一行是它的严格超集。数据不用迁移:Plan 1 的 v5 迁移已经把旧开关写成了 `items.community["config-sync"].direction`,开关撤掉后那个值仍在,且能在面板上读到和改。

- [ ] **Step 1: 删掉表单里那一段**

`SettingTab.ts` 的 `renderRemoteForm` 末尾,从 `const selfLine = panel.createDiv(...)` 到那个 `ToggleComponent` 的 `onChange` 结束,整段删除。随之不再被用到的 import(`SELF_ITEM_REF`、`itemDirection`、可能还有 `withItemDirection` —— **先 grep 确认该文件别处是否还在用**)一并删。

- [ ] **Step 2: CSS 清理**

`grep -n "remote-selfline\|remote-selftext\|remote-selfname\|remote-selfdesc" styles.css src/`,确认只剩 `styles.css` 里那四条规则,删掉。

- [ ] **Step 3: 跑全套 + 冒烟**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`

真机:Settings → Remotes 的 remote 编辑器里不再有那个开关;此前设过它的 remote,面板上 `Config Sync` 那一行显示 `Neither way`(值没丢),并且能在那里改回 `Both ways`。

- [ ] **Step 4: 提交**

```bash
git add src/ui/SettingTab.ts styles.css
git commit -m "refactor(settings): the one-item toggle gives way to the per-item rule it was a special case of"
```

---

### Task 6:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(`core/status.ts`、`statusBar.ts`、`SyncCenterView.ts` 三条)
- Modify: `docs/design/DESIGN.md`(状态栏、Unified card、Remote 三处)
- Modify: `docs/GUIDE.md`(Transport 一节:怎么设一项的方向)
- Modify: `CHANGELOG.md`(2.25.0 条目追加)

- [ ] **Step 1: ARCHITECTURE.md**

`core/status.ts` 那条补 `remoteItemCounts` / `sumRemoteItemCounts`:一次 remote 检查除了整库状态,还给出**逐项**的待推/待拉计数,来自两边 lock 已经在做的 `itemFreshness` 走查,不额外读文件;`null` 表示数不出来(某一侧还是 v1/v2 lock),与「零项待办」是两件事。删掉 `remoteDirectionCounts` 那半句(数 remote 的那个已退役)。`SyncCenterView.ts` 那条补:`This remote` 卡片行是 item 级方向的唯一写入口,经 `withItemDirection` 落到 `Remote.items`,写完清 reader cache。

- [ ] **Step 2: DESIGN.md**

状态栏那段:两段一起报,**单位都是项**,「跨几个 remote」在悬停里;数不出来的 remote 单独一句,不混进数字。Unified card 的行序补 `This remote`(四档、`Both ways` 无 chip、没有 ref 的行不画这一行)。Remote 那条补:config-sync 自己那一项在 remote 关系下是普通一行,设备关系下仍是钉在顶部、无勾选框的自管行。

- [ ] **Step 3: GUIDE.md**

Transport 一节补一小段:某一项不想和某个 remote 交换、或只想单向交换,在 Sync Center 里选中那个 remote、点开那一项的卡片,`This remote` 四选一;Config Sync 自己的设置也是这样设,不再是 Settings 里的单独开关。

- [ ] **Step 4: CHANGELOG.md**

2.25.0 条目追加两条,产品视角:
- 每一项都能单独决定和某个 remote 怎么交换:两向、只推、只拉、都不。Config Sync 自己的设置也是其中一项 —— Settings 里那个只管它一个的开关撤掉了,你此前的选择原样保留在那一行上。
- 状态栏现在同时报两件事,并且用同一个单位:本机与 store 之间待捕获/待应用的**项数**,加上所有 remote 待推/待拉的**项数**(此前后一半数的是 remote 个数),悬停说清楚跨几个 remote。

- [ ] **Step 5: 核对**

`grep -rn "remoteDirectionCounts\|remote-selfnote\|remote-selfline\|Keep Config Sync's own settings" src/ docs/ styles.css` —— 除 `docs/superpowers/` 下的历史计划与 spec 外无命中。

- [ ] **Step 6: 提交**

```bash
git add docs CHANGELOG.md
git commit -m "docs: items as the one unit, and one place to set a direction"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超既有基线 0 error / 57 warn)。
- `grep -rn "remoteDirectionCounts" src/` 无命中。
- **设备关系下逐像素不变**:与 2b 的截图比对通过(self 行仍钉在 Community 顶部、无勾选框)。
- 真机冒烟:Task 2 / 3 / 4 / 5 各自那几条全过。
- 数据不丢:此前用旧开关排除过 self 的 remote,升级后面板上读作 `Neither way`,且能改回。

## 交给 Plan 3 的边界

- **`Keys` 行**(spec 5.4 的逐键一档、受整项档位约束、`limited by This remote`)不在本轮 —— 本轮只做整项那一档。
- **只有远端才有的项**仍然没有 ref:它进不了 `skipRefs`,也没有 `This remote` 行。Plan 3 处理「只有对面才有的项」时一并给它一个 ref。
- **`lockDiffers` 那条通路**(内容一致、仅远端版本信息更新时的 Pull)自 2b 起没有入口,归 Plan 3 的「一致」重定义。
- **卡片里文件条目的后果文案**仍是设备口径(`these changes land on this device`),留给 Plan 3 的文案轮。
- 传输语义本身(派生 lock、方向感知忽略集、`Push only` 时保留对面的键值)全部是 Plan 3:本轮只让**规则可读可写**,不改**运行时怎么用它**。
