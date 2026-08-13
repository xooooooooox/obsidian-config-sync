# 启用范围:两粒度 × 两层 — 设计定稿

**状态**:定稿,待写实施计划。
**Mockup(现状 / 修改后 逐屏对照)**:https://claude.ai/code/artifact/930aee7a-0d4b-43a8-9ca0-5437688a78f6
**前序 spec**:`2026-08-11-data-model-hardening.md`(2.21.0)、`2026-08-11-v3-one-vocabulary-design.md`(2.22.0)。本文继承它们的两条不变量,不重复论证。

---

## 1. 问题

同一个问题——"这个东西在哪些设备上生效"——今天有五套互不相同的表达:

| 表达 | 存放位置 | 会不会传播 | 谁写 |
|---|---|---|---|
| `Item.enabled` | data.json | 会 | settings panel 卡片顶部开关 |
| `Item.runsOn.device` | data.json | 会 | 卡片 `Enabled on` 前三档 / Sync Center `Runs on` |
| `Item.runsOn.force` | data.json | 会 | Sync Center `Runs on` 的 `Always on here` / `Never on here` |
| `settings.thisDeviceItems` | data.json | **会**(但语义是"这台") | 卡片 `Enabled on` 第四档 `This device` |
| `config-sync-device-optouts` | localStorage | 不会 | Sync Center 页脚 `Stop syncing ▸ On this device` |

三处病灶:

1. **一个控件两处写入**。卡片的 `Enabled on` 四档循环,前三档写 `runsOn.device`,第四档写 `thisDeviceItems`(`SettingTab.ts:929-961`)。用户看到的是一个控件,背后是两种命运。
2. **本机语义放在会传播的地方**。`thisDeviceItems` 与 `runsOn.force`(`where` 恒为 `"everywhere"`,`types.ts:114-118`)都自称"这台",实际全舰队生效。C-#52 那次 opt-out 被 pull 重置,根因就是这一类。
3. **同一格数据的两层被拆到两个界面**。文件级的舰队规则在 Sync Center 的 `SETTINGS SYNC` 行里,文件级的本机例外藏在页脚菜单第二项里。

---

## 2. 模型

同步的对象有**两种粒度**,每种粒度上问**同样的两个问题**:

|  | 舰队级 · 共享的默认答案<br>(data.json,会传播) | 本机级 · 这台要不要例外<br>(localStorage,不传播) |
|---|---|---|
| **整个文件**<br>= 这一项自己的设置文件 | `settingsFile.fileRule.sharing`<br>行标签 `DEFAULT SETTINGS SYNC` | `config-sync-device-optouts`<br>行右段 `Not synced here` |
| **名单里的一项**<br>= 插件开不开 | 载体的 `settingsFile.perElement[<list>]`<br>行标签 `DEFAULT ENABLED ON` | `config-sync-device-elements`(新)<br>行右段 `On here` / `Off here` |

第三层是**状态**——插件此刻在这台机器上开着还是关着——它住在 Obsidian 自己的名单文件里,config-sync **不存**,只在名单同步时按规则掩码。这一点不变。

---

## 3. 数据结构

### 3.1 归位后的 `data.json`(`schemaVersion: 4`)

```jsonc
{
  "schemaVersion": 4,

  // 本机专属、锁定在本地的传输接线(catalog.ts selfPresetRules),不变
  "pkmMode": "auto",
  "rootPath": "",
  "remotes": [],

  "items": {
    "obsidian": {
      "app":        { "synced": true, "settingsFile": { "mode": "fields", "rules": { … }, "perElement": {} } },
      "appearance": {
        "synced": true,
        "settingsFile": {
          "mode": "fields",
          "rules": { … },
          // 既有形状:按 JSON 键名索引的字符串数组
          "perElement": { "enabledCssSnippets": { "mobile.css": { "kind": "per-class", "class": "mobile" } } }
        },
        "companions": [ { "path": "themes", "device": "all", "enabled": true } ]
      },
      "hotkeys": { "synced": true, "settingsFile": { … } },

      // 新:两份名单成为真实条目(今天它们只是编译产物 registry.ts:746-753)
      "core-plugins": {
        "synced": true,
        "settingsFile": {
          "mode": "plain",
          "rules": {},
          // 保留键 "" = 这份文件本身就是名单(见 §3.3)
          "perElement": { "": { "daily-notes": { "kind": "this-device" } } }
        }
      },
      "community-plugins": {
        "synced": true,
        "settingsFile": {
          "mode": "plain",
          "rules": {},
          "perElement": { "": { "obsidian-git": { "kind": "per-class", "class": "desktop" } } }
        }
      }
    },

    "core":      { "daily-notes": { "synced": true, "settingsFile": { … } } },
    "community": {
      "obsidian-git": {
        "synced": true,
        "settingsFile": { … },
        "bratRepo": "owner/repo"          // 由顶层 bratIndex 折入(见 §3.2)
      }
    },
    "custom":    { "my-folder": { "synced": true, "type": "folder", "path": "…" } }
  },

  // 偏好,不变
  "ribbonButtons": { "sync": false },
  "statusInMenu": true,
  "statusBarItem": true,
  "statusBarRemote": true,
  "ribbonDot": false,
  "mobileStatusBar": false,
  "remoteAutoCheck": true,
  "localPeriodicCheck": true,
  "runHistory": { "enabled": true, "path": "", "maxCount": 50, "maxDays": 30 }
}
```

