# UI 反馈第 2 轮实现计划(app.json 合并卡 + 面板产品化)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-07-26-ui-feedback-round2-design.md` 落地:app.json 三卡合一并删除整套切片机制、配置就地归并、卡片字典序、"+ Add folder" 放开到所有卡、面板文案产品化、文档同步。

**Architecture:** 引擎先行(registry/catalog/types/modes/manifest 删除 appSlices 机制,app 走通用单文件编译),随后 settings 归并 normalizer,再 UI 层清理(shared 联动/门控),最后文案与文档。每步删多加少。

**Tech Stack:** TypeScript(Obsidian plugin)、vitest、eslint。

## Global Constraints

- **绝不创建 git commit**(全部改动保持未提交,与既有批次同批等 cut);绝不添加任何 Claude/AI 署名。
- 面板文案必须逐字使用 spec §3.1 的定稿字符串;spec 未列的字符串改写需在任务报告中给出 before/after 清单。
- 新卡 def:`id: "app"`、label `App settings`、编译组名保持 `"app"`(store 路径不变)。
- 归并遍历顺序 `editor → files-links → other → appearance(仅 showInlineTitle)`,同 pattern 首见者胜;归并必须幂等。
- 门:`npx tsc --noEmit` 干净;`npx vitest run` 全绿;`npx eslint .` 0 error 且 warning 不高于基线 64;完成后 `npm run smoke:install`。
- 仓库根:`~/local/coding/open/obsidian-config-sync`。不得触碰任何真实 vault;dev vault 验证由控制器执行,不在子代理任务内。

---

### Task 1: 引擎 — 删除 app-slice 机制,app 单卡编译

**Files:**
- Modify: `src/core/catalog.ts`(删 27–77 行的映射机制;改 `OPTION_LABELS["app.json"]` 描述)
- Modify: `src/core/types.ts`(删 `SyncGroup.appSlices`、`AppSliceFlags`)
- Modify: `src/core/registry.ts`(defs 重写、compileAppGroup/compileAppearance 删除、compileItems 通用化、groupOwners/companionConflict 简化)
- Modify: `src/core/modes.ts`(删 `isDisabledSliceKey`/`disabledSlicePatterns` 及全部调用点)
- Modify: `src/core/manifest.ts`(删 `appSlices` 解构与校验分支)
- Delete: `tests/appSlices.test.ts`、`tests/appTabs.test.ts`
- Test: `tests/registry.test.ts`、`tests/catalog.test.ts`、`tests/modes.test.ts`、`tests/manifest.test.ts`、`tests/companions.test.ts`、`tests/customGroups.test.ts`、`tests/schemaGate.test.ts`、`tests/mainReloadSettings.test.ts`(受影响用例改造,不是整体删除)

**Interfaces:**
- Consumes: 现状代码。
- Produces: `OBSIDIAN_CARD_DEFS` 含 `id:"app"` 的普通单文件 def;`compileItems` 对所有 def 走 `compileSingleFile(def.id, def, cfg, () => false)` + `compileCompanions`;`ItemDef.settingsFile` 不再有 `appSlice` 字段;`SyncGroup` 不再有 `appSlices`。Task 2/3 依赖这些形态。

- [ ] **Step 1: registry defs 重写**

`OBSIDIAN_CARD_DEFS` 替换为(描述为 spec §3.1 定稿文案):

```ts
const OBSIDIAN_CARD_DEFS: readonly Omit<ItemDef, "section">[] = [
  {
    id: "app",
    label: "App settings",
    description: "Editing, new-note and link behavior, and other general options.",
    settingsFile: { defaultPath: "{configDir}/app.json" },
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, fonts and CSS snippets.",
    settingsFile: { defaultPath: "{configDir}/appearance.json" },
    presetCompanions: [{ path: "{configDir}/themes" }, { path: "{configDir}/snippets", mapKey: "enabledCssSnippets" }],
  },
  {
    id: "hotkeys",
    label: "Hotkeys",
    description: "Your custom keyboard shortcuts.",
    settingsFile: { defaultPath: "{configDir}/hotkeys.json" },
  },
] as const;
```

