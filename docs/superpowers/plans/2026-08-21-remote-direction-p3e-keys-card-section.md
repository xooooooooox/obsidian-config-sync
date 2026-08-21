# 2.25.0 · Plan 3e:卡片的 Keys 区 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给键级规则一个写入口。remote 关系下展开一项,卡片多出一块 `Keys`:已经设过规则的键各一行、各带一个四档控件(受整项方向收窄),下面一句 `Click any key to add a rule for it`,再下面就是这一项的存档文档本身,点哪个键就给哪个键建规则。`On pull` / `On push` 两句同时点名被扣下的键 —— 3c 起传输已经遵守这些规则,本轮之前它们只能手写 `data.json` 才存在。

**Architecture:** **形状照搬 Settings 卡片里那块 `KEY RULES`**,不另发明:已设规则的行 → `+ Click any key…` → 文档,已设规则的键在文档里换色、未设的带虚线下划线可点。两处唯一的区别是**颜色说的是什么**:Settings 那边说「谁共享这个值」,这里说「往哪个方向流」。所以本轮把那个渲染器的**形状**抽进 `ui/jsonView.ts` 共用,**分类**各留各的。写只有一条路:`withKeyDirection`(新增,与 `withItemDirection` 同一套纪律)。

**Tech Stack:** TypeScript(strict)、vitest、Obsidian API(`Menu`、`setIcon`)。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §5.4
**Mockup(定稿):** https://claude.ai/code/artifact/95978151-658d-4965-89b5-5ff04e598370 —— 图 07(Keys 区)、图 08(键走不出它的项)、图 09(没有 Keys 区的四种情形)

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b / 3c / 3d | 数据模型 → 逐项方向 → 派生 lock → 逐键扣留 → 键级的一致 | **DONE**,均已合入 main |
| **3e** | **本文件** | 卡片的 Keys 区(键级规则的写入口) |
| 3f | 并发(3.7) | 计划未写 |
| 4 | 加密(3.8/3.9) | 未开始 |

## Global Constraints

- **mockup 即终稿。** 图 07/08/09 里画了什么就实现什么,一个字不多。三句结构说明逐字取自 spec:
  - 整份加密:`This file is stored as one encrypted blob — it travels whole or not at all.`
  - 非 JSON:`No keys in this file — it travels whole or not at all.`
  - 文件夹:`A folder travels as a whole — the direction above covers every file in it.`