### 3.2 逐字段的增删改

| 字段 | 动作 | 理由 |
|---|---|---|
| `Item.enabled` | **改名 `synced`** | `enabled` 今天两义:"这一项被同步"与"这个插件开着"。前者才是它的意思 |
| `Item.runsOn` | **删除** | `device` 轴迁入载体的 `perElement`;`force` 轴见下 |
| `Item.runsOn.force` | **删除,不迁移** | 它自称 `here` 却全舰队生效。真实数据里三个 vault 108 条条目**一条都没有** `force`(2026-08-12 实测),删除不影响任何现存配置 |
| `Item.elements` | **删除** | `registry.ts:121` 声明至今无人写入。它要做的事由载体的 `perElement` 做 |
| `settings.thisDeviceItems` | **删除**,迁移进 localStorage | 本机语义不能住在会传播的文档里(§4.2) |
| `settings.bratIndex` | **删除**,折入 `items.community.<id>.bratRepo` | 一个插件的属性住在插件条目上;顶层平行 map 是第二份 id 名单,会与 `items.community` 漂移 |
| `ItemSettingsFile.perElement` | **保留,扩用** | 见 §3.3 |
| `schemaVersion` | `3` → `4` | |

### 3.3 规则的存放位置与保留键

规则值直接复用既有的 `Sharing` 联合(`types.ts:61`),**不新增类型**:

| UI 文案 | `Sharing` 值 | 名单同步时的效果 |
|---|---|---|
| `All devices` | `{kind:"everywhere"}` | 元素进入 store,所有设备一致 |
| `Desktop only` | `{kind:"per-class",class:"desktop"}` | 只在电脑类设备上生效 |
| `Mobile only` | `{kind:"per-class",class:"mobile"}` | 只在手机类设备上生效 |
| `Each device decides` | `{kind:"this-device"}` | **元素永不进入 store,也不被 store 复活**(`perElement.ts` capture/apply 已实现) |

`Each device decides` 不是新语义:`perElement.ts:56-62` 对 `this-device` 元素的处理("this-device elements — on either side — never enter the result")正是"每台自己决定"。这次只是给它一个说得出口的名字,并把另外两份名单接上同一套机制。

**保留键 `""`**。`ItemSettingsFile.perElement` 今天按 **JSON 键名**索引(appearance 的 `enabledCssSnippets`)。两份插件名单**整个文件就是名单**,没有键名可索引,因此约定保留键 `""` = "这份文件本身"。

- 该键由 **唯一的生产者** `perElementKeyFor(listId: string): string` 产出(新函数,放在 `switchList.ts`,与 `SWITCH_LISTS` 同源:有 `field` 则返回 `field`,无则返回 `""`)。
- 任何比较、查找、写入都必须经过它。**测试断言两个生产者相等,不得对着手写字面量**(§9 教训三)。

**形状不对称,必须显式处理**:

| 名单 | 文件形状 | 规则应用路径 |
|---|---|---|
| `community-plugins` | `string[]` | `perElement.ts` 的数组路径,现成 |
| `enabled-css-snippets` | `appearance.json` 里的 `string[]` 字段 | 同上,今天已在用 |
| `core-plugins` | **`Record<string, boolean>`** | **不能走 `perElement.ts`**;走 `switchList.ts` 既有的按 id 掩码(该模块头部注释已声明支持两种形状) |

规则的**存放**统一(一个 `perElement` map),规则的**应用**按文件形状分派。这条分派必须只有一处实现。

### 3.4 localStorage