同文件删除:`APP_SLICE_CARD_IDS`、`APP_JSON_PATH`(改由 def 走通用编译,synthetic claim 不再需要;`companionConflict` 的 app.json 特判与 `APP_JSON_CONFLICT_LABEL` 一并删除——defs 循环里 `app` def 的 settingsFile 检查已覆盖同一路径,冲突提示自然变成 `App settings`)。`ItemDef` 类型中删除 `settingsFile.appSlice` 字段(在 registry.ts 或 types.ts,以实际定义处为准)。

- [ ] **Step 2: compileItems 通用化**

删除 `compileAppGroup`、`compileAppearance` 两个函数;`compileItems` 的主体改为:

```ts
export function compileItems(defs: ItemDef[], settings: CompileSettings): SyncGroup[] {
  const groups: SyncGroup[] = [];
  const seenPaths = new Map<string, string>();

  for (const def of defs) {
    const cfg = configFor(settings, def.id);
    const group = compileSingleFile(def.id, def, cfg, () => false);
    if (group !== null) {
      claimPath(seenPaths, def.id, group.path);
      groups.push(group);
    }
    for (const g of compileCompanions(def.id, cfg)) {
      claimPath(seenPaths, def.id, g.path);
      groups.push(g);
    }
  }

  // …(core-plugins / community-plugins 载体与 compileCustomGroups 段落原样保留)
}
```

`compileSingleFile` 的 `excludeKey` 参数此后恒为 `() => false`:删掉该参数与 `fieldsFromRules`/`perItemFromMap` 的 exclude 逻辑(签名收窄为无过滤),同步更新 `withSelfPresets` 上游调用。`CompileSettings` 类型删除 `appJson` 字段。

- [ ] **Step 3: groupOwners 简化**

删除 `out` 初始化里的 `app:` 特殊条目(含注释),初始化为 `{}`——defs 循环里 `app` def 自然产出 `out["app"] = [{ itemId: "app" }]`。

- [ ] **Step 4: catalog/types/modes/manifest 删除**

- catalog.ts:删 `AppJsonTab`、`APP_JSON_TAB_MAP`、`appTabFor`、`AppSliceKey`、`APP_TAB_TO_SLICE_KEY`;`OPTION_LABELS["app.json"]` 描述改为 `"Editing, new-note and link behavior, and other general options."`。
- types.ts:删 `AppSliceFlags` 与 `SyncGroup.appSlices`。
- modes.ts:删 `isDisabledSliceKey`、`disabledSlicePatterns` 及全部调用点(调用处按"空 pattern 列表"化简,即直接移除拼接)。
- manifest.ts:删 `appSlices` 解构、`isValidAppSlices` 校验分支与回填。

- [ ] **Step 5: 测试改造**

删除 `tests/appSlices.test.ts`、`tests/appTabs.test.ts`。其余受影响用例:凡构造 `{ items, appJson, customGroups }` 的 CompileSettings 去掉 `appJson`;凡断言四卡合流/切片过滤的用例改为单卡断言。`tests/registry.test.ts` 新增:

```ts
it("compiles the app card as an ordinary single-file group named 'app'", () => {
  const defs = buildItemDefs({ cores: [], plugins: [], betaIds: new Set() });
  const groups = compileItems(defs, {
    items: { app: { enabled: true, companions: [], settingsFile: { mode: "fields", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} } } },
    customGroups: [],
  });
  const app = groups.find((g) => g.name === "app");
  expect(app).toMatchObject({ path: "{configDir}/app.json", type: "file", mode: "fields" });
  expect(app?.fields).toEqual([{ pattern: "vimMode", scope: "desktop", encrypted: false }]);
  expect(app && "appSlices" in app).toBe(false);
});
```

(字段名/工厂函数以该测试文件现有惯例为准,保持同风格。)

- [ ] **Step 6: UI 层最小解链(仅为编译通过)**

