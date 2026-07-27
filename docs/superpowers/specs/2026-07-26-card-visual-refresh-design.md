# 卡片视觉整理设计(控件图标化 + mode 派生化 + 渐进披露)

日期:2026-07-26(UI 反馈第 4 轮)
状态:定稿(mockup 已确认:https://claude.ai/code/artifact/239c8393-cd61-4faa-95aa-e49f1804b446)
前置:`2026-07-25-unified-card-design.md`(卡模型)、`2026-07-26-ui-feedback-round2-design.md`(合并卡)。冲突处以本 spec 为准。

## 0. 背景与决策记录

真实 vault 走查第 4 轮:抽屉里 Custom path 开关、"□ Encrypt" 复选框、常显 ✎ 三种控件语言混用且右缘不对齐,卡片展开后信息量吓退普通用户。四项裁定(均经 mockup 定稿):

| # | 反馈 | 裁定 |
|---|------|------|
| 1 | "(entire file)" 行有必要吗 | 删除——整文件 scope + 🔒 并入路径行(§2)。 |
| 2 | "Plain" 语义不贴,"Whole file" 对 Appearance 又难理解 | mode chip 整个删除,模式变派生状态(§3)。 |
| 3 | Custom path 用 toggle 不合适 | 立规则:toggle 仅表达持续开/关状态;编辑动作一律图标按钮。Custom path → ✎(§2)。 |
| 4 | 展开卡太复杂,普通用户望而生畏 | 渐进披露:预览与成员列表默认折叠,+ Add folder 降级文本行(§4)。 |

设计不变式:**每一层复杂度都由一次用户点击换来**。新手路径 = 开卡片开关,到此为止。

## 1. 范围

- §2 控件图标化 + 四列栅格
- §3 mode 派生化(chip 删除、plain/fields 自动切换)
- §4 渐进披露(预览折叠、成员折叠、Add folder 降级)
- §5 副本合同
- 非目标:引擎 compile 语义(fileRule/fields 互斥等全部沿用)、Sync Center、schema/存储格式(`settingsFile.mode` 字段保留,仅由 UI 自动写)。

## 2. 控件图标化 + 四列栅格

### 2.1 栅格

抽屉内所有"行"统一四列 grid:`内容 1fr | scope 下拉(定宽,与现 scope chip 同宽)| 状态位(🔒 或小开关)| 动作位(✎/✕)`,列间距一致,右缘一条线。落点:

- Settings file 路径行、逐键规则行、Enabled on 行(scope 落 scope 列,后两列空)、伴生目录行、snippets 成员行(scope 落 scope 列,后两列空)、themes/普通目录成员行(仅内容列)。

### 2.2 控件替换

- **Custom path**:`[toggle] Custom path` 删除。路径行动作位 = ✎ 图标(Obsidian `setIcon("pencil")`,aria/tooltip `Custom path`)。点击 → 路径变输入框(现有 commit/校验/revert 逻辑复用);已提交自定义路径时 ✎ 常显高亮,旁出现 ↺ 图标(`setIcon("rotate-ccw")`,tooltip `Reset to default path`)点击还原默认。
- **Encrypt**:`□ Encrypt` 复选框删除。状态位 = 🔒 图标开关(`setIcon("lock")`):未加密 = muted 色,加密 = accent 色 + 高亮底;scope 为 This device 时禁用置灰(沿用 `encryptDisabledForScope`);aria/tooltip:`Encrypt` / `Encrypted`。作用于路径行(整文件)与每条逐键规则行。
- **✎ 悬停显现**:所有动作位图标默认 `opacity: 0`,行 `:hover` 或 `:focus-within` 时显现(键盘可达);已高亮状态(自定义路径中)不隐藏。
- 伴生目录行的 ✎(改路径)与 ✕(删除用户目录)同规则。

## 3. mode 派生化

### 3.1 行为

- **头行回到 `名字 + 徽章 + 开关`**,mode chip 删除;`Plain`/`Fields`/`Whole file`/`Per key` 等词不再出现在 UI。
- **无逐键定制**(`settingsFile.rules` 与 `perItem` 均空)= 整文件状态:路径行 scope ▾ 写 `fileRule.scope`、🔒 写 `fileRule.encrypted`(scope 语义沿用 D9:无 This device 档,卡片总开关负责退出)。
- **存在任一逐键定制**(rules 或 perItem 非空,含 snippets 成员 scope——它就是 `enabledCssSnippets` 的 perItem)= 逐键状态:路径行 scope/🔒 禁用置灰,tooltip `Per-key rules are active — remove them to control the whole file again`;规则行常显:`key | scope ▾ | 🔒 | ✕`,✕ 删该条规则(数组键的 Per-item scopes 开关及逐元素行沿用现状,渲染进同一栅格)。
- **逐键行只列已配置规则的键**(替代现 Fields 模式"列出文件里每个键"的全量列表——那是复杂度的主要来源之一);"文件里有哪些键"的浏览职责完全移交 File preview。未配置规则的键行为不变(随文件按默认同步)。
- **入口**:预览里点键加规则(现有 `addRuleForKey` 路径),图例行文案不变。
- **自动切换**:UI 写入时派生 `mode = (rules ∪ perItem 非空) ? "fields" : "plain"`(单一 helper,如 `deriveMode(settingsFile)`);首条规则创建时若存在 `fileRule` 则**丢弃**(fields+fileRule 为 manifest 非法组合),删光规则回整文件状态时 fileRule 从默认重新开始。存量配置无需迁移:fields+空规则的实效与 plain 默认一致,下次写入即归一。
- self 卡(config-sync 自身)预设规则恒存在 → 恒为逐键状态,与 `withSelfPresets` 强制 fields 一致。

### 3.2 删除清单

`modeChipLabel`、头行 chip 渲染(`renderHeaderModeChip`)、`cardBodyPlan`(派生后 UI 直接按"有无规则"分支)、以及所有 Plain/Fields UI 副本;`effectiveMode` 若仅剩引擎侧用途则移居/内联,以实现为准。

## 4. 渐进披露

- **File preview 默认折叠**:一行 `▸ File preview`(disclosure 行,点击切换 ▸/▾);展开才异步读文件渲染预览 + 图例(折叠时不读文件——顺带省 IO)。展开态存 UI-transient 集合(会话内记忆,不持久化,与 drawer 展开态同机制)。
- **成员列表默认折叠**:目录行内容列 = `名字 · N themes ▸`(themes 预置目录)/ `名字 · N files ▸`(其余),点击内容区切换;展开渲染成员行 + 对应 hint(hint 随成员一起出现/消失)。计数用现有成员扫描的结果,扫描仍是同步锚点 + 异步填充。
- **+ Add folder**:全宽按钮 → 安静文本行(`config-sync-add-row` 样式降级为链接态),行为不变。
- 逐键规则行不折叠(用户主动创建才存在)。

## 5. 副本合同(新增/变更)

| 位置 | 文案 |
|------|------|
| Custom path tooltip | `Custom path` |
| 还原默认 tooltip | `Reset to default path` |
| Encrypt tooltip | `Encrypt`(未加密)/ `Encrypted`(已加密) |
| 置灰文件行 tooltip | `Per-key rules are active — remove them to control the whole file again` |
| 规则行删除 tooltip | `Remove rule` |
| 预览折叠行 | `File preview`(▸/▾ 前缀) |
| 成员计数 | `· N themes` / `· N files`(N=实扫数) |
| 删除的副本 | `Custom path`(开关标签)、`Encrypt`(复选框标签)、`(entire file)`、`Plain ▾`/`Fields ▾` |

## 6. 测试与门

- 更新:itemCard 纯函数(modeChipLabel/cardBodyPlan 删除相关)、fileRule 读写路径用例、栅格/披露不涉纯函数处以实机验证兜底。
- 新增:`deriveMode`(空→plain、rules→fields、perItem→fields、幂等);首条规则创建丢 fileRule、删光规则回 plain 的 updateItem 序列;成员计数模型(若为纯函数)。
- 门:tsc / vitest 全绿 / eslint 0 error(≤64 warning)/ build / `npm run smoke:install` + dev vault 实机(默认 5 行卡、hover 显现、预览与成员折叠展开、mode 自动切换 + 置灰、✎ 改路径与 ↺ 还原、🔒 开关与 This device 置灰)。

## 7. 文档同步

- `2026-07-25-unified-card-design.md` §4/§10、`2026-07-26-ui-feedback-round2-design.md` §3.1(File preview 行为变化)加修订注记。
- README/zh(1:1)、DESIGN、ARCHITECTURE:卡片描述改为派生 mode + 渐进披露的现状表述。
- 照旧不提交。
