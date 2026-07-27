# Unified card design (统一卡 · 归域 v7) — Design

定稿依据:mockup artifact label **v7-final-panorama**(2026-07-25,用户 "ok" 定稿),及对话轮决策 D1–D13。
取代 `2026-07-25-domain-mirror-design.md`(v3 版 UI);继承其引擎部分(sidecar 分区、capture/apply/diff)。
基线:main 上未提交批次(阶段 1 scope-unification + v3 domain-mirror 实现,base = tag 1.9.0)。
升级策略:**阻断式**(D13)——不做任何数据迁移,不保留兼容窗口。

## Goal

1. **无差别**:每个待同步 item 都是同一张卡、同一渲染器、同一组交互原语。不存在 app-view、appearance-domain、switch-list 三套特例分支;聚合行(Enabled community / core plugins)取消。
2. **规则正交**:字段/文件规则 = {scope, encrypted} 二元组,自由组合;Plain 模式获得整文件加密。
3. **数组键逐项 scope**:字符串数组键可开启逐元素 scope——switch-list / memberScopes 机制由此正名为通用能力;snippets 启用、插件启用、userIgnoreFilters 是同一机制的三种呈现。
4. **镜像修正**:showInlineTitle 归 Appearance;General 行取消,无页面归属键进 Other 兜底。

## 决策总表(规范性,D1–D13)

| # | 决策 |
|---|---|
| D1 | 规则 = {scope, encrypted} 正交;scope ∈ all / desktop / mobile / local(This device);local 时加密禁用;Plain 模式支持整文件加密(新引擎能力) |
| D2 | 行级极简:名称 + 徽章 + 同步开关 + 箭头;抽屉三区 ① Enabled on(有启用状态才有)② Settings file ③ Companion folders(产品命名后置,暂用此名) |
| D3 | 数组键逐项 scope:字符串数组键提供 "Per-item scopes" 开关;对象数组不提供;encrypt 保持键级不下探 |
| D4 | 插件 Enabled on = community-plugins.json / core-plugins.json 数组元素 scope 的投影,显示在插件卡抽屉首行;行级徽章示非默认 |
| D5 | 聚合行取消;无设置文件的 core 插件全量列出为状态-only 卡;卡开关 off = 文件与启用状态一并退出同步(各设备各管各的) |
| D6 | Fields 的 key 来源:实际文件 key 列表 + JSON 预览点击加规则;手写 glob 输入去掉 |
| D7 | Settings file 支持自定义路径开关;预置路径修改警告确认;改路径视为新 item(旧 store 条目走既有 leftover 清理,不迁移) |
| D8 | Companion folders 通用区:任意 vault 相对路径;添加查重、与已有 item 路径冲突即拒绝;预置实例(snippets/、themes/)可修改但警告确认;成员行按映射分岔——有状态键映射(snippets)提供 chip 管启用+文件随行,无映射(plain 目录)本迭代 list-only,无逐项 chip(Task 7 定裁;chip 化留待未来引擎迭代) |
| D9 | Plain 文件级 scope 只有 All/Desktop/Mobile("不同步"只用卡开关表达,不提供 This device) |
| D10 | JSON 预览:scope 用色(blue=desktop / amber=mobile / red=this device),encrypted 用 🔒 图标叠加;逐项数组按元素着色 |
| D11 | Sync all = 本区所有卡开关,无特例;批量设 Enabled on 不做(YAGNI);敏感卡浮顶保留 |
| D12 | 映射按真实 Obsidian:showInlineTitle → appearance;general 类目取消,未映射键 → other 兜底置尾 |
| D13 | 阻断式升级:检测到旧 schema 直接提示重新配置;release notes 写明所有设备一并升级 |

## 1. 模型

**item 卡** = registry 条目,五要素:

