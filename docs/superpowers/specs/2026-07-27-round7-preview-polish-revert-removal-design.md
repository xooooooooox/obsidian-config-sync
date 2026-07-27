# Round 7:预览打磨(就地刷新 + legend 色点)与 revert 移除

日期:2026-07-27
状态:定稿(用户裁定:① 就地刷新、② 方案 B、④ 全拆;⑤ 不排工作)
Mockup(定稿依据,固定深色):https://claude.ai/code/artifact/f4efadd9-1b9b-44c3-9078-2d6bfa8fcdb9

## 1. 就地刷新:消灭 hasKeyRules 翻转的整卡重画(反馈 1 + 3)

根因:三处写入后调用 `renderItemCard` 整卡重画 —— 重画中途有异步文件读,卡片高度塌陷再撑开
(面板抖动),`.config-sync-json-pre` 重建(preview 滚动回顶)。整卡重画唯一的存在理由是
hasKeyRules 翻转要更新路径行的置灰态。

- 新增 `refreshPathRow(wrap, def)`:以 `.config-sync-card-sfhead` 为稳定锚点(errorEl 是其
  下一个兄弟节点),`row.empty()` 后用 fresh config 重跑 `renderSettingsFilePathRow`。
- 三个调用点改为 `refreshPathRow(翻转时) + refreshCardBadges + refreshCardBody`,不再整卡重画:
  - snippet 成员 scope 循环的翻转分支(首个 perItem 增加 / 最后一个清空);
  - preview 点 key `addRuleForKey`(无条件 refreshPathRow —— 只会 false→true);
  - 规则行 ✕ 删除最后一条规则(顺带修复代码注释里自认的遗留:置灰不恢复)。
- 逐项元素行不翻转 hasKeyRules(规则键必然还在),不动。
- preview 滚动保持:`renderCardBodyInto` 换体前记录 host 内 `.config-sync-json-pre` 的
  `scrollTop`,换体后回填到新 pre(>0 才回填)。覆盖反馈 1(循环时 preview 展开)与反馈 3。

## 2. Legend 方案 B + 🔒 → lucide lock(反馈 2)

根因:legend 是一整条纯文本,CSS 里的 legend 着色规则从未有 span 可挂;🔒 emoji 与面板其它
setIcon lock 不统一。

- `PREVIEW_LEGEND` 字符串常量废除,itemCard.ts 改导出结构化 `PREVIEW_LEGEND_ENTRIES`
  (kind: scope/lock/hint):色点条目复用既有 `config-sync-json-desktop/mobile/strip` 类名。
- 渲染(SettingTab):`色点 + 中性灰词`,条目间 `·` 分隔;lock 条目用 `setIcon("lock")`;
  文案:`desktop only · mobile only · this device · [lock] encrypted · click a key to add a rule`。
- JSON key 行的 ` 🔒` 后缀改为 key span 内的 `setIcon("lock")` 小图标(11px)。
- CSS:删除 legend 文字着色三条,新增 `.config-sync-legend-dot`(7px 圆点,三色背景)、
  `.config-sync-legend-sep`、lock 图标尺寸约束。
- 测试:PREVIEW_LEGEND 相关断言改为 ENTRIES 结构(顺序、类名映射、无 emoji)。

## 3. Revert 全拆(反馈 4)

revert 是 apply 备份机制的唯一消费者,连根移除:

- main.ts:`revert-last-apply` command、sync 菜单项、ribbon revert 按钮、`runRevert`;
  `ribbonButtons` 默认值收为 `{ sync: false }`;types.ts `RibbonKey` = `"sync"`。
- SettingTab:General 里 ribbon 按钮列表删 `revert` 行。
- core:`revertLastApply`、`BackupEntry/BackupIndex/BackupState`、`backupOnce` 及 apply 两条
  路径里的备份写入全部删除;保留 `backupDir` 仅用于 legacy 清理 —— apply 时若发现
  `{configDir}/config-sync-backup` 残留则删除(沿用现状行为,不留死数据)。
- 设置读入对多余的 `ribbonButtons.revert` 键保持容忍(merge 默认值即可),不算 schema break。

## 4. 反馈 5(status bar → Sync Center):无工作

2.0.0 已实现(main.ts 注册 click → openSyncCenter),dev vault 实测通过;用户 main.vault 安装的
main.js 亦含处理器,reload 即可。

## 5. 文档同步(#2 审计结果一并处理)

- README/zh:ribbon 菜单项 "Sync" → "Sync Center"(76 及 39/40/111/112/126 措辞);store 布局图
  补整文件加密信封一行;revert 段落(21/49/76/78)删除/改写;保持 1:1 行数对齐。
- DESIGN.md:92(undo-2 revert 图标行)删;258 的 `-reset-link` "已删除死 CSS" 注记修正(该类
  在 2.0 路径编辑行复活)。
- ARCHITECTURE.md:38、47、187、255-257 的 revert/backup 模型段落改写为 legacy 清理语义。

## 6. 测试与门

- vitest:legend ENTRIES 断言更新;revert/backup 相关用例删除或改写(legacy 清理保留一条)。
- 门:tsc、vitest 全绿、eslint 基线不升、build、smoke:install 后 dev vault 实机:
  snippet scope 循环无整卡重画(卡片 DOM 节点保持、面板 scrollTop 不变)、preview 点 key 后
  pre.scrollTop 保持且路径行置灰、删最后一条规则后路径行解除置灰、legend 色点 + lock 渲染、
  revert command/菜单/设置行消失、apply 后无 backup 目录。

## 7. 已知取舍

- refreshPathRow 仅在翻转时调用(非每次写入),避免路径行处于编辑态时被无谓重建抢焦点。
- 旧备份目录只在下次 apply 时清理(不在插件加载时静默删目录)。
- passphrase 迁移 `app.secretStorage`(Obsidian 1.12+)记入 backlog,不在本轮。