- **整项 `Neither way` 时 `Keys` 那一行完全不渲染** —— 不留分隔线、不留高度。正上方就写着 `Neither way`,再说一遍是复述,而既有规矩正是「不建值的行完全不渲染」(`renderCardKeyRow` 的空值即丢弃)。
- **设备关系一个像素都不许变。** Settings 那块 `KEY RULES` 抽出形状之后必须与今天逐像素一致 —— 既有测试全绿,外加一次截图比对。
- **键名原样显示。** 任意插件的键没有人话名表,面板显示的就是 JSON 里那个键。
- **写只有一条路**:`withKeyDirection`。读只有一条路:`keyDirection`(`core/remoteRules.ts`)。
- **默认不落盘**(与 `withItemDirection` 同):`Both ways` 的键规则不存,连带空 `keys` 映射与空 item 条目一并清掉,文档里只留用户真做过的决定。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/remoteRules.ts`(改) | `withKeyDirection` 写入口、`keyStopsWithin` 提供某一项之下键可选的档位 |
| `src/ui/jsonView.ts`(改) | 新增 `renderJsonKeyDoc` —— 文档的**形状**渲染器,分类由调用方给 |
| `src/ui/SettingTab.ts`(改) | 既有那块改用共享渲染器,行为与像素不变 |
| `src/ui/SyncCenterView.ts`(改) | `Keys` 区:行、四档控件、三句说明、文档与点击建规则 |
| `src/ui/panelModel.ts`(改) | `withheldKeysClause` —— `On pull` / `On push` 点名被扣下的键 |
| `src/main.ts`(改) | host 新增 `setRemoteKeyDirection` 与 `storeCopyOf` |
| 测试 | `tests/remoteRules.test.ts`、`tests/panelModel.test.ts`、`tests/json-view.test.ts`、`tests/itemCard.test.ts` |

---

### Task 1:键级的写入口

**Files:**
- Modify: `src/core/remoteRules.ts`
- Test: `tests/remoteRules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function withKeyDirection(items: RemoteItems | undefined, ref: ItemRef, pattern: string, direction: RemoteDirection): RemoteItems | undefined
  // 某一项之下,一个键还能选哪几档:整项允许的方向的子集(spec 2.2)
  export function keyStopsWithin(item: RemoteDirection): RemoteDirection[]
  ```

- [ ] **Step 1: 写失败测试**

追加到 `tests/remoteRules.test.ts`:

```ts
describe("withKeyDirection", () => {
  it("stores a key's decision under its item, leaving the item's own direction alone", () => {
    const next = withKeyDirection({ community: { dataview: { direction: "push" } } }, "community/dataview", "apiKey", "none");
    expect(next).toEqual({ community: { dataview: { direction: "push", keys: { apiKey: { direction: "none" } } } } });
  });

  it("creates the item entry when the key is the first decision made about it", () => {
    expect(withKeyDirection(undefined, "community/dataview", "apiKey", "pull")).toEqual({
      community: { dataview: { keys: { apiKey: { direction: "pull" } } } },
    });
  });

  it("never stores the default: setting a key back to Both ways removes its rule", () => {
    const rules: RemoteItems = { community: { dataview: { keys: { apiKey: { direction: "none" }, other: { direction: "pull" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toEqual({
      community: { dataview: { keys: { other: { direction: "pull" } } } },
    });
  });

  it("drops an item that carries nothing else once its last key rule goes", () => {
    const rules: RemoteItems = { community: { dataview: { keys: { apiKey: { direction: "none" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toBeUndefined();
  });

  it("keeps an item whose own direction is still a decision", () => {
    const rules: RemoteItems = { community: { dataview: { direction: "pull", keys: { apiKey: { direction: "none" } } } } };
    expect(withKeyDirection(rules, "community/dataview", "apiKey", "both")).toEqual({ community: { dataview: { direction: "pull" } } });
  });

  it("ignores a ref no build of this parser accepts", () => {
    const rules: RemoteItems = { community: { dataview: { direction: "pull" } } };
    expect(withKeyDirection(rules, "nonsense" as ItemRef, "k", "none")).toEqual(rules);
  });
});

describe("keyStopsWithin", () => {
  it("offers every stop under an item that travels both ways", () => {
    expect(keyStopsWithin("both")).toEqual(["both", "push", "pull", "none"]);
  });

  it("offers only what the item still allows, so a key can never travel further than its item", () => {
    expect(keyStopsWithin("pull")).toEqual(["pull", "none"]);
    expect(keyStopsWithin("push")).toEqual(["push", "none"]);
  });

  it("leaves one stop under an item that travels neither way", () => {
    expect(keyStopsWithin("none")).toEqual(["none"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRules.test.ts`
Expected: FAIL —— 两个导出都不存在。

- [ ] **Step 3: 写实现**

`src/core/remoteRules.ts`:

```ts
// Write one key's direction inside one item. Same discipline as withItemDirection: the default is
// never stored, an entry that carries nothing else is removed, and an empty map becomes undefined —
// a document only ever holds decisions somebody actually made. The item's own direction is untouched
// here; the two are separate decisions that intersect at READ time (keyDirection).
export function withKeyDirection(
  items: RemoteItems | undefined,
  ref: ItemRef,
  pattern: string,
  direction: RemoteDirection
): RemoteItems | undefined {
  const parsed = parseItemRef(ref);
  if (parsed === null) return items;
  const next: RemoteItems = {};
  for (const [s, byId] of Object.entries(items ?? {})) next[s] = { ...byId };
  const bucket = { ...(next[parsed.section] ?? {}) };
  const existing = bucket[parsed.id];
  const keys = { ...(existing?.keys ?? {}) };
  if (direction === "both") delete keys[pattern];
  else keys[pattern] = { direction };
  const itemDir = existing?.direction;
  const rule: RemoteItemRule = {};
  if (itemDir !== undefined) rule.direction = itemDir;
  if (Object.keys(keys).length > 0) rule.keys = keys;
  if (Object.keys(rule).length === 0) delete bucket[parsed.id];
  else bucket[parsed.id] = rule;
  if (Object.keys(bucket).length === 0) delete next[parsed.section];
  else next[parsed.section] = bucket;
  return Object.keys(next).length === 0 ? undefined : next;
}

// The stops a KEY can be set to under an item with this direction: those that survive the
// intersection unchanged (spec 2.2). A menu that offered more would let a click write a rule the
// reader immediately resolves to something else — the control would be lying about its effect.
export function keyStopsWithin(item: RemoteDirection): RemoteDirection[] {
  return REMOTE_DIRECTIONS.filter((d) => intersectDirection(item, d) === d);
}
```

`REMOTE_DIRECTIONS` 是本文件的一个常量 `["both", "push", "pull", "none"] as const`(与 `SyncCenterView` 的 `REMOTE_DIRECTION_ORDER` 同序 —— **不要**从 UI 层 import,顺序是数据侧的事实,UI 那张表只是它的显示名)。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `npx vitest run tests/remoteRules.test.ts`

```bash
git add src/core/remoteRules.ts tests/remoteRules.test.ts
git commit -m "feat(core): a key's own direction, written the way an item's already is"
```

---

### Task 2:Keys 区的行与控件

**Files:**
- Modify: `src/ui/SyncCenterView.ts`(`renderThisRemoteRow` 下方新增 `renderRemoteKeysRow`;卡片装配处调用)
- Modify: `src/main.ts`(host 新增 `setRemoteKeyDirection`)
- Modify: `styles.css`(键行的两列布局)
- Test: `tests/itemCard.test.ts`

**Interfaces:**
- Consumes:`withKeyDirection` / `keyStopsWithin` / `keyDirection` / `itemDirection`
- Produces:
  - `SyncCenterHost.setRemoteKeyDirection(remoteName: string, ref: ItemRef, pattern: string, direction: RemoteDirection): Promise<void>`
  - 私有 `renderRemoteKeysRow(fields: HTMLElement, r: StatusRow): void`

**这一行的四种形态(图 09):**

| 情形 | 渲染 |
|---|---|
| 整项 `Neither way` | **整行不渲染** |
| 整份加密的项 | `Keys` 行,值是那句 `This file is stored as one encrypted blob — it travels whole or not at all.` |
| 非 JSON 的整文件项 | 同上,`No keys in this file — it travels whole or not at all.` |
| 文件夹项 | 同上,`A folder travels as a whole — the direction above covers every file in it.` |
| 其余(文件型 JSON 项) | 已设规则的键各一行 + `Click any key to add a rule for it` + 文档(Task 3) |

- [ ] **Step 1: 写失败测试**

`tests/itemCard.test.ts` 续写(该文件已有卡片行的 DOM 断言写法,照抄其夹具搭法):

```ts
describe("the Keys row under a remote", () => {
  it("renders nothing at all when the item travels neither way — the row above already said so", () => {
    // rules: { community: { dataview: { direction: "none" } } }
    expect(cardLabels()).not.toContain("Keys");
  });

  it("says why a folder has no keys instead of leaving a gap", () => {
    expect(keysRowText("snippets")).toBe("A folder travels as a whole — the direction above covers every file in it.");
  });

  it("says why a whole-file-encrypted item has no keys", () => {
    expect(keysRowText("secrets")).toBe("This file is stored as one encrypted blob — it travels whole or not at all.");
  });

  it("lists one row per key that already has a rule, and nothing for the rest", () => {
    // rules: { community: { dataview: { keys: { apiKey: { direction: "none" } } } } }
    expect(keyRowNames()).toEqual(["apiKey"]);
  });

  it("shows each key's resolved direction, narrowed by its item's own", () => {
    // item pull only + key push only => resolves to Neither way
    expect(keyRowValue("apiKey")).toBe("Neither way");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/itemCard.test.ts -t "Keys row"`
Expected: FAIL —— 还没有这一行。

- [ ] **Step 3: 写实现**

`renderRemoteKeysRow` 的骨架(与 `renderThisRemoteRow` 同一段落,紧随其后调用):

```ts
  // spec 5.4's `Keys`: which way each KEY of this item flows with the remote on screen. The shape is
  // Settings' own `KEY RULES` block, deliberately — same rows, same `Click any key…` line, same
  // document underneath — because it is the same gesture asked about a different axis. An item that
  // travels neither way renders nothing: the row above it already says so, and repeating it is the
  // restatement the card's "no value, no row" rule exists to prevent.
  private renderRemoteKeysRow(fields: HTMLElement, r: StatusRow): void {
    const relation = this.relation;
    if (relation.kind !== "remote") return;
    const ref = this.itemRefFor(r.group.name) ?? r.group.ref ?? null;
    const remote = this.host.remotes().find((x) => x.name === relation.name);
    if (ref === null || remote === undefined) return;
    const item = itemDirection(remote.items, ref);
    if (item === "none") return;
    const why = keylessReason(r.group); // one of spec 5.4's three sentences, or null
    this.renderCardKeyRow(fields, "Keys", (value) => {
      if (why !== null) {
        value.createSpan({ cls: "config-sync-cardnote", text: why });
        return;
      }
      for (const pattern of Object.keys(keyRulesFor(remote.items, ref))) {
        this.renderKeyRuleRow(value, relation.name, ref, item, pattern);
      }
      this.renderKeyDocument(value, r, remote.name, ref, item); // Task 3
    });
  }
```

`keylessReason(group)` 放 `ui/panelModel.ts`(纯函数,可单测):文件夹 → 文件夹那句;整份加密 → 加密那句;非 `.json` 的文件项 → 非 JSON 那句;其余 → null。判定沿用既有件(`isWholeFileEncrypted`、`group.type`),**不要**在这里新写一套「这个项有没有键」的规则 —— `core/keyWithholding.ts` 的 `relCanHaveKeys` 已经是那条规则,两处必须同口径。

单个键那一行:

```ts
  private renderKeyRuleRow(value: HTMLElement, remoteName: string, ref: ItemRef, item: RemoteDirection, pattern: string): void {
    const row = value.createDiv({ cls: "config-sync-keyrule-row" });
    row.createSpan({ cls: "config-sync-keyrule-name", text: pattern });
    const current = keyDirection(this.remoteItemsFor(remoteName), ref, pattern); // RESOLVED, not stored
    // The chip says what actually happens to this key. A stored rule the item has narrowed reads as
    // the narrower answer — spec 2.2 keeps the stored value as written, and widening the item again
    // restores it.
    this.renderMenuChip(row, REMOTE_DIRECTION_LABEL[current], REMOTE_DIRECTION_ICON[current], () => {
      const menu = new Menu();
      for (const d of keyStopsWithin(item)) {
        menu.addItem((mi) =>
          mi.setTitle(REMOTE_DIRECTION_LABEL[d]).setIcon(REMOTE_DIRECTION_ICON[d]).setChecked(d === current)
            .onClick(() => void this.host.setRemoteKeyDirection(remoteName, ref, pattern, d).then(() => this.reload()))
        );
      }
      return menu;
    });
  }
```

`renderMenuChip` 若 `renderCardMenuRow` 内已有等价私有件就复用它的内核,别复制一份菜单装配。

`src/main.ts` 的 host,与 `setRemoteItemDirection` 并排,同样的三步收尾:

```ts
      setRemoteKeyDirection: async (remoteName, ref, pattern, direction) => {
        if (!this.settingsWritable()) return;
        this.settings.remotes = this.settings.remotes.map((r) => (r.name === remoteName ? { ...r, items: withKeyDirection(r.items, ref, pattern, direction) } : r));
        await this.saveSettings();
        this.clearReaderCache();
        await this.refreshRemoteChecks();
      },
```

**`Keys` 标签下的 `limited by This remote` 小字(图 08):** 只在 `keyStopsWithin(item).length < 4` 时渲染,挂在标签下方(`cardRowShell` 的 label span 里追加一个 `config-sync-explabel-sub`)。

- [ ] **Step 4: 跑测试确认通过并提交**

```bash
git add src/ui/SyncCenterView.ts src/ui/panelModel.ts src/main.ts styles.css tests
git commit -m "feat(panel): each key's own direction, on the card of the item it lives in"
```

---

### Task 3:文档与「点一个键就建规则」

**Files:**
- Modify: `src/ui/jsonView.ts`(新增形状渲染器)
- Modify: `src/ui/SettingTab.ts`(改用它,像素不变)
- Modify: `src/ui/SyncCenterView.ts`(卡片里渲染文档)
- Modify: `src/main.ts`(host 新增 `storeCopyOf`)
- Test: `tests/json-view.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ui/jsonView.ts —— 只管形状:文档逐行画出来,键可点,分类由调用方给
  export function renderJsonKeyDoc(el: HTMLElement, opts: {
    doc: Record<string, unknown>;
    classOf: (key: string) => string | null;   // 该键额外挂的 class(调用方的分类)
    clickable: (key: string) => boolean;
    onPick: (key: string) => void;
    decorate?: (key: string, span: HTMLElement) => void; // 例如加密锁字形
  }): void

  // SyncCenterHost
  storeCopyOf(ref: ItemRef): Promise<Record<string, unknown> | null>;
  ```

**为什么抽形状而不抽整块:** 两处的**分类**是两个不同的事实 —— Settings 那边给键上色说的是「谁共享这个值」,这里说的是「往哪个方向流」。把颜色也做成参数就是把两个问题塞进一个函数;把形状留在两处则是同一段 DOM 写两遍。分界线划在「画什么」与「凭什么上色」之间。

- [ ] **Step 1: 写失败测试**

`tests/json-view.test.ts` 续写:

```ts
describe("renderJsonKeyDoc", () => {
  it("draws every top-level key of the document, in the document's own order", () => { /* … */ });
  it("only makes clickable keys clickable, and a click reports the key it was on", () => { /* … */ });
  it("hangs the caller's class on the keys the caller claims, and nothing on the rest", () => { /* … */ });
});
```

- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**

先在 `ui/jsonView.ts` 落地渲染器(把 `SettingTab.renderJsonPreviewInto` 里那段 `pre` 逐行循环原样搬过去,`kc`/`jsonKeyClass` 的调用换成 `classOf`/`decorate`)。

然后 `SettingTab` 改为调用它,自身只保留分类与写入。**验收:`npx vitest run` 全绿,并对 Settings 的 Dataview 卡片截一张图与改动前比对,逐像素一致**(截图诀窍见 memory:Settings 是独立窗口,用 `@electron/remote` 的 `capturePage`)。

最后 `SyncCenterView.renderKeyDocument`:

```ts
  // The document itself, folded away by default: a plugin with forty keys must not push the rest of
  // the card off screen the moment it is expanded. The line above it is not a button — it says the
  // keys below can be clicked, exactly as Settings' own block does.
  private renderKeyDocument(value: HTMLElement, r: StatusRow, remoteName: string, ref: ItemRef, item: RemoteDirection): void {
    const hint = value.createDiv({ cls: "config-sync-json-hint" });
    setIcon(hint.createSpan(), "plus");
    hint.appendText("Click any key to add a rule for it");
    if (!this.keyDocOpen.has(r.group.name)) return;   // toggled by clicking the hint
    void this.host.storeCopyOf(ref).then((doc) => {
      if (doc === null) return;
      renderJsonKeyDoc(value.createEl("pre", { cls: "config-sync-json-pre" }), {
        doc,
        // A key that already carries a rule is coloured, the rest wear the dashed "clickable"
        // underline — the same two states Settings shows, answering this axis' question.
        classOf: (key) => (keyDirection(items, ref, key) === "both" ? null : "config-sync-json-key-ruled"),
        clickable: (key) => keyDirection(items, ref, key) === "both",
        onPick: (key) => void this.host.setRemoteKeyDirection(remoteName, ref, key, "none").then(() => this.reload()),
      });
    });
  }
```

**点一下建的是 `Neither way`,不是默认档。** 理由写进注释:remote 的默认是 `Both ways`,而默认按纪律根本不落盘 —— 建一个默认档等于什么都没发生,那一行不会出现,点击看起来失灵。会来点这里的人要的就是「这个键别过去」;要只推或只拉,那一行的控件就在正上方,再点一下。

`src/main.ts` 的 `storeCopyOf`:读该 ref 的 store 主文件、`JSON.parse`,读不到 / 不是 JSON / 是密文信封时答 `null`(那三种情形 Task 2 已经用文字解释过,不会走到这里)。

- [ ] **Step 3: 提交**

```bash
git add src/ui tests/json-view.test.ts src/main.ts
git commit -m "feat(panel): the item's own document, one click from a key to a rule"
```

---

### Task 4:`On pull` / `On push` 点名被扣下的键

**Files:**
- Modify: `src/ui/panelModel.ts`(新增 `withheldKeysClause`)
- Modify: `src/ui/SyncCenterView.ts`(`stateClauseText` 的 remote 分支)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function withheldKeysClause(input: { remote: string; item: string; direction: "pull" | "push"; keys: readonly string[] }): string | null
  ```

**定稿文案(mockup 图 07):**

- 推,一个键:`Overwrites this remote's Dataview. prettyRenderInlineFields keeps whatever main already has.`
- 推,两个键:`… prettyRenderInlineFields and tableIdColumnName keep whatever main already has.`
- 推,三个以上:`… prettyRenderInlineFields, tableIdColumnName and 2 more keys keep whatever main already has.`
- 拉,同构:`Takes this remote's Appearance. accentColor keeps your value.`(复数 `keep your values.`)

**点名的是哪些键:** 那个方向上**走不动**的键,由 `withheldPatternsFor(items, ref, dir)` 给出(3c 已有)。推的时候点 `Neither way` 与 `Pull only` 的键;拉的时候点 `Neither way` 与 `Push only` 的。一个 `Push only` 的键在推送方向照常过去,不点名。

- [ ] **Step 1: 写失败测试**

```ts
describe("withheldKeysClause", () => {
  const push = (keys: string[]): string | null => withheldKeysClause({ remote: "main", item: "Dataview", direction: "push", keys });

  it("says nothing when nothing is held back", () => {
    expect(push([])).toBeNull();
  });

  it("names one key, and says whose value survives", () => {
    expect(push(["apiKey"])).toBe("Overwrites this remote's Dataview. apiKey keeps whatever main already has.");
  });

  it("names two", () => {
    expect(push(["apiKey", "theme"])).toBe("Overwrites this remote's Dataview. apiKey and theme keep whatever main already has.");
  });

  it("names two and counts the rest", () => {
    expect(push(["a", "b", "c", "d"])).toBe("Overwrites this remote's Dataview. a, b and 2 more keys keep whatever main already has.");
  });

  it("pull speaks of YOUR value, since that is the side being preserved", () => {
    expect(withheldKeysClause({ remote: "main", item: "Appearance", direction: "pull", keys: ["accentColor"] })).toBe(
      "Takes this remote's Appearance. accentColor keeps your value."
    );
  });
});
```

- [ ] **Step 2: 实现,跑通,接线**

`stateClauseText` 的 remote 分支:当该项在这个方向上有被扣下的键时,用这句**替换**方向句(它已经把方向说清楚了:`Overwrites…` / `Takes…`);没有则保持现状。

- [ ] **Step 3: 提交**

```bash
git add src/ui tests/panelModel.test.ts
git commit -m "feat(panel): the card says which keys stay behind, and whose value survives"
```

---

### Task 5:真机冒烟

**Files:** 无(验证任务)

夹具与 3c/3d 同一套。**本轮的重点是:此前只能手写 `data.json` 的那些规则,现在全程用面板做出来。**

- [ ] **Step 1** `npm run smoke:install`,`obsidian command id=app:reload`,并把 remote 的 `items` 清空(从零开始)。
- [ ] **Step 2** 展开 `Dataview` → `Keys` → 点开文档 → 点一个键。断言:该键出现在上面的行里,档位是 `Neither way`;`data.json` 里出现 `items.community.dataview.keys.<key>.direction: "none"`。
- [ ] **Step 3** 把该键改成 `Push only`,再改回 `Both ways`。断言:改回之后**那一行消失**,`data.json` 里那一项的 `keys` 连同空条目一并清掉。
- [ ] **Step 4** 把整项设成 `Pull only`。断言:键的菜单只剩两档;`Keys` 标签下出现 `limited by This remote`。
- [ ] **Step 5** 把整项设成 `Neither way`。断言:`Keys` 那一行**整行消失**,没有留下分隔线或空隙。
- [ ] **Step 6** 三种没有键的项各展开一次(文件夹 / 非 JSON / 整份加密),断言三句文案逐字正确。
- [ ] **Step 7** 全程结束后跑一次 Push,去对面核对那个被扣下的键值原封未动(spec 验收第 4 条,这次全部经由 UI 设置)。
- [ ] **Step 8** 切回设备关系,与 3d 的截图比对:**逐像素一致**。

---

### Task 6:文档追平

- [ ] `docs/design/DESIGN.md`:Unified card 一节补 `Keys` 区的四种形态与它与 Settings `KEY RULES` 的对应关系。
- [ ] `docs/ARCHITECTURE.md`:`ui/jsonView.ts` 补形状渲染器一条(为什么抽形状不抽分类);`core/remoteRules.ts` 补 `withKeyDirection` / `keyStopsWithin`。
- [ ] `docs/GUIDE.md`:怎么设一个键的方向(展开项 → Keys → 点键),以及被扣下的键在两个方向上各自会发生什么。
- [ ] `CHANGELOG.md`:

> Added a per-key choice about what each remote gets. Open an item while a remote is selected, click any key in it, and that key stops travelling — the rest of the item still does. Each key can travel both ways, only out, only in, or not at all, and never further than the item it lives in

```bash
git add docs CHANGELOG.md
git commit -m "docs: setting one key's direction with a remote"
```

---

## 完成标准

- 三绿,lint 不超基线。
- Task 5 八步全过,其中第 8 步是设备关系逐像素不变。
- **spec 验收第 3/4 条这次全程经由 UI 完成** —— 3c 的冒烟是手写 `data.json` 做的,本轮把那条路补上。
- `grep -rn "keys" src/ui/SettingTab.ts` 里那块 `KEY RULES` 的行为与像素不变。

## 交给 3f / Plan 4 的边界

- **并发**(3.7)在 3f。
- **加密项的键级扣留**(3.9 第四个使用点)在 Plan 4:异密码时每个加密字段都要过一遍明文。本轮的 Keys 区对字段级加密的项照常列键(加密的那几个带 `lock` 字形),对整份加密的项只说明。
- **一处已知的手感缺口,本轮不补:** 一个键的存值被整项收窄时(存 `Push only`、整项 `Pull only`、解析成 `Neither way`),控件显示的是**解析后**的档位,而菜单里点中它会把存值改写成它。要修就得在行里多一句「set to Push only — limited by This remote」,那是新文案,得先过 mockup。图 08 的 `limited by This remote` 只解释了「为什么档位变少」,没解释「你原来存的是什么」。