本任务只做"让引用消失",不做 UI 行为重构(Task 3 负责):`itemCard.ts` 删 `isSharedAppSliceCard`、`modeWriteTarget`、`SHARED_APP_MODE_HINT`、`sliceKeysForCard`、`sliceDocForCard`、`FROM_APP_JSON_BADGE`,`cardBodyPlan` 收窄为 `mode` 单参(`fields → "fields"`,否则 `"plainFileRow"`,删 `"previewOnly"`);`SettingTab.ts` 删 `setAppJsonMode`、`renderSharedAppCards`、`cardWraps`、`· shared` span、`SHARED_APP_MODE_HINT` 渲染行及各 `modeWriteTarget(def) === "appJson"` 分支(统一走 `updateItem` 路径);`main.ts` 的 `ConfigSyncSettings`/`DEFAULT_SETTINGS` 删 `appJson`(compileItems 调用点同步收窄)。`tests/itemCard.test.ts` 相应用例改造。

- [ ] **Step 7: 门**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 全绿,0 error。

---

### Task 2: settings 归并 normalizer

**Files:**
- Modify: `src/core/settingsMigration.ts`(新增 `mergeLegacyAppSliceItems`)
- Modify: `src/main.ts`(load 路径调用;归并发生则保存一次)
- Test: `tests/migration.test.ts`(或 `tests/schemaGate.test.ts`,以两文件现有职责划分为准——归并属于 v2 形态修订,不是 schema gate)

**Interfaces:**
- Consumes: Task 1 的 `items.app` 形态。
- Produces: `mergeLegacyAppSliceItems(settings: <load 处的可变 settings 形态>): boolean` — 就地归并,返回"是否发生改动"。

- [ ] **Step 1: 失败测试**

```ts
it("merges legacy editor/files-links/other + appJson.mode into items.app, idempotently", () => {
  const s = baseSettings({
    items: {
      editor: { enabled: true, companions: [], settingsFile: { mode: "plain", rules: { vimMode: { scope: "desktop", encrypted: false } }, perItem: {} } },
      "files-links": { enabled: false, companions: [], settingsFile: { mode: "plain", rules: { userIgnoreFilters: { scope: "desktop", encrypted: false } }, perItem: { userIgnoreFilters: { a: "all" } } } },
      other: { enabled: false, companions: [] },
      appearance: { enabled: true, companions: [], settingsFile: { mode: "plain", rules: { showInlineTitle: { scope: "all", encrypted: false }, cssTheme: { scope: "all", encrypted: false } }, perItem: {} } },
    },
    appJson: { mode: "fields" },
  });
  expect(mergeLegacyAppSliceItems(s)).toBe(true);
  expect(s.items.app).toMatchObject({ enabled: true, settingsFile: { mode: "fields" } });
  expect(s.items.app.settingsFile.rules).toEqual({
    vimMode: { scope: "desktop", encrypted: false },
    userIgnoreFilters: { scope: "desktop", encrypted: false },
    showInlineTitle: { scope: "all", encrypted: false },
  });
  expect(s.items.app.settingsFile.perItem).toEqual({ userIgnoreFilters: { a: "all" } });
  expect(s.items.appearance.settingsFile.rules).toEqual({ cssTheme: { scope: "all", encrypted: false } });
  expect(s.items.editor).toBeUndefined();
  expect((s as Record<string, unknown>).appJson).toBeUndefined();
  expect(mergeLegacyAppSliceItems(s)).toBe(false); // idempotent
});
```

- [ ] **Step 2: 实现**