既有键不动:`config-sync-device-id`、`config-sync-device-optouts`(**分组名数组**,整文件粒度的本机例外)、baselines、passphrase、ledger、coldstart。

新增**一个**键,形状对齐 data.json 的 `perElement`(同样的两级嵌套、同样的元素键),只是值域不同:

```jsonc
// config-sync-device-elements
{
  "community-plugins": { "obsidian-kanban": "on",  "some-plugin": "off" },
  "core-plugins":      { "daily-notes": "off" },
  "enabled-css-snippets": { "mystyle.css": "on" }
}
```

- 外层键 = 名单标识(`SWITCH_LISTS` 的键),**不是** `perElementKeyFor` 的结果——localStorage 这一侧不存在"哪个 JSON 字段"的问题,名单标识本身就是身份。
- 值只有 `"on"` / `"off"`:这台此刻要它开还是关。
- 任何非法形状读作"这台没有例外",与 `deviceOptOutGroups()`(`main.ts:1131-1148`)同一条容错规则:读不出自己的例外表也必须能同步,不能加载失败。
- 解析每次加载至多一次并缓存,同 `deviceOptOutsCache`。

---

## 4. 迁移(v3 → v4)

沿用 `settingsMigration.ts` 的既有分类器:**更高的 `schemaVersion` 拒绝加载,不重置**(不变量 II)。v3 文档一次性迁移:

| v3 | v4 | 规则 |
|---|---|---|
| `Item.enabled` | `Item.synced` | 直接改名,值不变 |
| `Item.runsOn.device === "all"` | 不写任何规则 | 与"缺失即 All devices"一致 |
| `Item.runsOn.device === "desktop"/"mobile"` | 载体 `perElement[key][elementId] = perClass(...)` | `elementId` 取自 `def.enablement.element` |
| `Item.runsOn.force` | **丢弃** | 真实数据为零(§3.2);且它的语义本身是错的 |
| `settings.thisDeviceItems[]` | ① 载体规则写 `{kind:"this-device"}`;② 本机例外表写入**该项此刻在这台机器上的真实状态** | 见下 |
| `settings.bratIndex[id]` | `items.community[id].bratRepo` | 条目不存在则先建 `{synced:false}` 骨架,不凭空开启同步 |
| 未知字段 | **原样保留** | 不变量 II.1 |

**`thisDeviceItems` 的迁移是两半,缺一不可**。它今天是一个"语义是本机、存放却会传播"的字段,所以每台设备读到的是同一份清单。迁移时:

- 舰队侧写入 `{kind:"this-device"}` —— 这保留了今天的可观察行为(该项不进 store,每台自己决定);
- 本机侧把**这台此刻的真实状态**固化下来,使迁移那一刻**任何设备上的任何插件开关状态都不改变**。

验收:迁移前后,`community-plugins.json` / `core-plugins.json` / `appearance.json` 的本地内容**逐字节不变**。这是本次迁移唯一的硬性行为断言。

`store.lock.json` 不受影响:`version: 3` 的锁描述的是 store 里有什么,与本次改动的是 data.json 的规则表达。**不得**顺手改锁版本。

---

## 5. 运行时

掩码的汇聚点不变:`main.ts:1870-1888` 的 `switchExceptions` + forceOn/forceOff。改的只是**它的输入从哪里读**:

```
今天:  runsOn.device(item) + runsOn.force(item) + thisDeviceItems(settings)  → switchExceptions
之后:  perElement 规则(载体 item) + 本机例外表(localStorage)               → switchExceptions
```

优先级,自上而下,第一个命中者胜:

1. 本机例外表里有这个元素 → 用它的 `"on"`/`"off"`,**不再看规则**
2. 规则是 `this-device`(Each device decides) → 这台自己决定:不进 store,当前本地状态原样保留
3. 规则是 `per-class` 且不匹配本机设备类 → 掩掉
4. 其余 → 跟随共享名单

`main.ts:1521-1570`(`thisDeviceItems` 的读写)、`registry.ts` 的 `enablementSharing`、`itemCard.ts` 的 `RUNS_ON_OPTIONS` / `runsOnIcon` / `runsOnLabel` / `runsOnIsDefault` / `runsOnEquals` / `asRunsOn` 一并退役。退役必须是删除,不是保留一个无人调用的读取器——本仓库已有三个无调用者的宿主方法在台账里等着,不再增加。

---

## 6. UI 契约

### 6.1 通用行形状(一行两段)

