# 卡片视觉整理实现计划(控件图标化 + mode 派生化 + 渐进披露)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec `docs/superpowers/specs/2026-07-26-card-visual-refresh-design.md` 落地:四列控件栅格、✎/↺/🔒 图标化、mode chip 删除并派生化、逐键行只列已配置规则、预览与成员列表默认折叠、+ Add folder 降级文本行、文档同步。

**Architecture:** 模型层先行(itemCard.ts 纯函数:deriveMode、规则行 builder、旧 helper 删除),再 Settings file 区 UI 重构(SettingTab.ts zone ②),再栅格/伴生/披露(zone ①③ + CSS),最后文档。引擎零改动(fileRule/fields 互斥、compile 全部沿用)。

**Tech Stack:** TypeScript(Obsidian plugin)、vitest、eslint。

## Global Constraints

- **绝不创建 git commit**(全部改动保持未提交);绝不添加任何 Claude/AI 署名。
- 副本逐字用 spec §5:tooltip `Custom path` / `Reset to default path` / `Encrypt` / `Encrypted` / `Per-key rules are active — remove them to control the whole file again` / `Remove rule`;披露行 `File preview`;成员计数 `· N themes` / `· N files`。删除副本:`(entire file)`、`Plain ▾`/`Fields ▾`、复选框标签 `Encrypt`、开关标签 `Custom path`。
- 图标用 Obsidian `setIcon`:pencil / rotate-ccw / lock;不得用 emoji 字符。
- 动作位图标默认隐藏,行 `:hover` 与 `:focus-within` 显现;自定义路径已提交时 ✎ 常显高亮。
- `settingsFile.mode` 存储字段保留,仅由 UI 派生写入;首条规则创建时丢弃 fileRule;存量配置零迁移。
- 保持第 1 轮防抖机制(refreshCardBadges/refreshCardBody、sfbodyhost/memberhost 锚点)与第 3 轮 Enabled on 单行。
- 门:`npx tsc --noEmit`、`npx vitest run` 全绿、`npx eslint .` 0 error 且 warning ≤ 64、`npm run smoke:install`。
- 仓库根 `~/local/coding/open/obsidian-config-sync`;不碰任何真实 vault;dev vault 实机验证由控制器执行。

---

### Task 1: 模型层 — deriveMode / 规则行 builder / 旧 helper 删除

**Files:**
- Modify: `src/ui/itemCard.ts`(修改 114-151 区域及相关)
- Test: `tests/itemCard.test.ts`

**Interfaces:**
- Consumes: 现状 `ItemSettingsFile`(rules/perItem/fileRule/mode)、`FieldRowModel`。
- Produces(Task 2/3 依赖):
  - `deriveMode(sf: ItemSettingsFile): "plain" | "fields"` — rules 或 perItem 非空 → fields,否则 plain。
  - `hasKeyRules(cfg: ItemConfig): boolean` — 同一判定的 ItemConfig 便捷形式(settingsFile 缺省 → false)。
  - `buildRuleRows(def: ItemDef, cfg: ItemConfig, liveDoc: Record<string, unknown>): FieldRowModel[]` — **只含已配置键**(rules ∪ perItem 的键),沿用 FieldRowModel 形状(isArray 仍从 liveDoc 判定;键不在 liveDoc 时 isArray=false);取代全量 buildFieldRows 在 UI 的使用。
  - `memberCountLabel(isThemesPreset: boolean, n: number): string` — `· ${n} themes` / `· ${n} files`。
  - 删除:`modeChipLabel`、`cardBodyPlan`、`CardBodyPlan`;`effectiveMode` 若仅剩测试引用则一并删除(以 grep 为准);`buildFieldRows` 若 Task 2 后无调用方则删除(在本任务标记 deprecated 注释,由 Task 2 收尾删除并在报告注明)。

- [ ] **Step 1: 失败测试**

