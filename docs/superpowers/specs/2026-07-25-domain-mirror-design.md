# Domain mirror + key-level device-class partition (归域 + 阶段 2) — Design

> **SUPERSEDED** by `2026-07-25-unified-card-design.md`(mockup v7 定稿)。本文描述的 v3 版 UI(app-view 行、appearance-domain 容器、互斥五选一规则)将被统一卡设计取代;引擎部分(sidecar 分区、capture/apply/diff)仍然有效并被新设计继承。

定稿依据:mockup artifact **domain-merge-v3**(2026-07-25,用户定稿:**候选 A,其余按 mockup**)。
前置:`2026-07-24-scope-unification-design.md`(阶段 1,已实施、未提交)。本设计与阶段 1 同批次、同为未提交状态,base 不变。

## Goal

1. **归域**:config-sync 面板一项 = Obsidian 设置面板一项。Obsidian tab 顶层行变为 General / Editor / Files and links / Appearance / Hotkeys,与 Obsidian 侧栏一一对应。
2. **阶段 2 提前**:key 级设备类分区(store sidecar),补全 文件/键/成员 × all/desktop/mobile/local 矩阵;app.json 借此拆成三个 key-set 视图行。
3. **模型补丁**:伴生关系(companion relation)写入设计模型,为既有 switch-list 机制正名,不新增引擎机制。

## 1 模型补丁:域与伴生关系

**域(domain)** = Obsidian 设置面板的一项。域 = **载体**(carrier files/dirs)+ **状态键**(state keys)+ **伴生映射**(state key → asset members)。

**伴生不变量**:Apply 落地后状态与资产必须一致 —— 状态引用的成员必须存在;成员被 scope 走,则状态强制 off。orphan 清理与 force-off 都是这条不变量的执行,不是两个独立机制。