```ts
// v2 形态修订(spec 2026-07-26 §2.3):三张 app.json 切片卡 + settings.appJson 归并为单一
// "app" item。appearance 借渡键只有 showInlineTitle(历史上唯一),迁移点固化这个快照,
// 不依赖已删除的 appTabFor。同 pattern 首见者胜,顺序 editor → files-links → other → appearance。
const LEGACY_APP_SLICE_IDS = ["editor", "files-links", "other"] as const;
const APPEARANCE_BORROWED_KEYS = ["showInlineTitle"] as const;

export function mergeLegacyAppSliceItems(settings: {
  items: Record<string, ItemConfig>;
  appJson?: { mode: "plain" | "fields" };
}): boolean {
  const legacy = LEGACY_APP_SLICE_IDS.filter((id) => settings.items[id] !== undefined);
  if (legacy.length === 0 && settings.appJson === undefined) return false;

  const rules: Record<string, ItemFieldRule> = {};
  const perItem: Record<string, PerItemScopes> = {};
  let enabled = false;
  for (const id of LEGACY_APP_SLICE_IDS) {
    const cfg = settings.items[id];
    if (cfg === undefined) continue;
    enabled = enabled || cfg.enabled;
    for (const [k, r] of Object.entries(cfg.settingsFile?.rules ?? {})) if (!(k in rules)) rules[k] = r;
    for (const [k, p] of Object.entries(cfg.settingsFile?.perItem ?? {})) if (!(k in perItem)) perItem[k] = p;
    delete settings.items[id];
  }
  const appearance = settings.items["appearance"];
  for (const key of APPEARANCE_BORROWED_KEYS) {
    const r = appearance?.settingsFile?.rules[key];
    if (r !== undefined && !(key in rules)) rules[key] = r;
    if (appearance?.settingsFile !== undefined) {
      delete appearance.settingsFile.rules[key];
      delete appearance.settingsFile.perItem[key];
    }
  }
  settings.items["app"] = {
    enabled,
    companions: [],
    settingsFile: { ...defaultSettingsFile(), mode: settings.appJson?.mode ?? "fields", rules, perItem },
  };
  delete settings.appJson;
  return true;
}
```

(`defaultSettingsFile`/`ItemFieldRule`/`PerItemScopes` 的实际导出位置以代码为准;若 `defaultSettingsFile` 在 UI 层,复制其字面量而非引入跨层依赖。)

- [ ] **Step 3: main.ts 接线**

load 流程中、schema gate 通过之后:`if (mergeLegacyAppSliceItems(this.settings)) await this.saveSettings();`(以现有 load/recompile 顺序为准,归并必须先于首次 compileItems)。

- [ ] **Step 4: 门**

Run: `npx vitest run tests/migration.test.ts && npx tsc --noEmit`
Expected: PASS。

---

### Task 3: UI — 合并卡行为、Add folder 放开、区标题

**Files:**
- Modify: `src/ui/SettingTab.ts`、`src/ui/itemCard.ts`、`styles.css`
- Test: `tests/itemCard.test.ts`、`tests/companions.test.ts`

**Interfaces:**
- Consumes: Task 1 后的单卡形态(Task 1 Step 7 已做编译级解链;本任务做行为收尾)。
- Produces: 最终 UI 行为,Task 4 文案走查在其上进行。

- [ ] **Step 1: 残余 shared 痕迹清零**

检索 `SettingTab.ts`/`itemCard.ts`/`styles.css` 中 `shared`/`slice`/`appJson` 的全部残留(含 CSS 类 `config-sync-card-modechip-shared`、aria 文案分支),删除;`modeChipLabel` 若带 shared 参数则收窄。

- [ ] **Step 2: "+ Add folder" 放开**

- itemCard.ts:删除 `hasCompanionZone`。
- SettingTab.ts `renderItemCard`:无条件调用 `renderCompanionZone`。
- `renderCompanionZone` 开头改为:

```ts
private renderCompanionZone(exp: HTMLElement, def: ItemDef, cfg: ItemConfig, wrap: HTMLElement): void {
  const rows = buildCompanionRows(def, cfg);
  if (rows.length > 0) exp.createDiv({ cls: "config-sync-explabel", text: "Companion folders" });
  const listEl = exp.createDiv({ cls: "config-sync-card-companions" });
  for (const row of rows) {
    // …现有行/成员锚点逻辑不变…
  }
  this.renderAddCompanionRow(exp, def, wrap);
}
```

- [ ] **Step 3: 区标题与成员 hint(spec §3.1)**

- `Data file` 区标题 → `File preview`;空预览 `no local file to preview` → `No file on this device yet — nothing to preview.`。
- snippets 成员列表尾部 hint:`Files always sync — each snippet's choice here is where it's turned on.`;普通目录成员列表尾部 hint:`This folder syncs as a whole — everything in it goes to the devices selected above.`(两处均用现有 `config-sync-card-sfhint`/等价 hint 样式,列表为空时不渲染 hint)。

- [ ] **Step 4: 测试 + 门**

`tests/companions.test.ts` 或 `tests/itemCard.test.ts` 补一条:`buildCompanionRows` 为空的 def 也能走到 Add 入口所需的纯函数路径(若 Add 入口无纯函数测点,以"`hasCompanionZone` 已删除、renderCompanionZone 无条件调用"的编译事实 + 控制器实机验证覆盖,并在报告中说明)。

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 全绿。