```ts
describe("deriveMode / hasKeyRules (spec 2026-07-26-card-visual-refresh §3)", () => {
  it("empty rules+perItem derives plain; any rule or perItem derives fields", () => {
    const empty: ItemSettingsFile = { mode: "plain", rules: {}, perItem: {} };
    expect(deriveMode(empty)).toBe("plain");
    expect(deriveMode({ ...empty, rules: { a: { scope: "desktop", encrypted: false } } })).toBe("fields");
    expect(deriveMode({ ...empty, perItem: { arr: { x: "desktop" } } })).toBe("fields");
    expect(hasKeyRules(cfg())).toBe(false);
  });
});

describe("buildRuleRows", () => {
  it("lists ONLY configured keys, not every live-doc key", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: { ruled: { scope: "desktop", encrypted: false } }, perItem: {} } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { ruled: 1, unruled: 2 });
    expect(rows.map((r) => r.key)).toEqual(["ruled"]);
  });

  it("includes perItem-only keys and marks isArray from the live doc", () => {
    const c = cfg({ settingsFile: { mode: "fields", rules: {}, perItem: { list: { a: "desktop" } } } });
    const rows = buildRuleRows(HOTKEYS_DEF, c, { list: ["a"] });
    expect(rows).toEqual([expect.objectContaining({ key: "list", isArray: true, perItemEnabled: true })]);
  });
});
```

Run: `npx vitest run tests/itemCard.test.ts` — 期望 FAIL(符号不存在)。

- [ ] **Step 2: 实现**

```ts
// Derived mode (spec 2026-07-26-card-visual-refresh §3): the stored mode is written by the UI,
// never chosen by the user — any per-key customization (a rule OR a per-item map, incl. snippet
// member scopes on enabledCssSnippets) makes the card per-key ("fields"); none makes it
// whole-file ("plain").
export function deriveMode(sf: ItemSettingsFile): "plain" | "fields" {
  return Object.keys(sf.rules).length > 0 || Object.keys(sf.perItem).length > 0 ? "fields" : "plain";
}

export function hasKeyRules(cfg: ItemConfig): boolean {
  return cfg.settingsFile !== undefined && deriveMode(cfg.settingsFile) === "fields";
}

// Rule rows list ONLY configured keys (rules ∪ perItem) — browsing the file's full key set is
// the File preview's job now. Key order: rules first (insertion order), then perItem-only keys.
export function buildRuleRows(def: ItemDef, cfg: ItemConfig, liveDoc: Record<string, unknown>): FieldRowModel[] {
  const sf = cfg.settingsFile;
  if (sf === undefined) return [];
  const keys = [...Object.keys(sf.rules), ...Object.keys(sf.perItem).filter((k) => !(k in sf.rules))];
  return keys.map((key) => ({
    key,
    isArray: Array.isArray(liveDoc[key]),
    rule: sf.rules[key] ?? { scope: "all", encrypted: false },
    perItemEnabled: key in sf.perItem,
  }));
}

export function memberCountLabel(isThemesPreset: boolean, n: number): string {
  return isThemesPreset ? `· ${n} themes` : `· ${n} files`;
}
```

删除 `modeChipLabel`/`cardBodyPlan`/`CardBodyPlan` 及其测试;`FieldRowModel` 形状不变。

- [ ] **Step 3: 门**

**本任务只动 itemCard.ts + tests/itemCard.test.ts**;删除 `modeChipLabel`/`cardBodyPlan` 会让 SettingTab.ts 暂时编译失败,这是预期的(Task 2 立即消除)。Task 1 的门:`npx vitest run tests/itemCard.test.ts` 绿 + `npx eslint src/ui/itemCard.ts tests/itemCard.test.ts` 0 error;全仓 tsc 门由 Task 2 承担。

---

### Task 2: Settings file 区重构(zone ②)

**Files:**
- Modify: `src/ui/SettingTab.ts`(627-1010 区域:renderHeaderModeChip 删除、renderSettingsFileZone/renderSettingsFilePathControl/renderCardSettingsBody/renderFieldsRows/renderFieldRow/renderPlainFileRow/addRuleForKey)
- Modify: `styles.css`
- Test: `tests/itemCard.test.ts`(applyPerItemToggle 等既有用例维持)、`tests/settingtab-commit.test.ts`(如触及)

**Interfaces:**
- Consumes: Task 1 的 `deriveMode`/`hasKeyRules`/`buildRuleRows`。
- Produces: 新私有 helper `renderLockToggle(cell: HTMLElement, opts: { encrypted: boolean; disabled: boolean; onChange: (v: boolean) => void }): void`(Task 3 的行也用它的 CSS 类);四列栅格 CSS 类 `config-sync-grid`(grid-template-columns 以现 scope chip 宽度为准定宽)。

