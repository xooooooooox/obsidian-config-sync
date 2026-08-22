# 2.25.0 · 验收设计轮(C3-a / A2-V1 / B2-V1 / C2-V3 / D1) — Implementation Plan

> 定稿视图 https://claude.ai/code/artifact/9e953300-58a9-42cb-a7e5-77737fac6d59,全部采纳。台账 `acceptance-ledger-2250.md`。D1 = 名词不动,无实现。

## Task 1:C3-a + A2-V1 —— 侧栏顶部

- **View 选择器移到搜索框之上**(移出 `sideSectionEl`,进 `renderSidebar` 顶部;搜索键入只重建 section 区,选择器不闪)。紧凑 switcher 经 `renderSectionEntries` 自动同构 —— 选择器从其菜单顶移除、由 renderSidebar 层负责?否:switcher 菜单仍要选择器(那是它唯一入口),保留 `renderSectionEntries` 里的调用,仅宽侧栏由 renderSidebar 提前渲染并让 renderSectionEntries 收 `withPicker` 参数避免双份。
- **关闭态 = 图标 + 单名**:device → `monitor` + `This device`;remote → `cloud` + 名(cloud 已是本面板的 remote 方向字形家族)。`relationLabel` 保留为 aria/悬停(`This device ↔ store` 原文),新增 `relationShortLabel`(panelModel,可单测)。下拉行同形。
- **计数条并入选择器行尾**:当前视图的 presented counts(up/down/ok/excluded/none/locked,零抑制规则照旧的头部规则),`side-badge` 字形。
- **头部撤 self-chip 与设备侧药丸**:`renderSelfChip` 及分隔线删除;头部只剩 remote 聚合 ⇡⇣ 药丸 + 刷新钮(右对齐)。fleet 半边不动(spec 5.5),视图半边搬进选择器。
- sidebarFit 的宽度模型跟改(短名 + 徽章数)。

## Task 2:B2-V1 —— 四档分段控件

- 新 helper `renderDirectionSeg(parent, stops, current, ariaOf, onPick)`:`.config-sync-dirseg`,按钮 = `REMOTE_DIRECTION_ICON`,当前档 `.is-on`,aria = `REMOTE_DIRECTION_LABEL`,一击直写(不再开 Menu)。
- `This remote` 行改用 `cardRowShell` + 控件轨右缘;`renderCardMenuRow` 留给 After install/Enablement。
- Keys 区每键行的 menuchip 换成同形 mini seg,只画 `keyStopsWithin(item)` 允许的档。

## Task 3:C2-V3 —— 行序 + Key rules 呈现

- 行序:State → **This remote** → Files → On/off → **Key rules** → Resolve → 其余入口(Settings sync/More 收尾)。
- Key rules 呈现照 Settings:提示行**领在上方**(静态,非开关)→ 规则行 → 文档**直接展开**;文档 >12 行折叠为 `… Show all N keys`(点开记入既有 `keyDocOpen`)。

## 完成标准

三绿;`relationShortLabel` 有单测;真机三 vault 重部署复验。
