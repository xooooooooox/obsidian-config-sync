# UI 反馈第 2 轮设计(app.json 合并卡 + 面板产品化)

日期:2026-07-26
状态:定稿(mockup 已确认)
前置:`2026-07-25-unified-card-design.md`(统一卡模型)。本 spec 修订其 §5 的 Obsidian tab 结构与 §10 的部分副本合同;冲突处以本 spec 为准。

## 0. 背景与决策记录

真实 vault 视觉走查第 2 轮反馈,六条意见 + 一个确认问题。逐条裁定:

| # | 反馈 | 裁定 |
|---|------|------|
| 1 | 无配置文件的 core plugin 卡没必要列出 | **保持现状不改**(用户拍板)。这些卡承载"开/关状态是否跨设备同步"的能力;仅文案随 #2 走查产品化。 |
| 2 | 面板文案全部改为用户/产品视角 | 做,见 §3。 |
| 3 | 去掉 `· shared`(视觉不工整),需要解释用 tooltip | 被 #5 的合并**整体消解**:合并后不存在 shared 概念,标记与 hint 一并删除,无需 tooltip。 |
| 4 | core plugins 按字典序排序 | 做,community/beta 一并排序,见 §4。 |
| 5 | Editor 卡内容与 Obsidian 实际 Editor 页不符;可考虑合回一张卡(如 1.9.0) | **合并为一张 App settings 卡**(用户选定)。根因:`APP_JSON_TAB_MAP` 手工映射天然漂移且无 API 可取。见 §2。 |
| 6 | 目录处理疑似硬编码:普通目录只能整目录 scope,snippets 却能逐文件 | 澄清为语义差异(snippets 逐条 scope 依托 Obsidian 的 `enabledCssSnippets` 启用列表,控制的是"在哪类设备上启用";普通目录无此载体)。**本轮不做**普通目录逐文件 scope(留 backlog);仅在文案上把两种语义说清,见 §3。 |
| 确认 | core plugin "是否有配置文件"是硬编码还是动态获取 | 动态:插件清单来自运行时 `app.internalPlugins`(`main.ts:718`);文件存在性来自 `io.exists({configDir}/<id>.json)`(`main.ts:276`)。唯一硬编码是 `properties → types.json` 文件名例外与仅供测试的 seed 列表。 |

走查中新发现一处实现偏差(用户观察到 "+ Add folder" 只在 Appearance 出现):unified-card spec §4 区 ③ 定义的是**每张卡**末行 `+ Add folder`,但实现的 `hasCompanionZone` 门控(预置或已有伴生目录 > 0 才渲染区)把按钮连带藏掉,造成"没有第一个目录 → 永远加不了第一个目录"的死锁,只有带预置的 Appearance 幸免。按 spec 修复,见 §5。

Mockup(定稿依据,固定深色):https://claude.ai/code/artifact/cb569f3c-3aa0-42c2-9829-5c7e57d4d75d

## 1. 范围