- `id` — `editor` / `files-links` / `appearance` / `hotkeys` / `other` / `core:<id>` / `community:<id>`(Beta 复用 community 形态)
- **启用状态**(可选)— 所属启用数组(core-plugins.json / community-plugins.json)中本 item 的元素
- **Settings file**(可选)— 一个 JSON 载体或其**切片**(app.json 由四张卡共享切片)
- **Companion folders** — 目录列表(预置 + 用户添加)
- **伴生映射**(可选)— 状态键元素 → 资产成员(enabledCssSnippets → snippets/*.css;启用数组 → plugins/<id>/ 或内置模块)

**载体可共享,卡持有切片**:app.json 的键按 `APP_JSON_TAB_MAP` 归属四张卡(editor / files-links / appearance ⊂ {showInlineTitle} / other 兜底);community-plugins.json、core-plugins.json、enabledCssSnippets 按元素归属各卡/各成员。共享载体不再作为独立行出现。

**伴生不变量**(继承自 v3 spec):Apply 落地后状态与资产一致——状态引用的成员必须存在;成员被 scope 走则状态强制 off(force-off);orphan 清理是同一条不变量的执行。

## 2. 规则模型(D1)

```ts
// 取代现 FieldRule.action 互斥五选一
type RuleScope = "all" | "desktop" | "mobile" | "local"; // local = This device
interface FieldRule { scope: RuleScope; encrypted: boolean; }
```

语义矩阵(capture / apply):

| scope | encrypted=false | encrypted=true |
|---|---|---|
| all | 明文进公共区 | 密文进公共区(现 encrypt 行为) |
| desktop / mobile | 值进对应 `__scopes__` sidecar(现阶段 2 行为) | **密文进对应 sidecar**(新组合) |
| local | 不进 store,Apply 保留本地(现 strip 行为) | 组合非法:UI 禁用,manifest 校验拒绝 |

**Plain 模式文件级规则** = `{ scope: "all"|"desktop"|"mobile", encrypted }`(D9 无 local):
- scope 落到组级 devices 类(既有机制);
- `encrypted: true` = **整文件加密**(新能力):store 中该文件为密文封套(与字段加密同一 crypto 管线,payload 为整个文件内容);diff/预览显示 "encrypted file"。

引擎落点:`types.ts` FieldRule 重构 + `manifest.ts` 校验同步派生(吸取 v3 冒烟 CRITICAL 教训:类型与校验必须同源);`modes.ts` captureTransform / applyTransform / contentUnchanged 按二元组分流(desktop+encrypted → 先加密再入 sidecar);`jsonView.ts` KeyState 改为 {scope, encrypted} 双维着色。

## 3. 数组键逐项 scope(D3 / D4)

- 仅**字符串数组**键提供 "Per-item scopes" 开关;开启后每个元素一行 scope chip(All/Desktop/Mobile/This device);关闭则整键按普通规则同步。
- encrypt 保持键级:开启逐项的键不提供元素级加密。
- 引擎 = 既有 switch-list + memberScopes + memberLocal,无新算法;伴生行为(force-off、orphan 清理、文件随行)仅在 registry 声明了伴生映射的键上激活。

呈现规则(一个机制,三种呈现):

| 数组键 | 伴生映射 | 逐项行呈现位置 |
|---|---|---|
| 无映射(如 userIgnoreFilters) | — | Settings file 区,key 行下缩进就地展开 |
| enabledCssSnippets | item → snippets/*.css | 合并进 snippets/ 伴生目录成员列表(一个 snippet 只出现一行,chip 写状态、文件随行);Settings file 区该 key 只留指引行 |
| community-plugins.json / core-plugins.json(整文件即数组) | item → plugins/<id>/ 或内置模块 | 投影为各插件卡抽屉首行 Enabled on |

**卡开关 off 语义(D5/D7 裁定)**:插件卡 off → 其文件与其启用数组元素**一并退出同步**,元素按"各设备各管各的"处理(等效 This device),绝不把别设备的启用状态推给本机。

**snippets 启用总开关删除**:全部成员 This device 即等效关闭(与插件侧一致,无总开关)。

## 4. 卡片 UI(D2 / D6 / D7 / D10)

**行**:名称 + 徽章 + [mode chip] + 同步开关 + 展开箭头。徽章(按序):
`on: desktop` / `on: mobile` / `on: this device`(启用范围非默认,blue/amber/pink)、`N device-scoped`(teal)、`N encrypted`(teal)。
mode chip(2026-07-26 修订,用户要求 plain/field 上移到开关行):有设置文件的卡在头行、启用开关左侧渲染 `Plain ▾`/`Fields ▾`;app.json 共享切片卡再带 `· shared` 标记,任一处改动 → 其余共享卡头行 chip 联动刷新。状态-only 卡无 chip。(2026-07-26 第4轮修订:mode chip 整体删除,mode 变派生状态,不再有任何选择器出现在头行;详见 `2026-07-26-card-visual-refresh-design.md` §3。)

**抽屉区 ① Enabled on**(仅 core/community 插件卡):
一行 —— `Enabled on` + 四选一 chip。(2026-07-26 第3轮修订:压为单行,标签左、chip 右;hint 移入 chip 的 aria/tooltip 并去掉载体文件名,定稿文案 `Which devices turn this plugin on`。)

**抽屉区 ② Settings file**:
- 区头:`SETTINGS FILE` + 路径 code + `Custom path` 小开关(mode chip 已上移至卡片头行,见上,2026-07-26 修订)。(2026-07-26 第4轮修订:`Custom path` 开关删除,路径行动作位改 ✎ 图标;详见 `2026-07-26-card-visual-refresh-design.md` §2.2。)
- Custom path 开启 → 路径变输入框;预置路径修改弹警告确认;确认后旧 store 条目走 leftover 清理,新路径按新 item 采集(D7)。
- Fields:实际文件全部 key 逐行列出 —— `key` + scope chip + `☐/☑ Encrypt`;scope=This device 时 Encrypt 置灰。数组键多一个 `Per-item scopes` 小开关(D3)。不渲染 `array` 类开发者徽章(2026-07-26 修订:配置面板面向用户,不放代码/开发语义提示)。(2026-07-26 第4轮修订:mode chip 删除后 Plain/Fields 不再分列;规则行只列已配置的键,浏览全量 key 移交 File preview;`☐/☑ Encrypt` 复选框改 🔒 图标开关;详见 `2026-07-26-card-visual-refresh-design.md` §2.2/§3。)
- Plain:key 行消失,只剩一行文件级 [scope chip(无 This device)] + [Encrypt]。(2026-07-26 第4轮修订:Plain/Fields 分支表述已废——无逐键定制即整文件状态,scope/🔒 并入路径行本身,见上一条注记同一处新 spec。)
- Data file 预览:仅本卡切片;scope 着色 + 🔒 叠加;**点击 key 加规则**(保留);手写 glob 输入框删除(D6)。
- 状态-only 卡(无设置文件):区 ② 显示 hint `Settings appear here once <Name> writes <file>.`。

**抽屉区 ③ Companion folders**:
- 区头 `COMPANION FOLDERS`;每目录一行:路径 code + scope chip + 小开关 + (用户添加的)`✕`;末行 `+ Add folder`。
- 添加:任意 vault 相对路径;查重 + 与任何已有 item 的载体路径冲突即拒绝(明确报错,不静默)。
- 预置实例(appearance 卡的 themes/、snippets/):同一渲染;删除/改路径需警告确认(D8)。
- 成员行(展开目录后)按有无状态键映射分岔:有映射(snippets)→ 文件名 + scope chip,chip 写状态元素、文件随行;无映射(plain 目录,如 themes/ 的非 snippets 成员)→ **list-only**(仅文件名,本迭代无逐项 chip——引擎没有 plain 目录的逐成员 carry 机制;chip 化留待未来引擎迭代,Task 7 定裁)。hint 文案区分两种语义。

## 5. Tab 结构与镜像

**2026-07-26 修订**,详见 `2026-07-26-ui-feedback-round2-design.md` §2:本节描述的 Editor / Files and links / Appearance / Hotkeys / Other 五卡镜像结构与 app.json 四处共享切片机制已被取代——Editor / Files and links / Other 三张切片卡合并为单一 **App settings** 卡(整个 app.json,无切片),shared 机制整体删除;Obsidian tab 现为 **App settings / Appearance / Hotkeys** 三卡固定顺序。以下原文保留供历史参照,不再是当前行为。

**Obsidian tab** 行序:`Editor → Files and links → Appearance → Hotkeys → Other`(镜像侧栏;Other 兜底置尾,不冒充镜像项)。

- app.json 四处共享切片(editor / files-links / appearance ⊂ showInlineTitle / other):mode 为文件级属性,四处显示 `shared`,任一处改动即改;**四处全关才移除 app group**;单处关闭 = 该切片键退出同步(Apply 保留本地)。
- `APP_JSON_TAB_MAP` 修正(D12):showInlineTitle → appearance;general 类目删除,`appTabFor` 兜底改为 `"other"`。键永不丢失的保证不变。
- Appearance 卡:Settings file(appearance.json:cssTheme 等普通键 + enabledCssSnippets 指引行 + showInlineTitle 行带 `from app.json` 徽章)+ 预置伴生 themes/、snippets/(成员逐项)。
- Hotkeys 卡:单载体 Plain 默认,无启用、无键规则区。

**Community plugins tab**:`Sync all` 行(本区所有卡开关,D11)+ 每插件一张卡。Beta tab 同形态。
**Core plugins tab**:**全量列出**(D5)——有设置文件的为完整卡;从未配置过的为状态-only 卡(仅 Enabled on 区),设置文件出现后自动长出区 ②。

敏感卡浮顶保留(`sortBySensitiveFirst` 稳定分区,不改)。

## 6. 设置 schema(阻断式,D13)

新 schema(要点,精确形状由 plan 定):

```ts
interface ConfigSyncSettings {
  schemaVersion: 2;                       // 旧 data.json 无此字段或 <2 → 阻断
  items: Record<string, ItemConfig>;      // key = item id(§1)
  appJson: { mode: "plain" | "fields" };  // 文件级共享属性
  customGroups: CustomGroupConfig[];      // Advanced 页"自定义规则/发现的文件";无 ItemDef,按 SyncGroup 字面量持久化(task-8 concern fix,追加字段,缺省 = 空数组)
  // remotes / passphrase / 全局项照旧
}
interface ItemConfig {
  enabled: boolean;
  settingsFile?: {
    customPath?: string;                  // 未设 = registry 默认
    mode: "plain" | "fields";             // app.json 切片卡忽略,读 appJson.mode
    fileRule?: { scope: "all"|"desktop"|"mobile"; encrypted: boolean }; // Plain
    rules: Record<string, FieldRule>;     // Fields;app.json 键全库平铺存于所属卡
    perItem: Record<string, Record<string, RuleScope>>; // 数组键 → 元素 → scope
  };
  companions: { path: string; scope: "all"|"desktop"|"mobile"; enabled: boolean }[];
  enabledOn?: RuleScope;                  // 仅插件卡:启用数组元素 scope 投影
}
```

- 加载时检测旧 schema(存在 `groups`/`memberScopes` 等旧顶层键或缺 `schemaVersion`)→ Notice 提示"配置结构已升级,请重新配置同步项",以空配置启动;`settingsMigration.ts` 旧迁移路径删除。
- store 结构:沿用 v3 批次(`__scopes__` sidecar 等);新增整文件加密封套。无兼容窗口。

## 7. 剔除清单(1.9.0 及 v3 遗产)

1. 「Enabled community plugins」「Enabled core plugins」两行:copy、专属 Device scope 抽屉、UI 侧 switch-list 特例分支。
2. `kind:"app-view"` / `kind:"appearance-domain"` 两套渲染分支 → 统一卡渲染器 + registry。
3. Field rules 手写 glob 输入框;snippets 启用列表总开关。
4. Sync Center "excluded / Exclude" 旧词汇(阶段 1 finding ① 一并落地)。
5. `settingsMigration.ts` 旧版迁移路径;`appJsonTabs` 设置结构(被 §6 取代)。
6. 与新模型相悖的 1.9.0 样式残留(如 `.config-sync-act-btn` 文档提及等,plan 时逐一清点)。

## 8. 升级与发布说明义务

- Release notes(手写,per memory 规则)必须写明:**store 与设置结构均变化,所有设备一并升级并重新配置同步项**;合并既有两条兼容 finding(memberScopes 窗口、`__scopes__` sidecar)为这一条。
- 版本号:store + settings 双重破坏性变更,建议主升(plan/cut 时定)。

## 9. 验证

单元:规则矩阵(scope × encrypted 全组合含 sidecar+密文)、整文件加密往返、数组键逐项 merge 与呈现三分支、Enabled on 投影读写、卡 off 退出语义、APP_JSON_TAB_MAP 修正与 other 兜底、状态-only 卡、companion 添加查重/冲突拒绝、旧 schema 阻断。
dev-vault 冒烟(必须 `cd dev/vault`,严禁 repo 根直跑 obsidian-cli):五张 Obsidian 卡 copy 逐字核对;Dataview 卡全链路(Enabled on 改动 → community-plugins.json 元素 scope;apiKey 加密;desktop+encrypted 进 sidecar 密文);snippets 成员 chip 写 enabledCssSnippets + 文件随行;userIgnoreFilters 逐项;custom path 警告与 leftover;旧 data.json 注入验证阻断提示。

## 10. Copy 契约(逐字,来自 v7 mockup)

**2026-07-26 修订**,详见 `2026-07-26-ui-feedback-round2-design.md` §3.1:app.json 合并卡使下表部分行失效——`行描述 · Editor`/`· Files and links`/`· Other` 三行随三卡合并删除,统一为一条 App settings 描述 `Editing, new-note and link behavior, and other general options.`;`mode chip` 行的 `Plain ▾ · shared`/`Fields ▾ · shared` 变体删除(shared 机制消失,不再有 shared 后缀);`showInlineTitle hint` 行删除(app.json 不再是借渡键);`徽章` 行中的 `from app.json`/`shared slice` 删除;`enabledCssSnippets 指引`/`snippets 成员 hint` 两行文案改为 `Files always sync — each snippet's choice here is where it's turned on.`,并新增一条普通目录成员 hint `This folder syncs as a whole — everything in it goes to the devices selected above.`;区 ②(§4)预览标题 `Data file` → `File preview`,空预览提示改为 `No file on this device yet — nothing to preview.`。以下原表保留供历史参照,不再是当前行为。

**2026-07-26 第4轮修订**,详见 `2026-07-26-card-visual-refresh-design.md` §5:`mode chip` 行(`Plain ▾`/`Fields ▾` 及其变体)整体删除——mode 派生化,头行不再有任何选择器;`区 ② 控件` 行的 `Custom path`(开关标签)与 `☐ Encrypt`/`☑ Encrypt` 删除,分别改为 ✎ 图标(tooltip `Custom path`,已提交自定义路径旁另有 `Reset to default path` 的 ↺ 图标)与 🔒 图标(tooltip `Encrypt`/`Encrypted`);新增 `Per-key rules are active — remove them to control the whole file again`(置灰文件行 tooltip)与 `Remove rule`(规则行删除 tooltip)。以下原表对应行保留供历史参照,不再是当前行为。

| 位置 | 字符串 |
|---|---|
| 行描述 · Editor | `Editing behavior — live preview, spellcheck, line settings (app.json).` |
| 行描述 · Files and links | `Attachments, link format, excluded files (app.json).` |
| 行描述 · Appearance | `Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.` |
| 行描述 · Hotkeys | `Custom keyboard shortcuts.` |
| 行描述 · Other | `App settings without a page in Obsidian's settings window (app.json). New or unrecognized keys land here.` |
| 行描述 · community 插件 | `plugins/<id> — files, settings and enabled state.` |
| 行描述 · core 插件(有文件) | `<file> — settings and enabled state.` |
| 行描述 · core 插件(状态-only) | `Enabled state only — no settings file yet.` |
| Sync all | `Sync all` / `Toggle every plugin below.` |
| 区标题 | `Enabled on` · `Settings file` · `Companion folders` |
| Enabled on hint | `Which devices turn this plugin on`(2026-07-26 第3轮修订:单行布局,hint 为 chip 的 aria/tooltip,不再含载体文件名) |
| 区 ② 控件 | `Custom path`(开关标签)· `Per-item scopes`(数组键开关标签)· `☐ Encrypt` / `☑ Encrypt` |
| scope 选项(全站) | `All devices` / `Desktop only` / `Mobile only` / `This device` |
| mode chip | `Plain ▾` / `Fields ▾` / `Plain ▾ · shared` / `Fields ▾ · shared`(Task 5 定裁扩展) |
| enabledCssSnippets 指引 | `items managed under snippets/ below` |
| snippets 成员 hint | `chips write enabledCssSnippets per item — the snippet file follows its scope` |
| showInlineTitle hint | `Obsidian stores this Appearance option in app.json — synced with the app group.` |
| 状态-only hint | `Settings appear here once <Name> writes <file>.` |
| 预览图例 | `blue = desktop only · amber = mobile only · red = this device · 🔒 = encrypted · click a key to add a rule` |
| 徽章 | `on: desktop` / `on: mobile` / `on: this device` / `N device-scoped` / `N encrypted` / `from app.json` / `shared slice` / `This device · on`(`array` / `array · per-item` 已删——2026-07-26 修订,面板不放开发语义) |
| 添加入口 | `+ Add folder` |
| preset 改路径确认弹窗(Task 7 定裁) | 标题 `Change a preset folder?`;正文 `This folder is part of <Item>'s preset configuration. Changing it makes the old store entry a leftover (cleaned up by the usual flow) and captures the new path as a fresh item.`;按钮 `Change` / `Cancel` |
| companion 路径校验(Task 7 定裁) | `Enter a path.` / `Path must be vault-relative, not absolute.` / `Path cannot contain ".." segments.` / `<label> already syncs this path.` |
| companion 行控件提示(Task 7 定裁) | tooltip `Change path` / `Remove folder`;输入框 placeholder `Vault-relative path` |
| Sync Center this-device 词汇(Task 8 定裁,取代旧 excluded/Exclude 措辞) | 行内计数 `· N on this device`;局部决策明细 `⌂ <id> — this device keeps its own on/off state`;同步态提要 `in sync — this device's own plugins aren't compared`;分歧提示 `Apply turns off N on this device — keep them on this device first: <ids>`;分歧按钮 `⌂ Keep N extra(s) on this device…`;确认弹窗标题 `Keep on this device only`,正文 `<list>: items kept on this device manage their own on/off state — the shared list neither includes nor changes them.`,确认按钮 `Keep on this device` |
