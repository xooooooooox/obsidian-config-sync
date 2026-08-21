# 2.25.0 · 验收修复第一批(B3/B4/C1) — Implementation Plan

> 台账:scratchpad `acceptance-ledger-2250.md`。本批只修三条**确认过根因的缺陷**;设计题(A2/B2/C2/C3)走 mockup 定稿,不在此列。

## B4:Pull/Push 按钮文字看不清 —— 类合同断裂

**根因(已确认):** `.config-sync-remote-btn.is-{pull,push}.is-primary`(青/粉实底 + 深字)与 `.is-dimmed` 这套类**只剩 CSS**,用它们的代码随旧 remote 面板在 2b 退役。统一后的页脚按钮挂 `setCta()`(accent 蓝底)+ `is-pull`,于是 `.is-pull:not(.is-primary) { color: cyan }` 把青字画在 accent 蓝底上。

**修法:** 按钮回到它们被设计的 primary 语言 —— Pull 挂 `is-primary`(青底深字)并去掉 `setCta()`,Push 挂 `is-primary`(粉底深字);删除 `.is-dimmed` 与两条 `:not(.is-primary)` 孤儿规则(不再有非 primary 形态)。CSS 注释同步。

- [ ] SyncCenterView 页脚两处 + styles.css;真机截图核对两键对比度。

## B3:FILES 展开条目缩进任意

**根因(已确认):** 列表是行的兄弟节点(有意,占全宽),但 `margin-left: var(--size-4-3)` 与卡片网格无关——既不对齐 130px label 列也不对齐 value 列。

**修法:** 缩进对齐 value 列起点:`margin-left: calc(130px + var(--size-4-2))`(与 `.config-sync-cardrow` 的 label 轨 + column-gap 同源;两处字面量并存已有 `.config-sync-advrow` 先例)。保留兄弟节点全宽的既有理由。手机窄屏下核对不挤。

- [ ] styles.css 一行;设备关系与 remote 关系两处截图核对。

## C1:`Keys` → `Key rules`

**已裁定方向(用户「应该统一」+ 我方倾向未被反对):** 卡片行标签改 `Key rules`,与 Settings 抽屉区块及 `More` 行 tooltip 的「Per-key rules…」三处一词。内部标识(keysRowModel 等)不改名 —— 这是显示文案,不是概念更名。

- [ ] SyncCenterView `renderCardKeyRow(fields, "Keys", …)` → `"Key rules"`;DESIGN.md 里 `Keys` 行的两处提法跟改;spec 是历史文档不动。

## 完成标准

三绿(1941 基线);重新部署三 vault;台账里三条标 FIXED 待复验。