| 域 | 载体 | 状态键 | 伴生映射 |
|---|---|---|---|
| Appearance | appearance.json + themes/ + snippets/ | enabledCssSnippets, cssTheme | enabledCssSnippets → snippets/*.css(多值);cssTheme → themes/\<name\>(单值) |
| Community plugins | plugins/\<id\>/(含 data.json) | community-plugins.json 整文件 | list → plugins/\<id\>(多值) |
| Core plugins | \<id\>.json 各设置文件 | core-plugins.json 整文件 | map → 内置模块(多值,载体=设置文件) |
| General / Editor / Files and links / Hotkeys | app.json / hotkeys.json | — | 无伴生 |

引擎侧**零新机制**:多值伴生(switch list + force-off + orphan 清理)已实现;本节只在文档层面正名。单值伴生(cssTheme)**不建机制**(YAGNI)——值随 appearance.json 走,仅 UI 文案点明。

## 2 阶段 2 引擎:key 级设备类分区

### 2.1 FieldRule 扩展

`src/core/types.ts`:

```ts
export interface FieldRule {
  pattern: string;
  action: "strip" | "encrypt" | "desktop" | "mobile";  // 新增 desktop | mobile
}
```

- 每键单选,不组合(Encrypted 与类范围互斥)。
- **约束:`desktop` / `mobile` 只作用于顶层键**。`strip`/`encrypt` 保持现有任意深度 glob 语义不变;类分区规则匹配到嵌套键时忽略(重组需要位置信息,顶层浅合并足够覆盖 app.json 等目标文件,YAGNI)。

### 2.2 Store sidecar

```
store/<group>/
  <file>                   ← 公共区(All devices 的键)
  __scopes__/
    desktop.json           ← 桌面类区,仅桌面设备写入
    mobile.json            ← 移动类区,仅移动设备写入
```

sidecar 内容 = 扁平 JSON 对象 `{ key: value }`(该类范围的顶层键)。

**Capture(本机类 C)**,对每个顶层键按有效规则分流:
- All devices → 公共区文件;
- 类 = C → 写入 `__scopes__/C.json`(整文件重写:本次采集到的 C 类键集合;本地已删除的键随之消失并传播到同类设备);同时从公共区剔除;
- 类 ≠ C → 从公共区剔除,**不触碰**对侧 sidecar(由对侧设备维护);
- This device(strip)→ 跳过(现状);Encrypted → 公共区(密文,现状)。

**Apply(本机类 C)**:目标内容 = 公共区 ⊕ `__scopes__/C.json`(顶层浅合并),再走现有 apply 管线;This-device 键与对侧类键沿用现有 strip-preserve 路径保留本地值。

**Diff / status**:比较基准同 Apply 的重组结果(公共区 + 本类 sidecar)。

### 2.3 兼容性

Store 结构首次改变。旧客户端忽略 `__scopes__/`:Apply 丢类值、Capture 把类键写回公共区(分区退化为阶段 1 前行为,不损坏数据)。**Release notes 必须写明所有设备一并升级**,与阶段 1 的 memberScopes 兼容窗口(final-review finding ②)合并为同一条。

## 3 信息架构:Obsidian tab 顶层行

行序与 Obsidian 侧栏一致:**General → Editor → Files and links → Appearance → Hotkeys**(其后为 discovered dirs,不变)。

- 删除顶层行:App settings、Themes、CSS snippets、Enabled CSS snippets。
- 底层 SyncGroup **完全不变**(app / appearance / themes / snippets / enabled-css-snippets 虚拟组),无 settings 迁移;新行都是 UI 视图。
- app.json 不存在时,三个视图行全部进 "Not yet in this vault";Appearance 容器行在任一载体存在时即出现在 Available。
- Keychain 无配置文件,不进面板。

## 4 app.json 三视图行(key-set views)

### 4.1 类目映射

`src/core/catalog.ts` 新常量:

```ts
export type AppJsonTab = "general" | "editor" | "files-and-links";
export const APP_JSON_TAB_MAP: Record<string, AppJsonTab> = { /* seed 见下 */ };
```

Seed(取自真实 vault app.json,实施时对照 Obsidian 设置界面核对后定稿):
- **files-and-links**:attachmentFolderPath, alwaysUpdateLinks, newFileLocation, newLinkFormat, useMarkdownLinks, showUnsupportedFiles, userIgnoreFilters, trashOption, promptDelete
- **editor**:vimMode, propertiesInDocument, readableLineLength, spellcheck, strictLineBreaks, showLineNumber, livePreview, defaultViewMode, foldHeading, foldIndent, showIndentGuide, tabSize, useTab, autoPairBrackets, autoPairMarkdown, smartIndentList, rightToLeft
- **general(兜底)**:其余全部,含 pdfExportSettings、uriCallbacks、showInlineTitle(Obsidian UI 归 Appearance 但存于 app.json —— 已知近似,归 general,键照常同步)。

**未映射键一律归 general,同步永不丢键**。注意真实键名为 `userIgnoreFilters`(此前文档误写 userIgnoredFilters)。

### 4.2 Settings 与规则合成

`main.ts` settings 新字段(默认 `{}`,无迁移):

```ts
appJsonTabs: Partial<Record<AppJsonTab, { enabled?: boolean; devices?: "desktop" | "mobile" }>>;
// 缺省 = { enabled: true, devices: "all" };只存非默认值
```

顶层键 k 的**有效规则**(优先级从高到低):
1. 显式 FieldRule(匹配 k 的 glob);
2. 类目规则:t = APP_JSON_TAB_MAP[k] ?? "general";`enabled === false` → strip;`devices` 为类 → 该类 action;
3. 默认:无规则(All devices)。

合成发生在 capture/diff 装配处(与阶段 1 的 per-group mask/forceOff 合成同层),modes.ts 只消费合成后的有效规则列表。

**Mode 锁**:任一类目非默认时,app group 的 mode 锁定为 Fields(沿 appearanceWithPreset 先例);三行显示同一 mode chip,标注 `shared`,任一行修改即修改 group。

### 4.3 行为语义

- 行级 devices 下拉 = 该类目全部键(含未来新键)的类范围;
- 行级 toggle off = 该类目全部键 strip(编译语义,group 本身仍开启;三行全 off 时 group 等效不采集 app.json 内容);
- 行尾成员徽章:按类目统计 `N device-scoped`(teal)/ `N this-device`(pink),0 隐藏;
- 抽屉 Field rules 只列本类目的键。

## 5 Appearance 容器行(候选 A)

顶层一行、不带控件;抽屉三区,每区自带完整控件,**独立开关互不牵连**。底层四个 group 不变,容器为纯 UI 组合。

- 行:name **Appearance**,desc `"Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab."`;行尾状态徽章 `settings ✓ / themes ✓ / snippets ✓` **只列开启面**;汇总成员徽章 `N device-scoped` / `N this-device`。
- 区 1 **Settings file**,hint `"appearance.json — theme choice, fonts, interface"`;控件 = devices 下拉 + mode 下拉 + toggle(即今日 Appearance 行控件平移)。Fields 模式下显示锁定行:🔒 `enabledCssSnippets` + `"locked — managed under CSS snippets → Device scope"`——**仅 Device scope 面开启时出现**(关闭时锁定规则本身也随 appearanceWithPreset 现状解除)。另一行 hint:`"The active theme (cssTheme) travels with this file."`
- 区 2 **Themes**,hint `"themes/ — installed theme files"`;控件 = devices 下拉 + toggle。
- 区 3 **CSS snippets**,hint `"snippets/ — the .css files"`;控件 = devices 下拉 + mode 下拉 + toggle。其内子区 **Device scope**,hint `"which snippets are on — appearance.json → enabledCssSnippets"`,自带 toggle;主体 = 阶段 1 已定稿的成员编辑器 + orphan 块,原样复用。

## 6 Field rules 抽屉 v2(所有 Fields 模式 group 通用)

- Heading `"Field rules"`,hint `"per-key device scope — one choice per key"`。
- 每键五选一下拉:**All devices / Desktop only / Mobile only / This device / Encrypted**(替代阶段 1 的 This device / Encrypted 双选;All devices = 无规则)。
- 类范围键 hint:`"each class keeps its own value"`。
- JSON 预览四色,legend 文案:`teal = encrypted · red = this device · blue = desktop only · amber = mobile only`。
- 对 appearance.json、hotkeys、插件 data.json 等所有 Fields group 同样生效,非 app.json 专属。

## 7 Copy 契约汇总(逐字)

| 位置 | 字符串 |
|---|---|
| General 行 desc | `Obsidian's General options (app.json). New or unrecognized keys land here.` |
| Editor 行 desc | `Editing behavior — live preview, spellcheck, line settings (app.json).` |
| Files and links 行 desc | `Attachments, link format, excluded files (app.json).` |
| Appearance 行 desc | `Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.` |
| mode chip(app 三行) | `Fields · shared`(下拉沿用现有 ▾ 形态) |
| Appearance 区 hints | 见 §5 引号内文案 |
| 锁定行 | `locked — managed under CSS snippets → Device scope` |
| cssTheme hint | `The active theme (cssTheme) travels with this file.` |
| Device scope 子区 hint | `which snippets are on — appearance.json → enabledCssSnippets` |
| 类范围键 hint | `each class keeps its own value` |
| JSON legend | `teal = encrypted · red = this device · blue = desktop only · amber = mobile only` |
| 状态徽章 | `settings ✓` / `themes ✓` / `snippets ✓` |

