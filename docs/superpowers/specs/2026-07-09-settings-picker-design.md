# settings-picker 设计文档

第三轮迭代：配置面板从「组编辑器」重构为「勾选式选择器」。2026-07-09 定稿。主 spec 见 [2026-07-08-obsidian-config-sync-design.md](2026-07-08-obsidian-config-sync-design.md)，迭代 2 见 [2026-07-09-settings-ux-and-release-docs-design.md](2026-07-09-settings-ux-and-release-docs-design.md)；本文档只描述增量。

## 背景：用户视角的四个问题

1. 配置文件的路径是机器已知/可推导的，不应由用户填写——用户不知道也不需要知道 path；
2. "sync groups" 是存储模型的抽象，直接暴露成 UI 让用户先学概念，不直观；用户的心智模型是 Obsidian 设置面板自己的分类（Options / Core plugins / Community plugins）；
3. 面板文案是开发者视角，不是用户视角；
4. README 缺少面板配置示例。

**核心原则：面板是「勾选你要同步什么」，不是「定义组」。** groups 仍是唯一存储模型（config-sync.json、publish/apply 引擎、schema 全部不动），选择器只是它的派生视图。

## A. 信息架构

设置面板自上而下：

1. **PKM mode / Data folder**（迭代 2 现状，不变）；
2. **Obsidian settings**（Options 区）——**动态枚举 + 友好名映射**（见 A.1）；
3. **Community plugins** ——动态列出已安装插件（显示名 + ID，来自 `app.plugins.manifests`），勾选 = 同步该插件的 `data.json`；黑名单插件（remotely-save / ioto-update / slides-rup / obsidian-config-sync）置灰并给出用户视角原因（"设备绑定或含凭据，不可同步"）；
4. **Advanced**（折叠，`<details>` 或等价样式）——迭代 2 的组编辑器整体降级至此：列出**全部**组（勾选生成的 + 手写的），保留全字段编辑（含 sanitize）；path 输入改造见 A.2；
5. **External sources**（迭代 2 现状，不变）。

每个勾选行右侧带紧凑 **devices 下拉**（all/desktop/mobile，默认 all）；**sanitize 仅在 Advanced 编辑**（最复杂的概念不进简单视图）。

### A.1 Options 区：动态枚举（解决 Obsidian 版本漂移）

写死清单必然随 Obsidian 版本漂移（老版本缺文件、新版本加文件）。因此：

- 渲染时**实际枚举** `{configDir}/` 下的 `*.json` 文件与一级子目录，存在什么列什么；
- **友好名映射表**（`src/core/catalog.ts`）只负责美化已知项，未映射的文件以文件名为标签直接展示（自动适配新版本新增文件）：

| 文件/目录 | 标签 | 说明（用户视角） |
|---|---|---|
| app.json | Editor & general | 编辑器与通用选项 |
| appearance.json | Appearance | 外观设置（主题选择、字体等） |
| themes/ | Themes | 已安装的主题文件 |
| snippets/ | CSS snippets | CSS 代码片段 |
| hotkeys.json | Hotkeys | 自定义快捷键 |
| graph.json | Graph view | 关系图谱视图设置 |
| types.json | Properties | 属性类型定义 |
| command-palette.json | Command palette | 命令面板置顶项 |
| page-preview.json | Page preview | 页面预览设置 |
| backlink.json | Backlinks | 反向链接设置 |
| canvas.json | Canvas | 白板设置 |
| daily-notes.json | Daily notes | 日记设置 |
| templates.json | Templates | 模板设置 |
| zk-prefixer.json | Unique note creator | 唯一笔记前缀设置 |
| bookmarks.json | Bookmarks | 书签 |
| core-plugins.json | Enabled core plugins | 核心插件的开关状态 |
| community-plugins.json | Enabled community plugins | 社区插件的**开关状态**（不含插件本体与设置）。整文件镜像：目标设备独有的启用项会被覆盖关闭——多设备插件高度一致时才建议勾选 |

- **枚举排除**：`workspace*.json`（黑名单；以置灰项显示并注明"设备专属，不可同步"）、`core-plugins-migration.json`（机器迁移文件，不显示）、`plugins/` 目录（有独立分区）；
- **已勾选但源已不存在**的项（组还在、文件没了——常见于版本差异/其他设备勾选的）仍然显示为勾选态，标注 "(此库中尚不存在)"，配合 §C 不会炸 publish。

### A.2 Advanced 的 path 输入：`{configDir}` 变量退出用户视野

`{configDir}` 抽象是跨设备可移植的关键（各设备配置目录名不同），**存储格式保留**；但用户不再手写它：Advanced 每行的 path 改为**位置下拉 + 相对路径**两个控件：

