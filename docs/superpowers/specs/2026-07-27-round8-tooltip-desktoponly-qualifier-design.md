# Round 8:双 tooltip 去重、desktop-only 插件标记、qualifier 建议触发

日期:2026-07-27
状态:定稿(mockup 用户已确认)
Mockup(chip 与三档循环定稿依据,固定深色):https://claude.ai/code/artifact/db18589a-d4c4-41e7-8e51-62884a89d988

## 1. 悬停出双 tooltip(修复)

根因:七处元素同时设置 `aria-label` 与 `title` —— Obsidian 为带 `aria-label` 的元素渲染
自家 tooltip,`title` 又触发浏览器原生 tooltip,两个叠加。

改法:凡已设 `aria-label` 的地方删除重复的 `title`(SettingTab.ts:路径文字 ×2、
锁定路径行提示、scope 循环图标、锁图标、逐项元素行禁用提示、preset 规则锁)。
`aria-label` 保留 —— 它既是 Obsidian tooltip 的来源也是无障碍标签。
原生 `select` 上仅设 `title` 的两处(fields 模式下拉、preset 动作下拉)只有一个 tooltip,不动。

## 2. desktop-only 插件标记 + ENABLED ON 三档循环

manifest `isDesktopOnly: true` 是插件的天生属性(移动端装不上),此前对面板完全不可见,
与用户配置的 `enabledOn`("on: desktop" 彩色 badge)是两回事。

数据链路:`main.ts` manifests 已有 `isDesktopOnly` → `pluginRuntime()`/`registryEnv()` 带出
→ `RegistryPluginEnv` 增加 `desktopOnly: boolean` → `buildItemDefs` 写入
`ItemDef.desktopOnly?: boolean`(仅 true 时写)。

- **Badge**:`computeBadges` 在所有配置类 badge 之前追加
  `{ text: "desktop-only plugin", cls: "config-sync-card-badge-plat", icon: "monitor" }`。
  `Badge` 接口增加 `icon?: string`;两处渲染循环(初始 + refreshCardBadges)提取共用的
  渲染小函数,icon 存在时 setIcon 一枚 11px 图标在文字前。样式:灰底
  (与 badge-array/fromapp 同规则),`inline-flex + gap 4px` 仅作用于 `-plat` 类。
- **循环跳 mobile**:ENABLED ON 的 scope 循环对 `def.desktopOnly === true` 的卡片改传
  三档选项表 `["all","desktop","local"]`。
- **存量值兜底**:`nextScope` 当 current 不在选项表中时(如残留 `enabledOn: "mobile"`),
  沿 canonical 顺序 `all→desktop→mobile→local` 从 current 的下一档起找第一个在选项表中的值
  (stale mobile → local),不再落回 index 0 的 "all";不炸、不静默改写存量配置。
- 仅 ENABLED ON 循环裁剪;settings-file/规则行的 field scope 选项不动(本轮不扩)。
- Sync Center 不加此 badge(未提出)。

## 3. qualifier 建议触发时机(修复)

根因:下拉只在 `input` 事件里刷新 —— 聚焦不弹;输入 `s` 仅前缀匹配到 `scope:`;
删空后 token 为 `""` 全键命中才弹出全部键,体验"随缘出现"。

改法:`QualifierAutocomplete` 增加 `focus` 监听 → `refresh(true)`。效果:点进空搜索框
立即列出全部 qualifier 键(设置面板 2 个,Sync Center 5 个);输入即前缀过滤;token 不
匹配任何键时下拉自动关闭(纯文本搜索不受打扰);`scope:` 打完后值列表行为照旧。
两个视图共用组件,一并生效。

## 测试与门

- 新增(tests/itemCard.test.ts):computeBadges 的 desktop-only badge(存在性、排序、icon)、
  nextScope 存量值兜底(mobile+三档表 → local;边界:候选都不在表中时的推进)。
- 门:tsc 干净、vitest 全绿、eslint 0 error(warning 基线)、build、dev vault 实机验证
  (单 tooltip、chip 渲染、三档循环+stale mobile 顺延、聚焦弹建议)。

## 文档同步

DESIGN.md badge 清单补 desktop-only chip、qualifier 一节补聚焦触发;README/zh 若有
badge 或搜索交互的行级描述则同步,与本批改动同批等 cut。
