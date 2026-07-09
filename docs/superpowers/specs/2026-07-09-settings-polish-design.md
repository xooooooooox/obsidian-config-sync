# settings-polish 设计文档

第四轮迭代：选择器面板打磨——group 描述字段、workspace 软拦、滚动/一致性修复、已知项常显、多 tab 面板。2026-07-09 定稿。上游文档：[主 spec](2026-07-08-obsidian-config-sync-design.md)、[iter2](2026-07-09-settings-ux-and-release-docs-design.md)、[iter3](2026-07-09-settings-picker-design.md)；本文档只描述增量。

## 背景：六条用户反馈（v0.2.0 试用）

1. groups 应带 description，让用户看 config-sync.json 时知道每个组对应什么；
2. bug：面板滚动位置在勾选/Add rule/源操作后被重置，Advanced 还会折叠；
3. 动态列表"不完整"（backlink/canvas/command-palette 未出现）——定性：非枚举 bug，是 Obsidian 惰性创建这些文件 + 面板只列存在项的设计撞上合理预期；
4. workspace.json 硬禁（黑名单硬编码）剥夺用户选择权，且交互样式不佳——已决策改软拦；
5. bug：同一组的 devices 在 picker 行与 Advanced 行各自快照，改一处另一处不同步；
6. 面板改为 ioto-settings 式多 tab。

## A. `description` 字段（可选，全链路）

- `SyncGroup.description?: string`；JSON Schema 增加可选 `description` 属性（string, minLength 1）；`validateSyncManifest`：可选字符串，trim 后为空视为未提供（写盘时省略该键）；
- **勾选自动带入**：picker 建组时 `description` = 目录项友好名（known 项如 `"Editor & general"`；插件行 `"<插件显示名> plugin settings"`；未知文件项不写）；
- Advanced 行新增可编辑 description 文本框（placeholder "description (optional)"，文本变更即存、不重渲染）；
- 兼容性：字段可选，老文件与手写组零迁移。

## B. workspace 软拦（硬禁 → 不推荐 + 勾选确认）

- **校验层放行**：`assertNotBlacklisted` 移除 `workspace*.json` 规则；插件目录硬黑名单（remotely-save / ioto-update / slides-rup / obsidian-config-sync 及祖先目录）**不变**；
- **catalog 语义拆分**：`CatalogItem.disabledReason`（硬禁，toggle 禁用）保持仅用于插件黑名单；新增 `cautionReason: string | null`（软拦说明），workspace 项设为 "Window layout and open tabs — highly device-specific; syncing will make devices overwrite each other."；
- **面板行为**：软拦项可勾；勾选时先弹确认（复用 `confirmWarnings`），确认后才建组写盘，取消则 toggle 回弹；取消勾选无确认；
- 主 spec §3 安全黑名单一节同步修订：workspace 移出黑名单、改列为「不推荐项（勾选需确认）」。

## C. 滚动 / 一致性修复

- `refresh()` 在 `containerEl.empty()` 前捕获 `containerEl.scrollTop`，`render()` 结束（渲染代数校验通过）后恢复；
- **devices 下拉改为结构性变更**：`await saveGroups()` → `refresh()`——picker 行与 Advanced 行读同一组对象且每次变更后整体重绘，两处永远一致（配合滚动保持无体验损失）；
- Advanced 的 `<details>` 折叠问题随 §E 消失（Advanced 成为独立 tab）。

## D. 已知项常显

- `listOptionItems`：`KNOWN_OPTIONS` 全量输出（不再要求 present||checked）；`exists` 只影响 "(not present in this vault yet)" 标注；动态枚举继续补充未知文件与目录；checked-missing 兜底循环仅服务未知路径；
- 勾选缺失项 → publish 逐组报错（iter3 §C 语义）兜底，不阻塞其余组；
- 验证义务：冒烟需在 dev vault 实际创建 `backlink.json`/`canvas.json`/`command-palette.json` 确认枚举无遗漏（回应反馈 3 的"是不是代码有问题"——用事实闭环）。

## E. 多 tab 面板

- 结构：SettingTab 内自绘 tab 导航（Obsidian 每插件仅一个设置页），五个 tab：
  | Tab | 内容 |
  |---|---|
  | General | PKM mode、Data folder |
  | Obsidian | options picker（含软拦项） |
  | Community plugins | 插件 picker |
  | Advanced | 规则编辑器（name / description / 位置下拉+相对路径 / type / devices / sanitize / 删除；Add rule） |
  | External sources | 源编辑器 |
- `activeTab` 字段跨 `refresh()` 保持（display() 重开回 General）；只渲染活动 tab；
- 组保存错误提示在 Obsidian / Community plugins / Advanced 三个 tab 底部各自呈现（同一 `groupsErrorMsg` 字段），源错误在 External sources tab；
- 样式：`styles.css`（模板空壳，首次启用）加最小 tab 样式，类名前缀 `config-sync-`（tab 栏 flex、活动项下划线/高亮，跟随 Obsidian CSS 变量如 `var(--interactive-accent)`）；
- 草稿语义不变：display 重载、refresh 保草稿、根变更（PKM 切换/Data folder 失焦）重载、文本输入不重渲染、渲染代数守卫 + 滚动保持。

## 错误处理

延续既有原则；软拦确认弹窗取消 = 无副作用（不建组、toggle 恢复原状）。

## 测试

- 校验/schema：description 合法/空白省略用例；workspace 组通过校验（原"workspace 被拒"测试改写为通过 + 插件黑名单仍拒）；
- catalog：known-always-visible（缺失文件也出现且 exists=false）；workspace 项 cautionReason 非空且 disabledReason 为 null；
- UI 不做单测，obsidian-cli 冒烟：tab 切换与 activeTab 保持、滚动位置保持、勾选 workspace 弹确认（取消/确认两路径）、两处 devices 一致、description 自动带入与 Advanced 可编辑、惰性文件补建后枚举完整。

## 验收清单

1. 勾选任意项后 config-sync.json 中该组带人类可读 description；Advanced 可改；
2. 面板滚动到底部勾选/删除/加规则，滚动位置不跳回顶部；
3. workspace.json 可勾（先确认），同步链路（publish/apply）对其正常工作；插件黑名单仍不可勾；
4. picker 行与 Advanced 行的 devices 永远一致；
5. `backlink.json` 等惰性文件：存在时被枚举，不存在时以 known 项常显并标注；
6. 面板为五 tab，切 tab 内容互不串扰，结构性操作后停留在当前 tab。
