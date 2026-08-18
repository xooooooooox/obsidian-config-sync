# Settings 面板:`SETTINGS SYNC` 与每个键补齐两层模型 — design

Date: 2026-08-16 · Scope: Step 1(settings panel 卡片)· Status: 已定稿(§11)·
Mock: https://claude.ai/code/artifact/154ad838-54b6-43e8-8a1c-7106dcfcf559 ·
起因: [issue #2](https://github.com/xooooooooox/obsidian-config-sync/issues/2) 复审 + 卡片 UI 反馈

2.23.0 的「启用范围两层重构」(`2026-08-12-enablement-two-layers-design.md`)确立了两层模型:
**舰队级**(共享默认,data.json,会传播)+ **本机级**(这台要不要例外,localStorage,不传播)。
那一轮把它落到了 `ENABLED ON`(两种粒度)与 Sync Center 的 `Settings sync` 行;**settings panel
卡片的整文件行与每键行没有进入范围**。本轮补齐,并顺带修掉那一行现存的一处失效显示。

---

## §1 病灶

1. **同一张卡上两种待遇**。`ENABLED ON` 是完整两段式(fleet + 本机例外),`SETTINGS FILE` 只有一个
   fleet 控件,第 4 轨空着(`SettingTab.ts:1385-1529`)。同一份数据 `config-sync-device-optouts`
   在 Sync Center 有入口(`SyncCenterView.ts:3033-3115`),在这里没有。

2. **一个名字两种叫法**。settings panel 叫 `Settings file`(`SettingTab.ts:1400`),Sync Center 叫
   `Settings sync`(`SyncCenterView.ts:3056`)。

3. **fields 模式下那一格在陈述一个失效的值**。`compileSingleFile`(`registry.ts:461-469`)只在
   `mode === "plain"` 分支读 `fileRule`;fields 模式下 group 以 `devices: "all"` 出去,`fileRule`
   根本不编译(`types.ts:147-149`、`manifest.ts` 亦如此规定)。而 `pruneSettingsFile`
   (`registry.ts:114-119`)只丢弃恰好 `{everywhere,false}` 的 `fileRule`,于是一个先设成
   `Desktop only`、之后才加 per-key 规则的项,`fileRule.sharing` 会留在 data.json 里;
   `renderSettingsFilePathRow` 照旧读它(`:1490`)并画出 dim 的 `monitor`。
   **显示的是一个早已不生效的答案。**
   附带的可供性问题:禁用态只有「调暗 + ⇕ opacity 归 0」(`:1104-1107`),唯一解释在 `aria-label`
   (`PER_KEY_RULES_ACTIVE_HINT`,`:283`)里 — 手机没有悬停,看不到。

4. **每个键没有本机层**。`FieldRule.sharing` 的四挡里有 `this-device`,但那是**舰队级**的答案
   (「每台设备各留各的」);「这台机器上例外」在键这一级没有任何表达位置。issue #2 的第二半
   (某个键要在自己的桌面+手机间共享,但不落到别的 vault 上)正卡在这里。

**已经备好的东西**:`fileEnablementRowModel` / `fileLocalSegment`(`enablementRow.ts:114,122`)
早就存在,后者的注释写明它就是「fields-mode fallback:fleet 无合法值可显示、但仍有真实的本机
opt-out 要画」;`RowSegment.icon` 可空也注明是「for the per-key fallback fleet cell」。
**唯一的消费者是 Sync Center。** 所以这不是实现遗漏,是当年清单上没有 settings panel 这一侧。

---

## §2 模型

粒度 × 两层,补齐后:

| 粒度 | 舰队级(data.json,会传播) | 本机级(localStorage,不传播) |
|---|---|---|
| **整个文件**<br>行标签 `SETTINGS SYNC` | `settingsFile.fileRule.sharing`(`FileSharing`,三挡) | `config-sync-device-optouts` · 右段 `Not synced here` **(本轮补入口)** |
| **每个键**<br>规则行 | `settingsFile.rules[<key>].sharing`(`Sharing`,四挡) | `config-sync-device-fields`(新)· 右段 `Not synced here` **(本轮新增)** |
| **名单里的一项** | 载体的 `settingsFile.perElement[<list>]` | `config-sync-device-elements`(已有) |

**不在本轮**:键下的**数组元素行**(`renderPerElementRow`,`SettingTab.ts:1772`)不加本机层。
理由与当年拒绝给 snippet 行加本机段的理由相同(`SettingTab.ts:1250-1255`):`main.ts` 的
`enablementDecisions` 只走两份插件名单,`perElement.ts` 只读规则 — 给它一个本机选择,等于提供
一个没有任何运行路径会兑现的选项。要做需要先改 apply 路径,是另一轮的事。

**同一条理由向上收窄一级**:**开了 Per-item device rules 的那条规则行本身也不加本机层**。这类键
从头到尾由 per-element 机制独占治理 —— `excludingPerElement`(`modes.ts:112`)在 capture / apply /
比较三条路径上都先把 perElement 键从任何 pattern 集合里剔掉,例外集合也不例外。所以给这一行画本机
段,就是把上一段刚拒绝掉的东西原样搬到了它的父行上:菜单两个选项产出同一份字节。
判定由**唯一生产者** `ruleRowHasLocalLayer(row)`(`itemCard.ts`,`= !row.perElementEnabled`)给出,
`renderRuleRow` 据此决定画不画;已存的例外条目**不清除** —— 关掉 Per-item 后那个控件重新有意义。

---

## §3 数据结构

### 3.1 新键 `config-sync-device-fields`

形态照抄 `deviceElements.ts`:两级表、镜像 data.json 中对应规则的形状、容错解析、不可读即空、
**绝不回写**。

```jsonc
// localStorage["config-sync-device-fields"] —— 存为 JSON 字符串
{
  "core/graph":       { "colorGroups": "not-synced" },
  "obsidian/appearance": { "accentColor": "not-synced" }
}
```

- 外层键是 `ItemRef`(`types.ts:41`)—— 与 lock、baselines、opt-out 名单同一套键空间。
  (`deviceElements.ts` 的外层键是 list id,因为那三份名单里有两份没有对应的 JSON 字段;这里没有
  这个问题,规则本来就按 item 索引。)
- 内层键是**规则的 pattern 原文**,与 `settingsFile.rules` 的键一致 —— 不是展开后的键名。
  一条 `plugins.*` 的规则被例外掉,例外的就是这条规则覆盖的全部键。
- 值只有一个状态 `"not-synced"`。没有 `on`/`off` 对:这里的问题是「同不同步」,不是「开不开」。
  无条目 = 跟随舰队规则。
- 解析:任何无法识别的形状按「本设备无例外」读,永不抛错、永不改盘(与
  `parseDeviceElements`、`deviceOptOutGroups` 同一纪律)。

**schema 先行**:`schema/local-storage.schema.json` 先加该键(现有六键:`-device-elements` /
`-device-optouts` / `-baselines` / `-device-id` / `-coldstart-dismissed` / `-passphrase`),
`tests/schemaFiles.test.ts` 是它与代码之间的闸门。

**不进 data.json**(Invariant I.1)。本表天然按设备隔离,无需 `deviceId` 作键 —— 与
`config-sync-device-optouts` 同理:一份「只属于这台」的文档里没有别的设备。

### 3.2 fields 模式下的 `fileRule`

**保留在 data.json,但不参与任何显示与编译**(定稿,§11-2)。

- 编译:维持现状 —— `compileSingleFile` 只在 plain 分支读它(`registry.ts:466`)。本条只是把既有
  事实写死为规约。
- 显示:`renderSettingsFilePathRow` 在 `hasKeyRules(item)` 为真时**不再读 `fileRule`**,改画 §5.2
  的形态。
- 保留而非清除的理由:删光 per-key 规则后能恢复到原来的整文件答案;清除则是一次不可逆的静默丢
  值,而 `pruneSettingsFile` 的既有契约(「一次往返后 data.json 逐字节不变」)也会被破坏。

---

## §4 语义:本机例外如何参与 capture / apply / 比较

舰队级 `this-device` 之所以安全,是因为**全体设备一致同意**该键不进 store。本机例外没有这个共识
—— 它只存在于一台设备上,而 store 是共享的。因此三条必须写死:

1. **capture 保留 store 中该键的既有值** —— 既不写入本机值,也不删除。
   反例(必须被杜绝):设备 B 把 `colorGroups` 设为本机例外 → B 的 capture 把该键从 store 副本
   strip 掉 → B 的 store 丢了这个键 → B push、A pull → **A 的值被 B 的局部决定删掉了**。
   原语已有:`captureTransform` 本就接收 `priorStoreContent`(`ConfigSyncCore.ts:814`、
   `modes.ts:280`);`perElement.ts:59` 读 prior store value 以保留其它设备贡献的元素,是同构做法。
   store 里还没有该键时(首次 capture),结果就是该键不出现 —— 保留「既有值」在这里等于保留「没有」。

   **「store 中该键的既有值」指两个文件,不是一个。** fields 模式下一项的 store 副本是
   **base + 本设备类的 `__scopes__` sidecar** 两份:`captureTransform` 的 class partition
   (`modes.ts:312-325`)在其它一切规则之前就把 own-class 键从 base 挪进了 sidecar,所以一个
   `Desktop only` 键的 store 值只存在于 sidecar 里。因此本条对 **base 与 sidecar 一体适用**:
   - base 里的例外键 → 取 `priorStoreContent` 中的既有值,无则不出现;
   - sidecar 里的例外键 → 取 `priorOwnScopeContent` 中的既有值(密文即密文,逐字节),无则不出现。
   **sidecar 同样是共享文件** —— 它由该 class 的**每一台**设备共写共读,所以往 sidecar 里发布本机值
   与往 base 里发布本机值是同一次跨设备覆盖,只是换了个文件:设备 B 例外掉某个 `Desktop only` 键、
   因任何无关原因 capture 并 push,设备 A pull 后 A 的值就没了,而比较两侧都 mask 掉该键,用户不会
   收到任何警告。只改写 base 而漏掉 sidecar,等于把本条的保护做了一半。
   (原措辞只说「保留 store 中该键的既有值」,并只给出了改写 base 对象的落地指引 —— sidecar 这条
   路径当年没有被考虑到。这是 spec 的缺口,不只是代码的缺口。)

   **例外只能替 base 有资格持有的键说话。** 舰队规则判为 `this-device`(strip)或绑定到某个设备类的
   键,base 本来就不许持有 —— `ConfigSyncCore.ts` 的 `baseHasStaleLocalKeys` /
   `baseHasStaleClassKeys` 存在的意义就是把它们清出去。若例外从一份陈旧 base 里把这类键再读回来写
   进输出,结果是把一个设备局部值永久钉死在共享 store 里,而那两个守卫会在**每一次** capture 强制
   重写且永远不成功。所以落地时须先从例外集合里减去 `strip` 与两个 class 的 pattern;class 键的例外
   由上面 sidecar 那一条负责,那才是它的值真正所在。

2. **apply 跳过该键,保留本机值** —— 与今天 `this-device` 的 apply 语义一致
   (`perElement.ts:69` 的同构:store 侧过滤 + 本机侧保留)。

3. **比较两侧对称 mask 该键** —— `contentUnchanged` 必须在 local 与 store 两侧同时忽略它,否则该
   项永远读作 to-capture。先例:`perElementArrayUnchanged`(`perElement.ts:80`)。

**与 `withContractLocals` 的关系**:既有的「本地规则 ∪ store 契约规则」并集机制
(`ConfigSyncCore.ts:92,1412`、`status.ts:34`)解决的是同类问题 —— 未 adopt 的设备不得把设备局部
值发出去 —— 但它作用于**共享契约**里的 this-device 键。本表不在契约里,契约也不该知道它(它是
一台设备的私事),所以上述三条是本表自己的规约,不复用那条并集路径。

**加密**:本机例外**不改变加密**。`renderRuleRow` 现有的 `encrypted: v.kind === "this-device" ?
false : r.encrypted`(`SettingTab.ts:1698`)是舰队级规则的联动(值不出设备,自然无从加密);本机
例外不动 store 里的值,该键的密文原样保留。

---

## §5 UI

### 5.1 行形态与改名(定稿)

`SETTINGS FILE` → `SETTINGS SYNC`,与 Sync Center 同名。行形态定稿为 **A′**(mock §02):

```
SETTINGS SYNC        [aux 空] 🔒 [sharing ⇕] │ THIS DEVICE ↳
note-composer.json ..................................... 👁
```

- **第 1 行**是严格两段式,与 `ENABLED ON` 同构:`label | slots(aux/lock/device) | 分隔线 | 本机段`。
- **第 2 行不带标签**。`FILE` 是冗余的 —— 那一行只可能是这个文件的名字,mono 字体已经把它标识
  出来;而把标签写成 `SETTINGS SYNC` 又会让文件名挂在「同步」之下。
- **eye 归位**。它作用于文件,今天却在规则行的 aux 槽里(`SettingTab.ts:1406`)。移到文件名同行
  后,aux 列只剩一个含义 —— 数组规则行的 per-element 图标(`:1735`、`:2558`,aux 的唯二其它使用
  者),列语义更纯。

实现约束(三条,均为硬性):

1. eye 放进 `.config-sync-card-pathhost`(已是 flex,`styles.css:1452`),**紧贴文件名右侧**(一个
   `gap`,不是 `margin-left: auto`)。文件名保住
   `.config-sync-card-pathline { grid-column: 1 / -1 }`(`:1388`)的整行跨列 —— 那条规则的存在
   理由是「plugin-length paths never wrap」,省略号截断照旧。

   **本条曾写错并已落地一版,2026-08-17 验收时修正**:初稿把 `margin-left: auto` 写成硬性约束。
   但那一行跨的是全部四轨,`auto` 因此把 eye 顶到**整张卡片的右缘**,凭空造出一列"操作列" ——
   直接违反 `styles.css:1373-1374` 的既有约定「Nothing anchors to the drawer's right edge …
   there is no action column」。**是 spec 的错,不只是实现的错。**
2. **不得**改用 `.config-sync-scrow-end`(`grid-column: 4`,`:1384`):它会与 `1/-1` 的跨列重叠。
3. **编辑态必须继续渲染 eye**。今天它在编辑态照常渲染,理由是槽位列不闪(`:1402-1404`);A′ 后它
   排在 `TextComponent` 与 `Reset to default` 之后,同一条不变式照旧成立。

顺带记录被否掉的「单行塞四轨」方案:scrow 是 `170px 108px 1px 1fr`(`styles.css:1375`),slots 固
定 `24px 24px 44px`(`:1379`)—— 第 4 轨没有空间可挤,只能压 identity 轨。

### 5.2 fields 模式下的 fleet 格

不再画 sharing 图标 —— 它没有值可画。形态与 Sync Center 的既有 fallback 一致
(`SyncCenterView.ts:3055-3075`):

- fleet 格 = dim `settings-2`,无 ⇕(是跳转,不是菜单);
- 一句就地说明代替悬停 tooltip(手机没有悬停);
- 点击 = 滚动并高亮**本卡**的 per-key 规则区(Sync Center 那边是 `openSettingsAt`,在本卡上
  「跳到 Settings」无意义);
- **lock 格同样不读 `fileRule`**。fields 模式下整文件加密无从谈起(加密是逐键的),按 §3.2 该格
  留空 —— 今天 `renderLockToggle` 在 `disabled && !encrypted` 时本就不画东西(`:1522-1523`),
  变化只在于不再因残留的 `fileRule.encrypted: true` 画出一把已失效的锁。
- **本机例外列照常可用** —— 它是另一份数据,与 fleet 无关。这正是 `fileLocalSegment` 存在的理由。

### 5.3 `SETTINGS SYNC` 的本机例外列

复用既有 producer,**不新增数据、不新增字符串**:

- 模型 `fileEnablementRowModel({ sharing, optedOut })`(`enablementRow.ts:114`,名字不变 —— 它的
  fleet 半边确实是文件专属的 `FileSharing`);
- fields 模式下只取本机半边(`fileLocalSegment`,`:122`;§5.4 起改名 `optOutLocalSegment`);
- 菜单 `buildFileLocalMenu`(`:169`;§5.4 起改名 `buildOptOutLocalMenu`)—— `Follows the default` /
  `Not synced here`;
- 写入 `host.setDeviceOptOut(name, …)`,与 Sync Center 同一个写入函数(§6.6「一份数据一个写入口」)。

### 5.4 每个键的本机例外列 + 第四挡改名

- 规则行变两段式:`键名 | fleet picker | 分隔线 | 本机段`。`this device` 提为**列头**(规则区的
  zone header 那一行),成员行不重复 eyebrow —— 与 `renderCarrierElements`(`:1331-1334`)既有做法
  一致。
- fleet 段改用 `ruleIcon` / `ruleLabel`(`enablementRow.ts:33,23`):第四挡由
  `airplay`/`This device` 变为 `users`/`Each device decides`。**存储值不变**(`this-device`),
  只改展示 —— `enablementRules.ts:6-8` 已写明 `Each device decides` 复用的就是这个值。
- 本机段的段模型与菜单**与整文件那一层同形**(两个状态:跟随 / 不在本设备同步)。因此:
  - `fileLocalSegment` 改名为 `optOutLocalSegment`,两处共用;
  - `buildFileLocalMenu` 改名为 `buildOptOutLocalMenu`,两处共用。
  两个菜单的标题、图标、勾选语义逐字相同,保留两份就是两处会漂移的地方 —— 与「一个字符串一个
  生产者」(§6.6)相冲。改名同时更新 Sync Center 的调用点与既有测试。

### 5.5 `airplay` 的去留:收窄,不删除

改动后 `airplay` 仍有一个正当使用者:**键下的数组元素行**(`renderPerElementRow`),它按 §2 不加
本机层,因而仍属于 `DESIGN.md:188` 描述的「no local layer to speak for」。所以那一条不是失效,
而是**适用范围收窄** —— 从「plain field/file rule 的 picker」收窄为「per-element array rule 的
picker」。`DESIGN.md:211`(fleet 段永不用 `airplay`)不变,并因本轮而多覆盖了一行。

`sharingIcon`/`sharingLabel` 的 this-device 分支(`itemCard.ts:525`)与
`tests/itemCard.test.ts:660` 的字形断言随之保留。

---

## §6 字形与文案登记

本轮**不新增任何字形**,全部来自既有登记:

| 位置 | 字形 | 文案 |
|---|---|---|
| per-key fleet 段第四挡 | `users` | `Each device decides` |
| 本机段 · 跟随 | `corner-down-right` | tooltip `This device: follows the default` |
| 本机段 · 例外 | `circle-slash` | tooltip `This device: not synced here` |
| fields 模式 fleet 格 | `settings-2` | tooltip `Per-key rules decide — jump to them` |
| 本机段列头 | — | `this device`(`THIS_DEVICE_EYEBROW`) |

**这句话只做 tooltip,不再有可见副本(2026-08-17 验收定稿,推翻初稿)**。初稿要求它是常驻可见
文字,理由是「手机没有悬停」。真机验收后改判:那一格的真实阅读路径是**先点 eye 看文件内容**,
而一旦加了键,`KEY RULES` 分节头就会出现在它正下方 —— 那个标题离得更近、常驻,且本来就在回答
同一个问题。再写一行可见文字,是把版面已经说过一遍的话再说一遍。

因此 `.config-sync-card-keyrulesnote` 及其 DOM 一并删除;`PER_KEY_RULES_JUMP_TEXT` 保留,作为
dim `settings-2` 的 `aria-label`(去掉了箭头 `↓` —— 它原本指的是下方的规则区,现在没有可见文字
承载它)。

~~**该格同时携带一个不可见的 `⇕` 占位**(`is-jump`):它不开菜单,所以那个 ⇕ 在任何状态下都不显形~~

**2026-08-17 作废**:两列合一之后这一格**确实开菜单**了(菜单第一段只有一条「跳到 per-key 规则」),所以 ⇕ 恢复正常显形,`is-jump` 及其占位技巧一并删除。以下段落保留为当时的推理记录:
(含行悬停 —— 显出来就是在暗示一个不存在的下拉);它存在的唯一理由是让字形盒子与
`renderSharingPicker` 等宽,否则居中的 device 槽会把图标挤出列,正是初版落地后 `ENABLED ON` 与
`SETTINGS SYNC` 两行错开 12px 的成因。**不可**改用 `config-sync-dim` 达成:那个类带
`pointer-events: none`,而这一格是点击目标。

两条既有文案的归属随之厘清:

- `PER_KEY_RULES_ACTIVE_HINT`(「Per-key rules are active — remove them to control the whole file
  again」,`SettingTab.ts:283`)**退役**。它的两个宿主格(sharing 与 lock)在 §5.2 后都不再画一个
  「被禁用的控件」,也就没有需要解释的禁用态 —— 留着它就是留一句描述已不存在的界面的话。
- `FILE_SHARING_MENU_UNAVAILABLE_TEXT`(「Per-key rules decide — opens Settings」,
  `itemCard.ts:517`)**保持不变,仍是 Sync Center 专属**:它那一句里的「opens Settings」在那边
  确实成立,在 settings panel 上则不成立(已经在 Settings 里了)。两句共享前半段「Per-key rules
  decide」是刻意的 —— 同一个事实,两个位置,同一个说法开头。

---

## §7 迁移与兼容

- **无数据迁移**。新键从空开始;`fileRule` 保留原样;`this-device` 存储值不变。
- **降级安全**。旧版本读不到新 localStorage 键 —— 那台设备就是「没有本机例外」,行为与今天完全
  一致。本机层从不进入 store,也不会传播给任何人。
- **schemaVersion 不变**(data.json 形状未动)。`store.lock.json` 不受影响。

---

## §8 测试

纯核(`tests/`,内存 FileIO + fake host):

1. **防数据删除的核心断言** —— 某键设本机例外后 capture,store 中该键的值与 capture 前逐字节
   相同;store 中原本没有该键时,capture 后仍然没有(不凭空写入本机值)。
   **这一条必须按 sharing 的每一挡各钉一次**,只用 `everywhere`/未加密/无 sidecar 一种形状是不够
   的 —— §4.1 的两个文件里,C 级缺陷正是出在没被覆盖的那个:
   - `per-class` + 已有 sidecar → sidecar 中该键逐字节不变;sidecar 原本没有该键 → capture 后
     sidecar 里仍然没有;两次 capture 的 base 与 sidecar 都逐字节可复现;
   - `everywhere` + `encrypted` → store 中的密文信封逐字节不变(不重新加密、不丢键);
   - 舰队规则为 `this-device` 且 base 里残留着该键 → capture 后 base 里没有它,
     且 `baseHasStaleLocalKeys` 读作 false(store 收敛,不是每次 capture 都重写);
     class 键的同类残留同理。
1b. **收窄断言**:perElement 键上的例外对 capture 无影响(带例外与不带例外产出同一份字节),
   且 `ruleRowHasLocalLayer` 对 `perElementEnabled` 的行返回 false —— §2 收窄的两半各一条。
2. apply 后本机值不变;该键的舰队规则对其它设备照常生效。
3. `contentUnchanged` 在两侧该键值不同时仍返回 true(不产生假 to-capture)。
4. 例外表不可读(非 JSON / 非对象 / 值不是合法状态)时行为等同无例外,且**不回写**。
5. fields 模式下 `fileRule` 不影响编译结果(`devices` 恒为 `all`,`group.fileRule` 不存在)——
   把 §3.2 的规约钉成断言。
6. `optOutLocalSegment` / `buildOptOutLocalMenu` 两处调用点拿到的是同一份段与菜单(沿用
   `tests/enablementRow.test.ts:93` 的同一生产者断言写法)。
7. `RULE_OPTIONS.map(ruleIcon)` 不含 `airplay`(`tests/enablementRow.test.ts:31`,已有)+
   `FIELD_SHARING_OPTIONS` 在**规则行**上走 `ruleIcon`、在**数组元素行**上仍走 `sharingIcon`
   —— §5.5 的收窄需要一条断言看住。

---

## §9 门槛与验证

- `npm run build` / `npm test` / `npm run lint`(0 error、≤58 warning,零新增)/
  `./scripts/check-no-hardcoded-color.sh`。
- **Smoke before deploy**:UI 改动从不是「纯样式」。在 `dev/vault` 里逐个点击本次 diff 触及的每
  一个控件。清单:
  1. `SETTINGS SYNC` 的 fleet picker、lock、本机菜单;
  2. 文件名行的 eye(A′ 的新位置)与点击文件名进入路径编辑 —— **编辑态里 eye 必须仍在**
     (§5.1 约束 3),并确认 `Reset to default` 与它同行不打架;
  3. fields 模式下的跳转格:点击后确实滚动并高亮本卡的规则区;同一状态下 lock 格必须**空白**,
     即使该项 data.json 里残留着 `fileRule.encrypted: true`(§5.2);
  4. 每条规则行的 fleet picker 与本机菜单;
  5. 删光最后一条规则退回 plain 后,整文件的 sharing 与 lock 复原,且 sharing 显示的是当初保留
     下来的值(§11-2 的已知代价,此处正是它可见的那一刻)。

  移动端(`body.is-phone`)另跑一遍第 3 项:就地说明必须是可见文字,不依赖悬停。
  **绝不在真实 vault 里测。**
- 手工判否条件:设了本机例外的键,Capture 一次后 Sync Center 不得出现该项的 to-capture;
  store 里该键的值不得变化。

---

## §10 不在本轮

- **Step 2 · remote pull/push**:段 C 的结构性欠债(整份交换无勾选、冲突选择无记忆、Push 侧无决
  策点、`Remote` 是无身份端点)。候选方案 `Remote.excludeItems: ItemRef[]`。issue #2 的诉求已由
  §5.4 在接收端解决,段 C 的改造独立立项。
- **数组元素行的本机层**:见 §2,需要先改 apply 路径。
- **三个已诊断未修的缺陷**(problem-report 门,待单独指示):
  - A. `not-captured` 成员使 Files 行整行不渲染,fate 落到兜底句 `Captures files`
    (`status.ts:67-68` → `SyncCenterView.ts:968,986-988` → `fateModel.ts:213` → `:2556`);
    与 `2026-08-09-c-livetest-batch13-empty-verbs.md` §1 的定稿(capture 侧对称退化)相反。
  - B. 展开卡片后行上的方向图标隐藏(`SyncCenterView.ts:2417-2424`,是设计),与 A 叠加后
    「展开反而信息更少」。
  - C. §1 病灶 3 的显示失效值 —— 本轮 §3.2 + §5.2 顺带修掉。

---

## §11 定稿记录(2026-08-16)

1. **行形态 → A′**(§5.1):规则行两段式;文件行去掉 `FILE` 标签,eye 随文件名同行右推。
   被否:「拆两行且文件行带 `FILE` 标签」(标签冗余)、「单行塞四轨」(scrow 无轨可挤)。
2. **fields 模式下的 `fileRule` → 保留但永不显示**(§3.2)。理由:删光 per-key 规则后能恢复原值;
   清除是一次不可逆的静默丢值,且会破坏 `pruneSettingsFile` 的往返契约。
   已知代价并接受:隔了很久之后删光规则时,当初的整文件答案会「不请自来」地恢复显示 —— 但那是一
   个明确的手动动作,恢复的值当场就显示在那一格上,不是暗地里生效。
3. **§4 三条语义**照本 spec 措辞定稿。第 1 条「capture 保留 store 中该键的既有值」是防数据删除的
   核心断言,措辞即验收标准(§8 断言 1)。

下一步:writing-plans 产出实施计划,顺序 `schema → DESIGN.md → 代码 → 文档`。
