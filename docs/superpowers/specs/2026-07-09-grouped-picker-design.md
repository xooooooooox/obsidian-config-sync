# grouped-picker 设计文档

第五轮迭代:选择器分组化 + Core Plugins tab + 每组一键。2026-07-09 定稿。上游文档:[主 spec](2026-07-08-obsidian-config-sync-design.md)、[iter3 picker](2026-07-09-settings-picker-design.md)、[iter4 polish](2026-07-09-settings-polish-design.md);本文档只描述增量。

## 背景:两条用户反馈 + 一个新需求

1. Obsidian tab 混装了全局项与核心插件设置——核心插件设置应独立成 **Core plugins tab**;
2. 平铺 + 行内文本注解("(not present yet)" / caution)不直观——应**按状态分组**呈现,分组标题用用户视角文案;
3. 新需求:每个分组提供**一键 Sync all / Sync none**,便于"把某组整批同步"。

## A. 六 tab 结构

`General ｜ Obsidian ｜ Core plugins ｜ Community plugins ｜ Advanced ｜ External sources`

Obsidian tab 中属于核心插件的条目迁到 Core plugins tab;Obsidian tab 只留真·全局项。派生规则(勾选↔组绑定,**iter5 起改按 name 命中**,见 H)、description 自动带入、草稿/滚动/渲染代数守卫全部沿用 iter3/iter4。

## B. catalog 打标签:硬编码收缩到运行时不可得的部分

**分层原则:「这是什么状态」「核心插件叫什么」运行时算;唯独「哪个核心插件写哪个文件」Obsidian 私有,不可得,是唯一不可消除的硬编码。**

运行时验证结论(2026-07-09,obsidian-cli 实测):
- `app.internalPlugins.plugins[id].instance.name` 给出核心插件人类可读名(禁用插件也可用,跟随语言)——**核心插件友好名不再硬编码**,改从运行时取;
- 但 instance 的任何属性都**不暴露它的设置文件名**(`properties` 插件写 `types.json` 这层关系私有)——`id→文件` 必须硬编码;
- 全局项文件(`app.json` 由 General/Editor/Files 三个设置标签页共写)运行时没有单一名——全局项友好名仍需小表。

### 硬编码(两张小表)

1. **`OPTION_LABELS`(~5 项,全局项文件→友好名)**:`app.json→"Editor & general"`、`appearance.json→"Appearance"`、`themes→"Themes"`、`snippets→"CSS snippets"`、`hotkeys.json→"Hotkeys"`;开关列表 `core-plugins.json→"Enabled core plugins"`、`community-plugins.json→"Enabled community plugins"`。
2. **`CORE_PLUGIN_FILES`(核心插件 id→设置文件,默认同名 + 例外表)**:规则为 `<id>.json`,覆盖 9/10(graph/backlink/canvas/page-preview/daily-notes/templates/zk-prefixer/bookmarks/command-palette);**例外表**只需 `properties → types.json`。未来新增的核心插件若按 `<id>.json` 存,自动识别、自动取运行时名,只有反常者登记例外。`sync`/`publish` 若有设置文件则标 `notRecommended`。

### 运行时计算

- **名字**:核心插件 `instance.name`;社区插件 `manifests[id].name`;全局项查 `OPTION_LABELS`,未知枚举文件用文件名;
- **分类(去哪个 tab)**:文件命中 `CORE_PLUGIN_FILES` 值 → Core tab;命中社区插件 `plugins/<id>/data.json` → Community tab;`OPTION_LABELS` 或未知枚举文件 → Obsidian tab;
- **分桶**:文件存在(`io.exists`)、核心插件启用(`app.internalPlugins.plugins[id].enabled`)、社区插件启用(`isPluginEnabled`)、黑名单/软拦。

### 稳定 name(身份主键,见 H)

每个 picker 项有一个**固定规范 name**,勾选建组用它、命中判定用它(不再按 path):全局项 = `OPTION_LABELS` 的 key 去扩展名(`app`/`appearance`/`hotkeys`/`themes`/`snippets`)、开关列表 `core-plugins`/`community-plugins`、核心插件 = 其 id(`graph`/`properties`/...)、社区插件 = `plugin-<id>`。

## C. 分组模型:catalog 定桶,UI 渲标题

catalog 列表函数给每项返回 `bucket`(分组标题文本)并按桶序排列;UI 按 `bucket` 连续分组、打小标题 + 用户视角描述;**空桶不渲染**。

