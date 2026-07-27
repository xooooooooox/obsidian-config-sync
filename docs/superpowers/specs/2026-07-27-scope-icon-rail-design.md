# Scope 图标轨设计(Commander 式循环 + 去铅笔)

日期:2026-07-27
状态:已实现(round 6 第三条反馈的定稿产物)
前置:`2026-07-26-card-visual-refresh-design.md`(四列栅格)。本 spec 修订其 §2 的 scope 列形态与 §2.2/§5 的 ✎ 入口;冲突处以本 spec 为准。

Mockup(定稿依据,固定深色):https://claude.ai/code/artifact/2d8435ab-3daf-4376-a68c-247ce91eba24
用户裁定:方案 C(Commander 循环)+ 去掉 ✎ 铅笔(点路径文字编辑)。

## 1. Scope 控件:Commander 式循环图标

原生 `select` 下拉整体退场(六处:ENABLED ON、路径行、规则行、逐项元素行、伴生目录行、snippet 成员行)。取而代之:

- **图标即状态**(`SCOPE_ICONS`,itemCard.ts):`all` → `monitor-smartphone`,`desktop` → `monitor`,`mobile` → `smartphone`,`local` → `airplay`(与 Commander 插件同套图标语言)。
- **点击循环**到该行自己的选项表的下一项(`nextScope`,越界回绕)——FILE/COMPANION 三项循环,FIELD 四项循环。键盘 Enter/Space 等效。
- tooltip/aria:`Change scope (currently: <label>)`(`scopeCycleTooltip`)。
- 视觉:默认 `all` 淡显(opacity 0.45,与 ghost 轨呼应),非默认满亮 + accent(`.is-set`);disabled(路径行被逐键规则锁定时)沿用 `.config-sync-dim`。
- 栅格 scope 列 120px → 28px(`.config-sync-grid`),右缘成为 scope | 锁 | 动作 的等宽纯图标轨。
- 刷新契约:调用方负责写入后让图标读到新值——路径行(整行重画)、规则/元素行(refreshCardBody)天然覆盖;ENABLED ON、伴生目录行、snippet 成员行各自带 build() 闭包就地重建(后两者因 updateCompanion/成员区不在任何既有刷新范围内)。

## 2. 去铅笔:路径文字即编辑入口

- **路径行**:✎ 与 ↺ 图标删除,动作列留空。路径文字(`.config-sync-card-pathbtn`)hover/focus 显示虚线下划线+淡底,点击/Enter 进入编辑态(input 自动聚焦);已自定义路径常态下 accent 色(`.is-custom`)。
  - `editing` 不再被 committed 强制:自定义路径也以文字显示,点击才编辑。
  - 编辑态:Enter/blur 提交(原 commitSettingsFilePath 流程不变);blur 无变化 → 退出编辑回文字视图;提交/模态取消后同样退出编辑态。
  - **Reset to default** 改为编辑态内的文字动作(仅 committed 时显示),走同一 D7 确认流程;用 mousedown+preventDefault 注册,避免 input 的 blur-提交先拆掉按钮。
  - **Escape 取消**:经 Obsidian `Scope` 实现(input focus 时 pushScope、blur/Escape popScope)——keymap 在 window 捕获阶段先于元素监听拿到 Escape,元素级 stopPropagation 挡不住设置窗口被关闭。
- **伴生目录行**:✎ 删除;目录名(code 元素)自身可点击进入既有的 Save/Cancel 编辑行,click/keydown 均 stopPropagation,内容格其余区域(计数、▸/▾)仍然切换成员列表。非 preset 行的 ✕ 保留(动作列仅剩的图标)。
- 规则行 ✕ 不变。

## 3. 已知取舍

- 循环切换跨值要多点几下;误点一下即写入(无确认),再点 N-1 下回到原值——Commander 同款行为,用户明确选择。
- 路径编辑失去永久可见入口,靠 hover 提示发现(低频操作换常态干净)。
- 伴生编辑行(Save/Cancel)的 Escape 仍会关设置窗口(有显式 Cancel 按钮,遗留现状,未在本轮范围)。

## 4. 测试与门

- 新增(tests/itemCard.test.ts):nextScope 三组循环、SCOPE_ICONS 完整且互异、scopeCycleTooltip 文案。
- 门:tsc 干净、vitest 745/745、eslint 0 error/64 warning 基线、build、smoke:install 后 dev vault 实机验证(六处图标渲染与循环写入、加密位在 scope 循环中保持、路径 click-to-edit/Escape/伴生 Cancel/成员列表切换、锁定行置灰、状态全部还原)。

## 5. 文档同步

README 截图本就在 cut 前重截清单里(settings-picker/sync-panel);README 文字未描述 scope 控件形态,无行级改动。与既有未提交批次同批等 cut。
