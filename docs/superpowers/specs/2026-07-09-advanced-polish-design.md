# advanced-polish 设计文档

第六轮迭代:Advanced 表单重排 + reset/一键 + 文案与按钮打磨 + name 校验。2026-07-09 定稿。上游文档:[iter5 grouped-picker](2026-07-09-grouped-picker-design.md);本文档只描述增量。

## 背景:0.4.0 真机试用的反馈(#6 搁置)

1. Advanced 表单行内挤 7 个控件溢出(sanitize 被截);解锁改 path 保存后行变形。
2. Managed 行改过后想还原,需手工改回,应提供 reset。
3. 锁/reset 除逐行外,还应支持一键(lock-all / unlock-all / reset-all)。
4. 分组描述文案偏静态("Turned on here"),应改为动作导向("Sync the settings file of already-enabled plugins")。
5. picker 分组的 Sync all/none 按钮,视觉上应与条目行按钮一致。
6. (**搁置**)config-sync 自身同步——另有新问题待想清,本轮不做。
7. group name 应变量风格;截图误把描述框当 name(实为一行控件过多把 name 挤没了)。
8. 真机枚举出现两类不该在 Obsidian tab 的条目:`.DS_Store`(iter5 回归——`presentSets` 丢了 `.json` 过滤);配置根的未知 `.json`(如 `image-converter-image-alignments.json`,归属不明)。前者彻底过滤,后者移到 Advanced 新增的 Discovered 分区。

## A. Advanced 行重排为卡片(方案 A,解决 #1 + #7 显示)

每条规则渲染为一个卡片,标题行 + 两个控件行,永不溢出:

```
┌─────────────────────────────────────────────────────────┐
│ 🔒 <name>   ⚙ customized (was <expected>)      [↺ reset] │  标题行
│    Location [Config folder ▾]   Path [<rel>          ]   │  控件行 1
│    Type [file ▾]   Devices [all ▾]   Sanitize [………]     │  控件行 2
└─────────────────────────────────────────────────────────┘
```