- **§2** app.json 三卡合一(含 Appearance 的 showInlineTitle 收编)+ 切片机制整体删除 + 配置就地归并
- **§3** 面板文案产品化走查(含 #6 的语义文案)
- **§4** core/community/beta 卡字典序
- **§5** "+ Add folder" 放开到所有卡

非目标:#1(无配置 core 卡的结构)、普通目录逐文件 scope(引擎迭代,backlog)、remote 传输、Sync Center 结构。

## 2. app.json 合并卡

### 2.1 卡片形态

- Obsidian tab 由 5 张卡变 3 张:**App settings**(整个 app.json)、Appearance(仅 appearance.json + themes/snippets)、Hotkeys。
- 新卡 def:`id: "app"`,label `App settings`,`settingsFile.defaultPath = "{configDir}/app.json"`,无 `appSlice` 字段。普通单文件卡,与 Hotkeys 同构:Plain/Fields chip 在头行,Fields 模式逐键 scope/加密,Plain 模式允许 file-level rule(顺带消除 backlog ⑧ "appJson.mode=plain 无切片门控"的怪态——不再有切片)。
- `showInlineTitle` 不再由 Appearance 卡借渡:它就是 app.json 的一个键,归 App settings 卡。Appearance 卡不再出现 `from app.json` 徽章。

### 2.2 删除清单(机制整体退场)

| 层 | 删除 |
|----|------|
| catalog.ts | `APP_JSON_TAB_MAP`、`appTabFor`、`AppJsonTab`、`APP_TAB_TO_SLICE_KEY`、`AppSliceKey` |
| types.ts | `SyncGroup.appSlices`、`AppSliceFlags` |
| registry.ts | editor/files-links/other 三个 def(由 `app` def 取代)、`APP_SLICE_CARD_IDS`、`settingsFile.appSlice` 字段、`compileAppGroup`(app 组走通用 `compileSingleFile`)、`compileAppearance` 的 app-slice 拆分逻辑(Appearance 只编译自己的文件与伴生目录)、`groupOwners` 中 "app" 组的 owner 由四张切片卡收敛为单一 `app` 卡(editor/files-links/other 的占位注册删除) |
| modes.ts | `appSlices` 门控分支(`group.appSlices === undefined` 判断及其函数) |
| manifest.ts | `appSlices` 字段校验 |
| settings | `settings.appJson`(file-level mode 特例)——mode 回到 `items.app.settingsFile.mode` |
| itemCard.ts | `isSharedAppSliceCard`、`modeWriteTarget`、`SHARED_APP_MODE_HINT`、`cardBodyPlan` 的 `previewOnly` 分支、`sliceKeysForCard`/`sliceDocForCard`、`FROM_APP_JSON_BADGE` 与"shared slice"徽章 |
| SettingTab.ts | `setAppJsonMode`、`renderSharedAppCards`、`cardWraps`(仅为 shared 联动而生)、头行 `· shared` span 及其 aria 分支 |

净效果为删代码。编译后的 app 组名保持 `"app"`(与现有 `claimPath` 的 synthetic owner 名一致,store 路径不变)。

### 2.3 配置就地归并(加载时 normalizer,非 schema bump)

schemaVersion 2 尚未发布,合并属于 v2 形态自身的修订。加载设置时一次性归并:

- 触发条件:`settings.items` 含 `editor`/`files-links`/`other` 任一键,或存在 `settings.appJson`。
- `items.app.enabled` = 三张旧卡任一 `enabled`。
- `items.app.settingsFile.mode` = 旧 `settings.appJson.mode`(缺省 `fields`——旧 `DEFAULT_SETTINGS.appJson` 即 `{ mode: "fields" }`,appJson 缺失的 vault 在旧运行时的实际行为就是 fields;2026-07-26 评审修订,初稿误写 plain)。
- `rules`/`perItem` 取并集,遍历顺序 `editor → files-links → other → appearance`(appearance 只取其规则中属于 app.json 借渡键的部分,现状即 `showInlineTitle`),**同 pattern 首见者胜**(确定性;实践中不重叠)。归并后从 `items.appearance.settingsFile.rules/perItem` 中删除被移走的键。
- `enabledOn`/`companions` 等其余字段:旧三卡均无伴生;`enabledOn` 不适用于 obsidian 卡,忽略。
- 归并完成后删除 `items.editor`/`items["files-links"]`/`items.other` 与 `settings.appJson`,保存一次。
- **已知取舍**:旧形态"某一切片单独关闭"的粒度不保留(enabled 取或)。若用户此前刻意关闭某切片(如 Other),合并后该部分键随卡同步,需用 Fields 规则自行收窄。发布说明本就要求 v2 重新配置,此处不做补偿逻辑。

### 2.4 UI 细节

- 头行 chip 行为与其他卡一致(改 mode 走 `updateItem`,轻量刷新正文),不再有跨卡联动。
- 预览/Fields 键列表不再过切片过滤——整个 app.json 的键都在这一张卡里,`spellcheckLanguages`、`alwaysFocusNewTabs` 这类过去漂进 Other 的键自然归位(#5 的"与实际不符"就此消除,且永不再漂移)。

## 3. 文案产品化走查

原则(第 1 轮已确立,本轮全面执行):配置面板是给用户的产品界面,不出现实现细节(文件名、内部机制、开发术语);描述行为,不描述结构。代码注释、日志不在此列。

### 3.1 定稿副本(mockup 第 6 块)

| 位置 | 现文案 | 新文案 |
|------|--------|--------|
| App settings 卡描述 | (三卡各自的描述) | `Editing, new-note and link behavior, and other general options.` |
| Appearance 卡描述 | `Theme, fonts and CSS snippets — everything under Obsidian's Appearance tab.` | `Theme, fonts and CSS snippets.` |
| Hotkeys 卡描述 | `Custom keyboard shortcuts.` | `Your custom keyboard shortcuts.` |
| core(有设置文件) | `<file>.json — settings and enabled state.` | `Settings and on/off state.` |
| core(暂无设置文件) | `Enabled state only — no settings file yet.` | `On/off state — no saved settings on this device yet.` |
| community/beta 卡描述 | `plugins/<id> — files, settings and enabled state.` | `Plugin files, settings and on/off state.` |
| snippets 成员 hint(#6 语义) | (实现视角) | `Files always sync — each snippet's choice here is where it's turned on.` |
| 普通目录成员 hint(themes 及用户挂载目录) | (无) | `This folder syncs as a whole — everything in it goes to the devices selected above.` |
| 区 ② 预览标题 | `Data file` | `File preview`(2026-07-26 第4轮修订:该区默认折叠为一行 `▸ File preview` disclosure,展开才读文件渲染;详见 `2026-07-26-card-visual-refresh-design.md` §4) |
| 空预览提示 | `no local file to preview` | `No file on this device yet — nothing to preview.` |
| shared mode hint | `app.json is shared by …` | 删除(机制消失) |

### 3.2 走查范围

在实现任务中对 `SettingTab.ts`/`itemCard.ts`/`registry.ts`(def descriptions)/相关 Modal 的**全部用户可见字符串**过一遍,按原则改写;上表之外的改动在任务报告中列 before/after 清单供复核。预览图例行(`blue = desktop only · …`)与校验错误文案第 1 轮已定稿,不重写。

## 4. 排序

`buildItemDefs`:core 与 community/beta 两段各自按显示 label 排序(`localeCompare(…, "en", { sensitivity: "base" })`),obsidian 段保持固定顺序(App settings、Appearance、Hotkeys)。排序在 def 层做一次,面板与 Sync Center 等所有消费方自然一致。

## 5. "+ Add folder" 放开到所有卡

- 删除 `hasCompanionZone` 门控;`renderItemCard` 恒调用 `renderCompanionZone`。
- 区内:`buildCompanionRows` 非空 → 照旧渲染 `Companion folders` 区标题 + 目录行;为空 → 不渲染区标题,仅渲染 `+ Add folder` 按钮(mockup 第 2 块)。
- 校验、查重、路径冲突逻辑复用现状(`validateCompanionPath` + `companionConflict`),无引擎改动——`compileCompanions` 本就对所有卡生效。

## 6. 测试与门

- 更新:registry 编译(app 单卡取代四卡合流;appSlices 断言删除)、itemCard 切片函数相关用例删除、catalog 映射表用例删除、manifest appSlices 校验用例删除。
- 新增:①归并 normalizer(三旧卡 + appJson.mode + appearance 借渡键 → items.app,幂等);②def 排序;③空伴生卡也产出 Add folder 入口(UI 层若无现成测点,以 buildCompanionRows/渲染函数的纯函数部分为准)。
- 门:`tsc` 干净、vitest 全绿、eslint 0 error(警告基线不升)、`npm run smoke:install` 后在 dev vault 实机验证(合并卡、排序、Add folder、文案)。

## 7. 文档同步(docs-currency)

- `2026-07-25-unified-card-design.md`:§5 tab 结构、§10 副本合同加"2026-07-26 修订,详见本 spec"注记,不重写原文。
- README.md / README.zh.md:卡片清单与 app.json 描述更新,维持逐行 1:1 对齐。
- docs/design/DESIGN.md、ARCHITECTURE(如提及 appSlices/共享切片):同步删除该机制的描述。
- 全部改动照旧不提交,与既有未提交批次同批等 cut。