| Tab | 分组(桶序) | 判据 | 标题下描述(用户视角) |
|---|---|---|---|
| **Obsidian** | Available | 文件存在且非软拦 | "Ready to sync — these settings already exist in this vault." |
| | Not yet in this vault | 已知项文件未生成(惰性未创建,如未改过设置的 backlink.json) | "You haven't customized these yet, so there's nothing to sync until you do." |
| | Not recommended | workspace*.json(软拦) | "Tied to this specific device — syncing makes your devices fight over each other." |
| **Core plugins** | Enabled | 核心插件运行时启用 | "Turned on here." |
| | Disabled | 核心插件运行时禁用 | "Turned off — you can still sync its settings for when you enable it." |
| | Not recommended | 核心插件 `sync` / `publish`(账号信息) | "Contains account or device-specific data — not meant to travel between vaults." |
| **Community plugins** | Enabled | 已装且启用 | "Turned on here." |
| | Installed but disabled | 已装未启用 | "Installed but turned off — you can still sync its settings for later." |
| | Not recommended | 黑名单(remotely-save / ioto-update / slides-rup / obsidian-config-sync) | "Machine-bound or credential-bearing — cannot be synced." |

- workspace 从 iter4 的行内 caution 升级为 Obsidian tab 的 **Not recommended 组**(勾选确认保留);"(not present yet)" 从行内文字升级为 **Not yet in this vault 组**;
- Core plugins tab 只列**有已知设置文件**的核心插件(无设置文件的 file-explorer/switcher 等不列——同步不存在的设置文件无意义);行按该核心插件启用态分桶,行内仍可标注文件是否存在;`sync`/`publish` 若有设置文件则归 Not recommended。

## D. 开关列表归位

- "Enabled core plugins"(core-plugins.json)移到 **Core plugins tab** 顶部;
- "Enabled community plugins"(community-plugins.json)移到 **Community plugins tab** 顶部;
- 二者文件恒存在,归各自 tab 的 **Available/Enabled** 首位(整文件镜像风险说明保留在行内 description)。

## E. 每组一键 Sync all / Sync none

- 每个分组标题行右侧一个按钮:该组未全勾时显 **"Sync all"**(一键为该组所有项建组),已全勾时显 **"Sync none"**(一键删该组所有项对应组);
- **Not recommended 组不提供 Sync all**(用摩擦阻止"一键同步危险项";这些项仍可逐项勾选,各自弹确认);
- 批量操作 = 对该组每项执行勾选/取消的等价逻辑后一次性 `writeGroups` + `refresh`;description 自动带入规则不变。

## F. host 方法

host 只负责**注入运行时状态**,分类/分桶/命名纯逻辑在 catalog:
- `listOptionItems(groups)`——`OPTION_LABELS` 项 + 未知枚举文件,带 name/bucket;
- 新增 `listCorePluginItems(groups)`——host 采集 `{id, name: instance.name, enabled}[]`(遍历 `app.internalPlugins.plugins`)喂给 catalog;catalog 用 `CORE_PLUGIN_FILES` 求各核心插件设置文件、按 enabled 定桶(enabled/disabled;sync/publish→notRecommended);
- `listPluginItems()`——社区插件 `{id, name, enabled}`,按启用态/黑名单定桶;
- 项形状统一:`{ name, label, path, type, bucket, exists, disabledReason, cautionReason, description }`,`name` 为稳定主键;catalog 内分桶/命名/`expectedPathForName`/`findGroupByName` 均纯函数可测。

## H. 身份主键从 path 改为 name

**核心转变:picker 项与 group 的绑定由 name(稳定主键)承载,不再按 path。** 这解锁了 #1(改了 path 仍能溯源)。

- 每个 picker 项有固定规范 name(见 B 节末);勾选 = 建 name = 该固定名的组,取消 = 删该 name 的组;**"是否已勾选"改为按 name 命中**(`findGroupByName`),不再按 path;
- iter4 的 slug 去重(`hotkeys-2`)**废除**——固定名本就唯一;
- **约束**(校验层硬拒,与黑名单同机制):
  1. name 全局唯一(iter1 起已有);
  2. **保留名占用**(iter5 定稿撤销):最初设想"保留名+错 path→拒绝",但这与 §I 的"解锁改 path + customized 标识"互斥(名叫 graph、path 改到别处**正是** customized 想要的形状),故**取消该校验**——name 唯一 + store-path 唯一已覆盖真实风险;手写一个保留名 + 另指 path 的组,即被视为"该项已自定义",在 §I 显 customized;
  3. path 唯一仍保留(iter3 起的 store-path 冲突校验)。
- **零迁移**:starter 组 name = `snippets`/`hotkeys` 与新固定名一致,老文件打开即正确勾选;历史上 name 与保留名不符的手写组视为自定义规则进 Advanced。

## I. Advanced 分组 + 锁 + 溯源标识(需求 #1)