四轨网格:`标签 | 舰队段 | 竖分隔线 | 本机段`。轨宽固定,使同一张卡里所有行的图标与状态词落在同一竖线上。

- **舰队段**:图标 + 文字,点击出菜单(四值)。图标沿用 `sharingIcon()`:`monitor-smartphone` / `monitor` / `smartphone`;`Each device decides` 用 `users`。
- **本机段**:
  - 跟随时——**不给图标**,只有一句暗色 `Follows the default`。默认态没有话要说;`airplay` 表示"这台"读不出来(它的通用含义是投屏)。
  - 例外时——紫色图标 + 状态词,点击出菜单。

### 6.2 Sync Center · 行详情

行字段顺序:`State` → `Files` → `Default enabled on` → `Default settings sync` → `More` → (hotkeys 的 `Note`)。

| 行 | 舰队段 | 本机段 |
|---|---|---|
| `DEFAULT ENABLED ON`(仅载体已同步的插件行) | All devices / Desktop only / Mobile only / Each device decides | Follows the default / On here / Off here |
| `DEFAULT SETTINGS SYNC` | All devices / Desktop only / Mobile only(`FileSharing`,无 this-device) | Follows the default / Not synced here |
| `MORE` | `settings-2` 图标,tooltip = `Per-key rules, locks & folders — opens Settings` | — |

`MORE` 行的整句搬进 tooltip,行内只留图标;末尾 `▸` 一并去掉。**不得用 `sliders-horizontal`**:它在 fate chip 里已经是 `your rule`(`fateChipIcons.ts:10-12`)。

**页脚整个删除**:`renderStopSyncing`、`buildStopSyncingMenu`、`canStopSyncing`(`SyncCenterView.ts:2996-3020` 及其菜单)全部退役。

- 菜单第二项(本机 opt-out)搬进 `DEFAULT SETTINGS SYNC` 的本机段。
- 菜单第一项(`Everywhere…`)写的是 `Item.synced`,而它的写入口是 settings panel 卡片顶部的开关——与名单芯片同一条理由:**一份数据一个写入口**。破坏性动作只保留一个家,并且是在配置这一项的地方、带确认框(`StopSyncingModal` 本身不动,仍由卡片侧调用)。
- Sync Center 因此只做两件事:改规则、设本机例外。要停掉一整项,走 `MORE` 图标跳过去。

### 6.3 Sync Center · 分区头的名单芯片

`renderCarrierChip`(`SyncCenterView.ts:2296-2340`)由**写入方**变为**只读快捷方式**:

- 形态:`settings-2` 图标 + 短词 `synced` / `not synced`。桌面与移动**同一形态**,删除 `Platform.isMobile` 分叉。
- **不用纯图标**:tooltip 需要悬停,而手机没有悬停——当初为省一行而选图标的那个平台恰恰看不到解释。
- **不用拨杆字形**(`toggle-right`/`toggle-left`):拨杆造型承诺"可以拨",而它只读。
- 短词比现状的 `on/off synced ✓` 短一半:分区头已经写了 `CORE PLUGINS`,"on/off" 是重复的。
- 点击 = `openSettingsAt(carrierRef)`,跳到 settings panel 对应卡片。**没有任何写入路径**;`setItemSyncEnabled` 的唯一入口是那张卡片顶部的开关。
- tooltip:同步中 `Which plugins are on is shared with your other devices — opens Settings`;未同步 `Which plugins are on stays on this device — opens Settings`。

### 6.4 settings panel · Obsidian 分页

3 张卡片 → **5 张**,新增 `Core plugins` / `Community plugins`。

- 卡头:名称 + 文件名 + 条数 + 徽标 + 顶部开关(= `synced`,这份名单文件同不同步)。
- 徽标分两类,颜色分开:舰队事实 `N device-scoped`;本机事实 `N left to me`。
- 抽屉:分区标题 `Which devices turn each plugin on`,其下每个元素一行,行形状同 §6.1。
- Appearance 卡片的 snippets 成员行(`SettingTab.ts:1815-1860`)是这套行的既有先例,两者必须走同一个渲染函数。

### 6.5 settings panel · 插件卡片

`Enabled on` 单行四档循环 → `Default enabled on` 一行两段,与 Sync Center 同名同值同数据。

三种情形(mockup ⑪ 已画全):

| 规则 | 本机段 |
|---|---|
| `Desktop only` 等类规则 | 只有一句 `Follows the default`,**不显示本机状态**——状态由同步决定,显示一个可改的本机值会撒谎 |
| `All devices` 且这台已例外 | 紫色 `On here` / `Off here`,可改 |
| `Each device decides` | 右段直接就是本机状态(无"跟随"可选,因为没有共享答案可跟随) |