---

### Task 4: 排序 + 文案走查

**Files:**
- Modify: `src/core/registry.ts`(buildItemDefs 排序 + core/community 描述)、`src/ui/SettingTab.ts`/`src/ui/itemCard.ts`(剩余字符串)、`src/core/catalog.ts`(section 描述如需)
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: Task 1–3 后的最终结构。
- Produces: 面板全部用户可见文案定稿;def 顺序确定。

- [ ] **Step 1: 失败测试(排序)**

```ts
it("sorts core and community defs by display label", () => {
  const defs = buildItemDefs({
    cores: [
      { id: "graph", name: "Graph view", fileExists: true },
      { id: "backlink", name: "Backlinks", fileExists: true },
    ],
    plugins: [
      { id: "b-plug", name: "Zebra" },
      { id: "a-plug", name: "alpha" },
    ],
    betaIds: new Set(),
  });
  const coreLabels = defs.filter((d) => d.section === "core").map((d) => d.label);
  const commLabels = defs.filter((d) => d.section === "community").map((d) => d.label);
  expect(coreLabels).toEqual(["Backlinks", "Graph view"]);
  expect(commLabels).toEqual(["alpha", "Zebra"]);
});
```

- [ ] **Step 2: 实现排序**

`buildItemDefs` 中 return 前:

```ts
const byLabel = (a: ItemDef, b: ItemDef): number => a.label.localeCompare(b.label, "en", { sensitivity: "base" });
core.sort(byLabel);
communityAndBeta.sort(byLabel);
```

- [ ] **Step 3: 描述文案(spec §3.1 逐字)**

- `corePluginDescription`:有文件 → `Settings and on/off state.`;无文件 → `On/off state — no saved settings on this device yet.`
- community/beta def description → `Plugin files, settings and on/off state.`

- [ ] **Step 4: 全量字符串走查**

对 `SettingTab.ts`/`itemCard.ts`/`registry.ts`/相关 Modal 的用户可见字符串按 spec §3 原则过一遍(实现细节退场、描述行为)。第 1 轮已定稿的图例行与校验错误文案不动。报告中列出 spec 表之外的每处 before/after。

- [ ] **Step 5: 门**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 全绿,eslint 0 error、warning ≤ 64。

---

### Task 5: 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-unified-card-design.md`(§5、§10 修订注记,指向新 spec,不重写原文)
- Modify: `README.md`、`README.zh.md`(卡片清单/app.json 描述;**逐行 1:1 对齐**,完成后 `wc -l` 两文件行数必须相等)
- Modify: `docs/design/DESIGN.md`、`docs/design/ARCHITECTURE.md`(如提及 appSlices/共享切片/shared chip,同步删除)

**Interfaces:**
- Consumes: Task 1–4 的最终行为。
- Produces: docs-currency 达标(memory 规则:README+zh/ARCHITECTURE/DESIGN 与用户可见变化同批)。

- [ ] **Step 1: 修订四处文档**(内容以最终代码行为为准;README 双语行数校验 `wc -l README.md README.zh.md` 相等)
- [ ] **Step 2: 门**:`npx vitest run`(防误动)。

---

## 收尾(控制器执行,不派子代理)

1. 全量门:`npx tsc --noEmit && npx vitest run && npx eslint . && npm run build`。
2. `npm run smoke:install` 部署 dev vault;`cd dev/vault` 后经 obsidian-cli reload + eval 实机验证:①Obsidian tab 仅 3 卡、无 `· shared`;②App settings 抽屉含 `spellcheckLanguages`/`showInlineTitle` 等键、mode chip 正常;③任一社区卡抽屉底部有 `+ Add folder`(无伴生目录时无区标题);④core 卡字典序;⑤归并 normalizer 在 dev vault 旧 data.json 上实际跑通(items.app 出现、旧键删除)。
3. 最终 whole-branch review(requesting-code-review 模板、最强模型)。
4. 更新 `.superpowers/sdd/progress.md` 与 memory(`config-sync-0.22-backlog.md`)。