- 位置 `Config folder`：path 填 `plugins/x/data.json` → 存储为 `{configDir}/plugins/x/data.json`；
- 位置 `Vault root`：path 填 `.obsidian.vimrc` → 存储原样（库根文件本就不带前缀）；
- 读入时按前缀反解为下拉状态；两个控件均为既有草稿语义（文本变更不重渲染，位置切换属结构变更）。

### Community plugins 勾选的语义边界

勾选插件 = 同步其 `data.json`，**不含插件本体**（安装仍走 BRAT/商店，主 spec 边界不变）。开关状态由 Options 区的 "Enabled community plugins" 独立承载（见 A.1 表）。

## B. 派生规则（勾选 ⇔ 组，按 path 匹配）

- 某项呈勾选态，当且仅当 config-sync.json 中存在 **path 等于该项已知路径**的组——不依赖命名约定；
- 推论：**零迁移**——现有用户（含 starter 的 snippets/hotkeys）打开新面板自动呈勾选态；手写组与勾选生成组无本质区别；
- 勾选 → 生成组写盘：name 为友好 slug（如 `hotkeys`、`plugin-dataview`，与现有组重名时追加序号）、path/type 按目录项、devices=all；取消勾选 → 删除该组写盘；devices 下拉就地改组写盘；
- 文件仍是唯一真相源；迭代 2 的草稿重载语义（display 重载、refresh 保草稿、生效根变更重载）原样适用于选择器状态；
- 新增纯模块 **`src/core/catalog.ts`**：友好名映射表、枚举结果 → 目录项列表、path↔项匹配、勾选 → 组生成、黑名单/排除判定。全部可单测。

## C. 引擎小改：publish 源缺失改为逐组错误

现状：publish 遇任一组源缺失即整体抛错中止（store 部分更新 + lock 过期，v0.1.0 终审已记 Minor）。勾选式面板让"勾了本库还没有的项"成为常态操作，必须改：**源缺失的组产生 error 结果（与 apply 的 store-missing 一致），其余组照常发布**，lock 正常写入（缺失组无版本戳）。报告 Modal 逐组呈现。现有"缺源硬抛"的测试改为断言 error 结果。

## D. 文案全面改写为用户视角

所有 `setName`/`setDesc` 重写，原则：说用户得到什么，不说实现。关键条目最终文案（英文 UI）：

| 条目 | 文案 |
|---|---|
| Data folder | "Where synced settings are stored inside your vault, so your note-sync app (e.g. remotely-save) carries them to your other devices. Leave empty to use the recommended location." |
| PKM mode | "Adjusts the recommended storage location to match how your vault is organized. Auto detects IOTO vaults." |
| Obsidian 区标题（heading 实际值为 "Obsidian"——eslint-plugin-obsidianmd 的 no-problematic-settings-headings 规则禁止标题含 "settings"） | "Choose which Obsidian settings follow you across devices." |
| Community plugins 区标题 | "Sync a plugin's settings to your other devices. The plugin itself still installs from the community store or BRAT." |
| Advanced 区标题 | "Custom sync rules for anything not listed above — files at the vault root, extra folders, or per-key credential protection (sanitize)." |
| External sources | "Pull the synced settings of another vault into this one (e.g. from your main vault into a published copy)." |

## E. README 增补「面板配置示例」

新增 "Configuring what to sync" 一节，三个走查：

1. **基础**：全设备同步 Hotkeys + Appearance + CSS snippets——打开设置 → 勾三项 → Publish → 其他设备 Apply；
2. **带凭据的插件**：勾选某插件 → Advanced 里给该组加 sanitize 模式（`*Token*` 等）→ 凭据永不入库、本机录一次不丢；
3. **IOTO 用户从零开始**：装插件 → PKM 自动探测（数据目录落 `0-Extra/config-sync`）→ 勾选 → Publish → remotely-save 带走 → 其他设备 Apply。

## 测试

- `catalog.ts` 纯函数单测：枚举过滤（黑名单/排除项）、友好名映射与未知文件回退、path↔项匹配、勾选生成组（含 slug 去重）、位置下拉的前缀加/解；
- publish 逐组错误语义：core 测试更新（一组缺源 → 该组 error、其余成功、lock 写入）；
- 面板交互（勾选/取消/devices/置灰项/位置下拉）走 dev/vault + obsidian-cli 冒烟。

## 验收清单

1. 不写任何路径即可完成常见配置：勾 Hotkeys + 某插件 → Publish → 另一设备 Apply 生效；
2. 老 groups 文件在新面板呈正确勾选态（零迁移）；
3. 黑名单插件与 workspace 文件置灰且有用户视角说明；本库不存在的已勾选项有标注且 publish 不中止；
4. Advanced 可用位置下拉 + 相对路径配置 `.obsidian.vimrc`（不出现 `{configDir}` 字样）；
5. 未映射的新版本设置文件自动出现在 Options 区（以文件名为标签）；
6. README 三个走查场景照做可跑通。