- [ ] **Step 1: 头行 chip 删除**

`renderItemCard` 中 `renderHeaderModeChip` 调用与方法体删除(627-655 一带);头行恢复 `名字+徽章+开关`。

- [ ] **Step 2: 路径行 = 栅格首行**

`renderSettingsFileZone`(699-722)重构:
- 区标题 `Settings file` 保留。
- 路径行:`config-sync-grid` 四列 — 路径 mono | scope 下拉 | 🔒 | ✎。
  - **无逐键规则**(`!hasKeyRules(cfg)`):scope 下拉读写 `settingsFile.fileRule.scope`,🔒 读写 `fileRule.encrypted`——**读写语义逐字搬现 renderPlainFileRow(922-940)**,含"scope=All 且未加密时 fileRule 写回 undefined"之类的既有归一行为(以现代码为准,不改语义只改形态);下拉选项集沿用现 Plain 行的无-local 选项集;值类改动走 `refreshCardBadges`。
  - **有逐键规则**:scope 下拉与 🔒 禁用置灰(`.config-sync-dim`),容器 title/aria = spec 置灰 tooltip。
  - ✎:默认 `config-sync-ghost`(hover/focus-within 显现);点击进入现 `customPathEditing` 输入流程(commit/校验/错误行全部复用);已提交自定义路径时 ✎ 加 `.is-active` 常显,并在动作位旁渲染 ↺(`rotate-ccw`,tooltip `Reset to default path`,点击 = 现"关闭 Custom path 回默认"的提交路径)。
- `renderPlainFileRow`(922-940)删除;`(entire file)` 文案删除。
- 旧 `Custom path` toggle 渲染(renderSettingsFilePathControl 内)删除,方法收编为路径行的一部分。

- [ ] **Step 3: 规则行 + 预览披露**

`renderCardSettingsBody`(818-850)重构:
- 不再按 plan 分支:先渲染 `buildRuleRows` 的规则行(有则),再渲染披露行 `▸ File preview`。
- 规则行(改造 renderFieldRow 854-899):`config-sync-grid` — key(沿用键色着色)| scope 下拉 | 🔒(renderLockToggle,`encryptToggleDisabled` 沿用)| ✕(ghost,tooltip `Remove rule`,点击删除该键的 rules+perItem 条目并按 deriveMode 回写 mode,`refreshCardBadges + refreshCardBody`)。数组键的 Per-item scopes 开关与逐元素行(901-919)保留现交互,元素行套入栅格(元素名 | scope | 空 | 空)。
- 披露行:UI-transient `private previewOpen = new Set<string>()`(key=def.id);折叠时**不读文件**——将 `renderSettingsFileZone` 中的异步 `readItemFile` 移到披露展开回调里;展开渲染现预览 + 图例(968-1010 的 addRuleForKey 点键路径不变,但创建规则时:`mode` 派生写 fields、若有 fileRule 一并删除——单次 updateItem 完成)。
- `refreshCardBody` 适配:swap 目标包含规则行与(展开时的)预览。

- [ ] **Step 4: mode 派生写入**

所有写 `settingsFile` 的 updateItem 路径统一经一个私有 helper(如 `withDerivedMode(sf): ItemSettingsFile` → `{ ...sf, mode: deriveMode(sf), ...(deriveMode(sf) === "fields" ? { fileRule: undefined } : {}) }`),落点:addRuleForKey、规则行 scope/🔒/✕、Per-item 开关、snippet 成员 scope 写入(1275-1300)。

- [ ] **Step 5: CSS**

```css
.config-sync-grid { display: grid; grid-template-columns: 1fr var(--cs-scope-w, 120px) 28px 28px; align-items: center; column-gap: 8px; }
.config-sync-ghost { opacity: 0; transition: opacity 0.12s; }
.config-sync-grid:hover .config-sync-ghost, .config-sync-grid:focus-within .config-sync-ghost, .config-sync-ghost.is-active { opacity: 1; }
.config-sync-lock { color: var(--text-muted); }
.config-sync-lock.is-on { color: var(--interactive-accent); background: var(--background-modifier-hover); border-radius: var(--radius-s); }
.config-sync-dim { opacity: 0.4; pointer-events: none; }
```