**机制 tab-无关,对 Obsidian / Core plugins / Community plugins 三个 picker tab 一视同仁**——统一由 name 主键驱动。社区插件勾出来的组(name = `plugin-<id>`,path = 运行时拼的 `{configDir}/plugins/<id>/data.json`)同样进 Managed 组、同样可锁/解锁/溯源。

- **Advanced 按来源分两组**:
  - **Managed by pickers**——name 命中保留名表(任一 picker tab 勾出来的,含 `plugin-<id>`),默认**只读**,行首挂一把**锁**(lucide `lock`);
  - **Custom rules**——name 不是保留名(手写的),照常可自由增删改。
- **锁交互**:Managed 行默认所有字段禁用;点锁 → 该行解锁可编辑(主要改 path)、图标变 `unlock`;锁状态是 UI 瞬时态(不落盘),重开面板复位为锁上。
- **溯源标识(改了 path 后外显)**:某 managed 组的 `path` ≠ 其保留名对应的 catalog 预期 path 时,判定为"customized"——
  1. Advanced 该行显 **"⚙ customized (was `<预期path>`)"**;
  2. 该项**原属 picker tab 的那一行**(Obsidian / Core / Community 皆然,如 `plugin-dataview` 回追到 Community plugins tab 的 Dataview 行)显 **"⚙ customized"** 徽标——靠 name 命中稳定回追,即使 path 被改。
- 保留名→预期 path 的映射(用于 customized 判定,不用于校验拒绝)由 catalog 提供(`expectedPathForName(name)`,如 `plugin-dataview → {configDir}/plugins/dataview/data.json`、`properties → {configDir}/types.json`),纯函数可测。

## J. 全局搜索(需求 #2)

- 面板顶部(tab 栏之上)一个搜索框;**有输入时隐藏 tab 栏,跨所有 tab 扁平展示命中项**(按 name / 友好名 / path 子串匹配,大小写不敏感);
- 每个命中行标注它**原属的 tab 与分组**(如 "Community plugins · Enabled"),并保留其勾选 toggle 与 devices 下拉(可直接在搜索结果里勾选);
- Not recommended 命中项仍带确认;**搜索结果不提供 Sync all**(批量只在正常分组视图);
- 清空搜索 → 回到当前 activeTab 的正常视图;搜索框内容是 UI 瞬时态,`display()` 重开清空。

## 错误处理

沿用既有:非法不落盘、就地显示;软拦逐项确认取消 = 无副作用;批量写盘失败 = 现有 groupsErrorMsg 呈现(搜索视图内也重建该元素)。

## 测试

- catalog 纯函数单测:分类(option/core/community,含 `CORE_PLUGIN_FILES` 默认同名 + 例外 `types.json→properties`)、分桶(option 三桶、core 三桶含 sync/publish→notRecommended、community 三桶、空桶不产出、workspace→Obsidian Not recommended、未知文件降级 option)、稳定 name 生成、`expectedPathForName`、`findGroupByName`;
- 批量选择纯函数(某组全项→组集合增删)单测;
- 校验单测:name 唯一、store-path 唯一(保留名+错 path 不再拒绝——见 H.2 定稿撤销);
- UI 不做单测,obsidian-cli 冒烟:六 tab、分组标题与描述、跨桶勾选重排、Core enabled/disabled 分组、每组 Sync all/none、Not recommended 无 Sync all 逐项确认、Advanced 两组与锁开合、改 path 后两处 customized 标识、全局搜索扁平结果与命中处勾选。

## 验收清单

1. 面板为六 tab;核心插件设置在 Core plugins tab,Obsidian tab 仅全局项;
2. 每 tab 内按状态分组呈现,分组标题含用户视角描述,空桶不显示;
3. `types.json` 归到 properties(Core tab),按 properties 启用态分桶;核心插件名取自运行时(禁用插件也对);
4. 惰性未生成的核心设置文件(如未改过的 backlink.json)出现在 Core tab 对应启用态组、行内标注未生成;
5. 每组(除 Not recommended)有 Sync all/Sync none,批量增删正确落盘;
6. workspace 在 Obsidian Not recommended 组,逐项勾选弹确认,该组无 Sync all;sync/publish 在 Core Not recommended 组;
7. Advanced 分 Managed(锁定,可解锁改 path)/ Custom 两组;改了某 managed 项 path 后,Advanced 行与其 picker 行都显 customized;
8. 用户在 Advanced 把某 managed 组(如 graph)的 path 改到别处,保存成功且该项显 customized(取代最初"校验拒绝"的设想,见 H.2 定稿撤销);
9. 顶部搜索框输入后跨 tab 扁平展示命中项(标注原 tab·组),可直接勾选;清空回到 tab 视图。