## 8 Docs & release notes

- README + README.zh(1:1)、ARCHITECTURE、DESIGN 同批更新:域/伴生词汇、五行 IA、sidecar 布局、Field rules 五选一、userIgnoreFilters 示例(更正键名)。
- Release notes 必备条款:store 新增 `__scopes__/`,**所有设备一并升级**(合并 finding ②);app.json 拆行与 Appearance 归域的 UI 变化;Field rules 新增 Desktop/Mobile only。

## 9 Out of scope

- Sync Center 面板 "excluded" 词汇 pass(final-review finding ①,cut 时决定);
- 插件/core 行的启用范围跨面可视化(下一轮迭代,连 finding ③);
- 单值伴生(cssTheme)机制化;嵌套键的类分区;
- key → tab 映射的运行时自动发现(硬编码表 + general 兜底,随 Obsidian 版本人工维护)。

## 9.5 实现细化(plan 阶段核对代码后决定,与 mockup 不冲突)

1. **Sidecar 路径**:file group 的 store 路径是平铺文件(如 `store/configdir/app.json`),没有组目录。sidecar 采用同级后缀文件:`<storePath>.__scopes__.<class>.json`(如 `store/configdir/app.json.__scopes__.desktop.json`)。`resolveGroupByStoreRel` 扩展匹配该后缀,使 leftover/merge 正确归属。
2. **显式 "all" 覆盖**:`FieldRule.action` 增加第五值 `"all"` —— 仅作为 app 视图行中"类目默认非 All、单键改回 All devices"的显式覆盖(优先级模型的补洞);引擎对 `"all"` 规则不做任何处理。普通 group 的规则编辑器不提供该值(删规则即回默认)。
3. **两种抽屉形态**:app 三视图行抽屉 = **键列表**(文件真实顶层键,按类目过滤),每键五选一(All devices / Desktop only / Mobile only / This device / Encrypted);其他 Fields group 保留现有**规则行**形态,动作由双按钮改为四选一下拉(This device / Encrypted / Desktop only / Mobile only),移除仍用 X。
4. **三行全关的语义**:任一视图行开启且 app group 不存在 → 创建;三行全部关闭 → 移除 app group(与今日关掉 App settings 行等效)。行级 enabled 存于 `appJsonTabs`。
5. **视图行徽章**:只统计**显式 per-key 规则**(desktop/mobile → `N device-scoped`,strip → `N this-device`);类目级 devices 已由行内下拉可见,不重复计入徽章。
6. **JSON 预览让色**:现有 viewer 中 amber=detected、blue=可点击(none)与定稿四色冲突;detected 改紫(`--color-purple`),none 改默认淡色。blue/amber 让给 desktop/mobile。legend 行按 §7 契约。

## 10 验证

**单测**:规则合成优先级(显式 > 类目 > 默认);sidecar capture/apply 双类往返(desktop 写 desktop.json、不触 mobile.json;apply 浅合并;删除键传播);未映射键兜底 general;类规则忽略嵌套键;mode 锁;panelModel 容器行聚合(状态徽章只列开启面、成员徽章汇总);三视图行 not-present 逻辑。

**dev vault 冒烟**:五行渲染与行序;`userIgnoreFilters` 设 Desktop only → capture 后值出现在 `__scopes__/desktop.json` 且公共区无此键 → apply 还原;行级 toggle off(Editor)后该类目键不进 store;Appearance 容器行展开三区、独立开关、Device scope 面关/开时 🔒 行消失/出现;JSON 预览四色;mode chip `Fields · shared` 三行联动。