**切换到例外的那一刻保持现状**:写入本机例外表的初值 = 该项此刻的真实状态。

### 6.6 单一生产者

三个入口——名单卡片的元素行、插件卡片的 `Default enabled on`、Sync Center 行——写的是同一份数据。约束:

- 规则:**一个写入函数、一个读取函数**,三个入口都经过它。
- 本机例外:同上,另一对。
- 派生键 `perElementKeyFor`:唯一生产者(§3.3)。

---

## 7. 字形与文案登记

本次涉及的字形,连带必须做的清理:

| 字形 | 之前的含义 | 之后 | 动作 |
|---|---|---|---|
| `power` | fate chip 的 `"stays off"`(`fateChipIcons.ts:13`)+ `runsOn` 的 `Always on here` | 本机例外 = 这台开着 | **必须**把 `"stays off"` 重指向 `power-off`,否则一形两义 |
| `power-off` | `runsOn` 的 `Never on here` | 本机例外 = 这台关着 | 两个 `force` 档删除后腾出 |
| `circle-slash` | 折叠组"这台没同步"的状态字形(`foldIcons.ts`) | 本机例外 = 这台不同步这一项 | 沿用,含义一致 |
| `settings-2` | "通往 Settings"(`SyncCenterView.ts:1136/1226/1553`) | `MORE` 行与名单芯片 | 沿用 |
| `sliders-horizontal` | fate chip 的 `your rule` | 不变 | **不得**挪作他用 |
| `airplay` | `sharingIcon(this-device)` | 本机跟随态**不用图标** | 见 §6.1 |
| `toggle-right` / `toggle-left` | 移动端名单芯片 | 退役 | §6.3 |
| `cloud-*` / `refresh-cw` | push/pull / 刷新按钮 | 不变 | 不得借用 |

文案词汇表(UI 只用这三个说法指代设备):`this device` / `your other devices` / `the store`。

**折叠组的措辞不改**:`N items not synced on this device`(`panelModel.ts:154`)。那个桶同时装着"共享的设备类规则把这台排除了"(`groupExcludedHere`)和"这台自己退出了"(`optedOutHere`)两种原因,中性句是唯一诚实的写法;原因由行内的 state 文案区分,今天已经如此。

---

## 8. 明确不做

- 不改 `store.lock.json` 的版本或形状。
- 不动 per-key 字段规则(`rules` / `FieldRule`)与加密。
- 不动 companion 文件夹机制。
- 不为 `Each device decides` 增加"记住每台设备各自选了什么"的舰队级台账——那正是本次要拆掉的东西。
- 不改 `deviceOptOutGroups` 的键(仍是分组名);它工作正常,改键是无收益的迁移风险。

---

## 9. 验收条款

功能:

1. 迁移后,三份名单文件的本地内容**逐字节不变**(§4)。
2. 迁移后,`data.json` 中不存在 `runsOn`、`elements`、`thisDeviceItems`、`bratIndex`、`enabled`(条目级)。
3. 一台设备把某插件设为 `Off here`,pull 一次之后该设置**仍在**(C-#52 的回归断言)。
4. 舰队规则改为 `Desktop only` 后,手机上该插件被掩掉,而**已有的本机例外优先于规则**(§5 优先级 1 高于 3)。
5. 名单芯片没有任何写入路径:点击只跳转。
6. `Item.synced` 在整个 Sync Center 里没有写入路径:全仓库搜索 `setItemSyncEnabled` 的调用方,只能出现在 settings panel 的卡片开关处。

写进验收的三条教训(前两个分支各付过一次代价):

6. **by-construction 只挡 mint,不挡 match**。让坏值无法构造,不能阻止两处比较时用错;任何"从构造上关死"之后,必须单独扫一遍比较点。
7. **一个派生键只能有一个生产者**(§3.3 的 `perElementKeyFor`)。
8. **测试要 producer-vs-producer**:断言两个生产者相等,而不是各自对着手写字面量。本仓库两次回归都是被"对字面量"的测试放过去的。

---

## 10. 开放项

- Community plugins 卡片抽屉是 73 行——是否加搜索框,或按"有规则的 / 其余"分组折叠。Core plugins 31 行、snippets 6 行不需要。
- `MORE` 标签是否顺势改成 `RULES`("More" 是位置词,"Rules" 是内容词)。不改也成立。