(类名/变量与现有 styles.css 命名风格对齐;旧 `config-sync-card-fieldrow` 等被替换的类连带清理。)

- [ ] **Step 6: 门**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 全绿,0 error,warning ≤ 64。

---

### Task 3: 栅格贯通(zone ①③)+ 成员折叠 + Add folder 降级

**Files:**
- Modify: `src/ui/SettingTab.ts`(renderEnabledOnZone、renderCompanionZone/renderCompanionRow 1071-1190、renderSnippetMembers/renderPlainCompanionMembers 1191-1310、renderAddCompanionRow)
- Modify: `styles.css`
- Test: `tests/itemCard.test.ts`(memberCountLabel 已在 Task 1)、`tests/companions.test.ts`(如触及)

**Interfaces:**
- Consumes: Task 2 的 `config-sync-grid`/`config-sync-ghost`/`renderLockToggle` CSS 约定、Task 1 的 `memberCountLabel`。
- Produces: 最终 DOM 结构,控制器实机验证的对象。

- [ ] **Step 1: Enabled on 行入栅格**

renderEnabledOnZone 改为 `config-sync-grid`:标签在内容列(沿用 `config-sync-explabel-inline`),scope 下拉入 scope 列,后两列空。

- [ ] **Step 2: 伴生目录行入栅格 + ✎/✕ ghost 化**

renderCompanionRow:目录名(+成员计数,见 Step 3)| scope 下拉 | 小开关 | ✎(用户目录另有 ✕,与 ✎ 同列组;两图标均 ghost)。

- [ ] **Step 3: 成员折叠**

- 目录行内容列 = `名字` + `memberCountLabel(isThemesPreset, n)` + ▸/▾;点击内容区切换,状态存 UI-transient `private membersOpen = new Set<string>()`(key=`${def.id}:${row.path}`)。
- 成员扫描仍在 renderCompanionZone 同步锚点 + 异步填充:折叠时只把计数写进目录行(计数需要扫描结果——异步返回后就地补 `· N files` 文本);展开时渲染成员行(snippets:名 | scope 下拉;plain:仅名)+ 对应 hint。hint 随成员展开出现。
- snippets 成员 scope 下拉入 scope 列(不再顶右缘)。

- [ ] **Step 4: + Add folder 降级**

renderAddCompanionRow 的按钮样式改文本行(`config-sync-add-row` 改链接态样式或换类),交互不变。

- [ ] **Step 5: 门**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 全绿。

---

### Task 4: 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-unified-card-design.md`(§4/§10 修订注记)、`docs/superpowers/specs/2026-07-26-ui-feedback-round2-design.md`(§3.1 File preview 行为注记)
- Modify: `README.md`、`README.zh.md`(1:1,`wc -l` 相等)
- Modify: `docs/design/DESIGN.md`、`docs/ARCHITECTURE.md`

**Interfaces:** Consumes Task 1-3 最终行为(以代码为准);Produces docs-currency。

- [ ] **Step 1**: 修订注记 + README 卡片描述改派生 mode/渐进披露现状(mode chip、Plain/Fields、(entire file)、Custom path toggle、全量键列表等表述全部更新);DESIGN/ARCH 同步。
- [ ] **Step 2**: `wc -l README.md README.zh.md` 相等;`npx vitest run` 全绿(防误动)。

---

## 收尾(控制器执行)

1. 全量门 + `npm run build` + `npm run smoke:install`。
2. dev vault 实机:①头行无 chip;②默认展开卡片行数(Appearance ≈5 行);③路径行 scope/🔒 写 fileRule 且徽章联动;④预览折叠默认、展开后点键加规则 → 文件行置灰 + mode=fields + fileRule 清除;⑤删光规则回 plain、文件行恢复可用;⑥成员计数/展开、snippets scope 列对齐;⑦✎ hover 显现、自定义路径 ✎ 高亮 + ↺ 还原;⑧Add folder 文本行。
3. 最终 whole-branch review(最强档模型)。
4. ledger + memory 更新。