- **标题行**:锁图标(managed)、**变量风格 name 显眼呈现**(解决 #7 的"看不到 name"),customized 溯源徽标(见 iter5 §I),右侧 **reset 按钮**(见 §B);custom 行标题行的 name 为可编辑文本框(见 §D 校验);
- **控件行**:description、location、path、type、devices、sanitize 分两行铺开,带内联小标签(Location/Path/Type/Devices/Sanitize);
- **锁定态**:managed 卡片未解锁时,两个控件行的字段全部 `disabled`(reset 按钮不禁用——reset 是"还原",无需先解锁);解锁后可编辑;
- **草稿语义不变**:文本字段 onChange 只存不重渲染(防丢焦);结构性操作(锁/解锁/type 改/reset/删除/一键)`await save → refresh`;
- CSS 类前缀 `config-sync-`(`config-sync-rule`、`config-sync-rule-head`、`config-sync-rule-controls`),用 Obsidian CSS 变量;移动端窄屏控件行自动换行。

**#1(b) 保存变形根因**:留待实现期用 obsidian-cli/devtools 定位(现状:改 path 走"只存不重渲染",改 devices 走"存+refresh 重建";变形只在前者出现,疑似部分 DOM 未重建);卡片布局重写后以"结构性变更才重建、文本变更就地"验证不再变形。

## B. Managed 行 reset(#2)

- 每个 managed 卡片标题行一个 **reset 按钮**(lucide `rotate-ccw`):把该组还原为其 picker 默认——`path = expectedPathForName(name)`、`devices = "all"`、`description = <catalog 默认>`、清除 sanitize;
- 还原后 customized 徽标消失(path 回到预期);reset 是结构性操作,`await save → refresh`;
- catalog 提供纯函数 `defaultGroupForName(name, coreLabels): SyncGroup | null`(name→默认组;`null` 表示非保留名不可 reset)——纯函数可测。

## C. 一键 lock-all / unlock-all / reset-all(#3)

- Managed 区标题行右侧三个按钮:**Lock all / Unlock all / Reset all**;
- Lock/Unlock all:清空或填满 `unlocked` 集合(UI 瞬时态),`refresh`;
- Reset all:对所有 managed 组套用 `defaultGroupForName` 还原,一次 `writeGroups + refresh`;非保留名(不该出现在 managed,防御性)跳过;
- Managed 区为空时三按钮不显示。

## D. group name 变量风格校验(#7)

- **custom rules 的 name 强制** `^[a-z0-9][a-z0-9_-]*$`(小写字母/数字/连字符/下划线,首字符非分隔);
- 校验层(`validateSyncManifest`/`parseGroup`)硬拒非法 name,报错含具体原因("group name must be lowercase letters, digits, - or _");手写文件与面板两路都兜现;
- 面板 custom name 输入框就地校验提示(非法不落盘,复用 groupsErrorMsg);
- managed 保留名(`app`/`community-plugins`/`plugin-<id>`/核心 id)本就合规,不受影响;
- 兼容:老 config-sync.json 若有不合规 name(理论上只可能是用户手写),打开时 `readGroups` 报错并提示手工改名——与既有"读不了配置"横幅一致;starter(`snippets`/`hotkeys`)与全部保留名均合规,零迁移。

## E. 分组描述文案动作导向(#4)

三个 picker tab 的分组标题描述改为"说清勾选后会同步什么",最终英文文案:

| Tab · 分组 | 新文案 |
|---|---|
| Obsidian · Available | "Sync these settings that already exist in this vault." |
| Obsidian · Not yet in this vault | "Nothing to sync yet — customize these in Obsidian first, then they'll appear here." |
| Obsidian · Not recommended | "Device-specific — syncing makes your devices overwrite each other's layout." |
| Core · Enabled | "Sync the settings files of your enabled core plugins." |
| Core · Disabled | "Sync a disabled core plugin's settings now, ready for when you turn it on." |
| Core · Not recommended | "Holds account or device-specific data — not meant to travel between vaults." |
| Community · Enabled | "Sync the settings files of your enabled community plugins." |
| Community · Installed but disabled | "Sync a disabled plugin's settings now, ready for when you turn it on." |
| Community · Not recommended | "Machine-bound or credential-bearing — cannot be synced." |

(纯文案改动,catalog 分节函数里 section 的 description 字段替换。)

## F. Sync all/none 按钮样式统一(#5)

- 现状:Sync all/none 挂在分组标题行(`Setting.setHeading().addButton`),视觉与下方条目行按钮不一致;
- 改为与条目行同款按钮样式:分组标题下方紧跟一个操作行(或标题行右侧按钮采用与条目 toggle/按钮一致的 Obsidian 标准样式类),使其看起来"属于这个分组的条目区";
- 语义不变:未全勾显 "Sync all",已全勾显 "Sync none";Not recommended 组不显示;点击 = `toggleSection` + `save` + `refresh`。
- (纯 UI/CSS 调整,不动 catalog。)

## G. 枚举过滤 + Discovered 分区(#8)

### G.1 过滤(bug 修复)

iter5 的 `presentSets` 收了配置目录下**所有文件**,`listOptionSections` 的未知文件循环未再滤 `.json`,导致 `.DS_Store` 等泄漏。修复:未知文件枚举**只收 `.json` 且非 dotfile**(`!b.startsWith(".")`);非 .json/dotfile 彻底不进任何分区(连 Discovered 也不进——它们不是配置)。

### G.2 Discovered:未归类配置根 json

- **定义**:配置根下的 `.json` 文件,**不属于**任何已知全局项(OPTION_LABELS)、核心设置文件(CORE_FILE_SET)、switch-list、`plugins/` 目录、hidden;**且当前无任何组的 path 覆盖它**(按 path 覆盖判定,不是 name)。
- **归属结论(诚实约束)**:Obsidian 不暴露"哪个插件写哪些根级 json",`image-converter-*` 之类前缀是巧合、不可依赖。故**不猜归属**,统一视为"未归类";即便它真属于某已 managed 插件,那也与该插件的 `plugins/<id>/data.json`(plugin-<id> 组)是两个独立文件、路径不重叠,无归属必要。
- **它们不是 picker 项**(无固定保留名身份),而是**候选的规则**:呈现在 Advanced 的 Discovered 分区,由用户命名后落成一条组。

### G.3 Advanced 三分区(取代原两分区)

Advanced tab 下并列三个分区,**按"用户对哪个字段有编辑权"划分**(比"name 是否保留名"更贴产品语义):

| 分区 | name | path | 用户操作 | 判定 |
|---|---|---|---|---|
| **Managed by pickers** | 确定(保留名),只读 | 硬编码,**可解锁改** | 决定同步;必要时改 path;reset | name ∈ reservedNames |
| **Discovered files** | 预填文件名 slug,**可改** | **确定、只读**(就是那个文件) | 起名 + 决定是否同步(toggle) | 配置根未归类 json,无组覆盖 |
| **Custom rules** | 用户填,可改 | 用户填,可改 | 全部自填;可删 | 其余(既非保留名,也非 Discovered 候选) |

- **Discovered 卡片**:标题行显文件名标签;控件行只给 **name 输入(预填 `<filename 去 .json>` 的 slug,可改,变量风格校验)** + 一个**同步 toggle**;path/type/location/sanitize 只读展示(path = `{configDir}/<filename>`,type=file);toggle 打开且 name 合规 → 落成组(此后它被 path 覆盖,不再出现在 Discovered,而是进 Custom rules 那样的已保存规则——但因非保留名,归入 Custom 分区显示)。
- **判定顺序**:一个已保存的组,若 name ∈ reservedNames → Managed;否则 → Custom。Discovered 只展示**尚未成组**的候选文件,故与已保存组不重叠。
- catalog 提供纯函数 `listDiscovered(io, configDir, groups): Promise<{ name: string; path: string }[]>`(枚举 - 已知/核心/switch/plugins/hidden/非json/dotfile - 已被 path 覆盖;name 为预填 slug),纯函数可测。

## H. 搜索框样式(#9)

现状:`renderSearchBox` 用 `new Setting().setName("Search").addText()`——左标签 + 右输入框的设置行,不像搜索框。改为 **Linter 同款的居中独立搜索框**:

- 用 Obsidian 原生 `SearchComponent`(自带圆角边框、搜索图标、清除 × 按钮),外层一个居中容器 `config-sync-search`(flex 居中、限宽 `max-width` 复用 `.search-input-container`);
- placeholder 改为 "Search all settings…";
- 焦点保持逻辑不变(`searchInputEl = search.inputEl`);清除 × → onChange("") → refresh;`display()` 仍重置 search=""。

## 错误处理

沿用既有:非法不落盘、就地显示(name 校验走 groupsErrorMsg / 读盘横幅);reset/一键/Discovered-add 为结构性操作,失败经 groupsErrorMsg 呈现。

## 测试

- catalog 纯函数单测:`defaultGroupForName`(保留名→默认组、非保留名→null、含 description/清 sanitize/devices=all/path=expected);`listDiscovered`(枚举根级未知 json、排除已知/核心/switch/plugins/hidden/非json/dotfile、排除已被 path 覆盖的、name 预填 slug);`.DS_Store`/dotfile 不进任何分区;
- 校验单测:custom name 合法/非法(空格、大写、非法符号被拒;保留名与 starter 通过);
- UI 不做单测,obsidian-cli 冒烟:Obsidian tab 不再出现 .DS_Store/未知 json、Advanced 卡片布局不溢出、解锁改 path 保存后不变形、逐行 reset 还原+徽标消失、一键 lock/unlock/reset、Discovered 分区列出未归类 json 并可命名 Add、custom name 非法提示、分组文案、Sync all/none 按钮样式。

## 验收清单

1. Advanced 每条规则为卡片,7 个控件不溢出;name 变量风格显眼可见;
2. 解锁改 path 保存后行不变形;
3. 每个 managed 行有 reset,点击还原为 picker 默认、customized 徽标消失;
4. Managed 区有一键 Lock all / Unlock all / Reset all,行为正确;
5. custom rule name 非变量风格被拒(面板提示 + 手改文件读盘报错);
6. 三 picker tab 分组描述为动作导向文案;
7. picker 的 Sync all/none 按钮与条目行按钮视觉一致;
8. `.DS_Store`/非 .json 不再出现在任何分区;配置根未知 json 出现在 Advanced 的 Discovered 分区,预填 slug 可改、path 只读,命名后 Add 落成组并从 Discovered 消失;Advanced 为 Managed / Discovered / Custom 三分区。
