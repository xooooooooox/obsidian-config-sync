# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)

[English](README.md) · **中文**

在多台设备和多个 vault 之间，按需、选择性地同步 Obsidian 设置——快捷键、CSS 代码片段、主题、插件配置。数据默认借助你现有的笔记同步工具(note sync)（remotely-save、Obsidian Sync、iCloud……）传输，也可以使用 config-sync 自带的 git / vault 远程通道。任何设置在没有在 Sync Center 中明确执行 **Apply**(应用) 之前，绝不会落到设备上。

![Settings picker](docs/assets/settings-picker.png)

## 功能特性

- **精确挑选要同步的内容** —— Obsidian 选项、核心插件与社区插件设置、代码片段、主题、vault 根目录下的点文件(dotfiles)；可按条目、按设备类别（全部 / 桌面端 / 移动端）分别控制。
- **凭证安全** —— 按条目设置的 sync mode（同步模式）会在任何内容进入 store(配置存储) 之前剥离或加密敏感键；每台设备在每次 Apply 后都会保留自己本地填入的值。
- **明确、可回退的 Apply** —— 挑选条目，直接落地（没有确认弹窗）；每个被改动的文件都会被备份，**Revert last apply**（撤销上次应用）可以将其还原。
- **随时可见的状态感知** —— 功能区状态点会亮起橙色（有待 capture 的条目）或蓝色（store/远程有更新）；打开 **Sync Center** 查看详情：每个条目都打上徽标（`✓ in sync`、`↑ changed on this device (likely)`、`↓ store is newer (likely)`、`≠ differs`、`— not captured yet`），并配有实时的 `↑`/`↓` 变更数量徽标，远程仓库会被自动检查。
- **感知可用性** —— 落后版本、被禁用或未安装的插件会各自出现在独立的折叠分区中，配合插件安装/更新引擎，让 apply 在同一步里也能顺带更新、启用或安装某个社区插件。
- **感知远程状态** —— Sync Center 的 Remotes 区块会自动检查 git 或 vault 远程仓库是否在你的本地 store 之后被捕获过；展开某个远程可预览 Pull/Push 的内容。
- **移动端友好** —— capture、apply 以及 Sync Center 在手机上均可正常工作；store 本身就是普通的 vault 内容，因此任何笔记同步工具都能携带它。

## 安装

在 Obsidian 内：**Settings → Community plugins → Browse**，搜索 **Config Sync**，安装并启用。

体验测试版：通过 [BRAT](https://github.com/TfTHacker/obsidian42-brat)，添加 `xooooooooox/obsidian-config-sync`。

## 快速开始

1. **Settings → Config Sync** —— 勾选你想同步的内容（Obsidian / Core plugins / Community plugins 三个标签页）。
2. 从功能区菜单打开 **Sync**（或使用 **Sync: open the sync panel** 命令）以打开（若已打开则聚焦）Sync Center，勾选要 capture 的条目，点击 **↑ Capture N items**。
3. 在另一台设备上，等你的笔记同步工具(note sync)把数据文件夹送达之后：打开 **Sync**，勾选要 apply 的条目，点击 **↓ Apply N items**。

## 工作原理

两个层面，彼此分离。

**本地层面** —— 本设备的实时配置 ↔ store：

- **Capture**（捕获） 把 `<数据文件夹>/config-sync.json` 中定义的条目复制进 `<数据文件夹>/store/`，按每个条目的 sync mode 处理（剥离或加密字段，或加密整个文件），跳过操作系统垃圾文件，并把源插件版本号（Obsidian/核心条目则是 Obsidian 应用版本号）记录到 `store.lock.json` 中。只有发生变化的文件才会被重写；Sync Center 的 Capture 按钮只会 capture 你勾选的条目。
- **Apply**（应用） 挑选条目，把它们落地到本设备的配置目录（不论其名称是什么）——没有确认弹窗，勾选后按下 Apply 即直接执行。对于在本设备上落后版本、被禁用或未安装的社区插件，Apply 还能先执行更新、启用或安装（见下文）。被 Strip 或加密的内容按条目的 sync mode 处理；被 Strip 的键会保留本设备的本地值。单槽位备份覆盖每一个被改动的文件；**Revert last apply** 可将其还原。
- **Sync Center** 按条目比较实时配置与 store，给出尽力而为的方向提示（文件时间对比最近一次 capture），并自动检查远程仓库的新鲜度。

### 可用性分区与安装引擎

除了主列表之外，Sync Center 还会按"在本设备上的实际状态"把社区/核心插件条目归入几个折叠的、需主动勾选才生效的分区——在你勾选分区内的条目之前，它们不会计入页头小圆点数字、侧边栏徽标、筛选按钮或页脚：

- **Outdated on this device**（本设备版本落后） —— 已启用的插件，但其本地安装版本落后于 store 捕获时的版本。
- **Disabled on this device**（本设备已禁用） —— 配置被追踪，但插件本身在本设备上处于关闭状态。
- **Not installed on this device**（本设备未安装） —— store 中有配置，但插件在本设备上根本没有安装。

这些分区里的每一行，除了常规的复选框之外还带有一个 **On apply**（应用时动作）选项——复选框决定这个条目的配置是否参与本次运行，On apply 选项决定配置落地之前插件状态要如何变化：

- 落后版本：`⤓ Update to latest`（默认）或 `Keep {version}`（保留当前版本）。
- 已禁用、无版本落差：`⏻ Enable`（默认）或 `Keep disabled`（保持禁用）。
- 已禁用且版本落后：`⤓ Update & enable`（默认）、`⏻ Enable`、或 `Keep disabled`。
- 未安装：`⤓ Install & enable`（默认）、`⤓ Install`、或 `Stage only`（仅预铺配置）。

安装与更新会从官方社区插件目录拉取该插件的最新 release。不在目录中的插件会被预铺（配置写入 store，等你以后手动安装即可），并附带相应提示。更新失败会保留原有配置不变（旧版本被认为不适合被盲目覆盖）；安装失败仍会预铺配置，因为一个尚未安装的插件本来就不会因此受损。

如果插件本地版本领先于 store 记录的版本，对应行不会出现在分区里，而是以一行安静的灰色元数据文字展示（再次 capture 即可刷新 store）。Obsidian 与核心插件条目的版本锚点是 Obsidian 应用版本本身而非某个插件版本——这类版本落差在两个方向上都只是提醒，不会触发任何安装/更新动作。

**传输层面** —— store 如何流转：

- **你的笔记同步工具（默认）**：store 本身就是普通的 vault 内容——remotely-save、Obsidian Sync、iCloud 或其他任何工具都能把它带到任何地方，包括移动端，零配置。
- **Pull / Push（桌面端，可选）**：config-sync 自带的传输通道，用于 git 仓库或本机上的另一个 vault，通过 Sync Center 的 Remotes 区块执行。Pull 会用远程内容覆盖本 vault 的 store（可重复执行——冷启动和日常使用是同一个操作）；Push 则把内容发送出去。git 传输方式会克隆到一个临时目录，绝不会触碰你 vault 自身的 git 仓库。

一切功能都挂在一个 **Config Sync** 功能区图标上：状态点在有待 capture 的条目时显示橙色，在 store 或远程有更新时显示蓝色。点击图标会打开一个菜单，包含 **Sync…**（标有 `↑`/`↓` 变更数量徽标）和 **Revert last apply**；Sync… 会打开（若已打开则聚焦）Sync Center，Capture/Apply/Pull/Push 都在其中完成。也可以在 **Settings → General** 中为 Sync 和 Revert 单独启用功能区图标，默认关闭。

Capture、Apply、Pull、Push 每次执行完毕都会在 Sync Center 顶部渲染一条结果条(result strip)——一段可折叠的摘要（变更/未变更数量，按需展开查看每个条目的详情），而不是弹窗对话框，这样就不会打断你继续勾选。**Revert last apply** 是唯一的例外，它仍然会打开一个报告弹窗，因为它是从 Sync Center 之外（功能区菜单或命令面板）发起的。

**Filter by name…**（按名称筛选）搜索框位于 Sync Center 的侧边栏，会在所有作用域（Obsidian、Core plugins、Community plugins、snippets、themes、dotfiles）中全局搜索；侧边栏会显示每个作用域的命中数量，有命中的分区会自动展开以仅显示命中项。

![Sync Center](docs/assets/sync-panel.png)

## 设置指南

- **General** —— PKM 模式（自动检测 IOTO vault）、数据文件夹位置、状态提示开关（同步菜单变更数量、自动检查远程仓库、定期本地检查）、功能区图标。
- **Obsidian / Core plugins / Community plugins** —— 勾选条目即可同步；每个分区的标题勾选框可一键全选/全不选；全局搜索框支持作用域筛选，覆盖 General、所有选择器标签页、Advanced 和 Remotes。在你勾选启用同步**之前**，插件就已经会扫描每个已安装插件是否包含敏感键，命中的条目会带上 `⚠ N keys` 徽标并排到所在分区的最前面。设备相关（device-specific）的条目（`sync`/`publish` 两个核心插件）会带有 `device-specific` 徽标，启用时会要求二次确认。**Workspaces**（已保存的工作区布局，对应 `workspaces.json`）是一个 Core 插件条目；易变的 `workspace.json`/`workspace-mobile.json` 不归入任何标签页的分区——它们会像其他无法识别的配置文件一样，出现在 Advanced → Discovered files 中。
- 每个已同步条目的行都带有一个箭头(chevron)，点击可展开：**Fields to protect**（仅当该条目的 mode 为 Fields 时显示）、只读的 **View data.json**（键名按规则状态着色，点击某个键即可直接为其添加 strip/encrypt 规则——用来覆盖内置敏感键检测可能遗漏的情况）、以及 **Advanced**（store path 覆盖输入框 + **↺ Reset this item to its default rule**）。
- **Advanced** —— **Custom rules**（完全由你自定义：vault 根目录文件、额外文件夹、sync mode）与 **Discovered files**（我们无法自动分类的配置文件；名称和路径由文件本身决定，可切换是否同步），两者的每一行都使用同一套展开区域。当有任意被管理的条目发生了自定义修改（path、fields 或 mode 偏离了默认值）时，页面顶部会出现一条摘要横幅，列出这些条目并提供 **↺ Reset all to defaults** 按钮。
- **Remotes**（桌面端） —— 添加一个 **git repository**（URL、分支、可选子文件夹）或 **another vault**（另一个 vault）：点击 **Browse…**，选择目标 vault 文件夹，其中的 store 会被自动识别。

## Store 目录结构

```
<data folder>/               # default "config-sync", configurable
├── config-sync.json         # group definitions (yours to edit)
├── store.lock.json          # capture metadata (machine-written)
└── store/
    ├── configdir/…          # mirror of {configDir}/… (device-independent)
    └── <dotless files>      # vault-root dotfiles, leading dot stripped
```

`config-sync.json` 示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/xooooooooox/obsidian-config-sync/main/schema/config-sync.schema.json",
  "version": 1,
  "groups": [
    { "name": "snippets", "path": "{configDir}/snippets", "type": "dir", "devices": "all" },
    { "name": "hotkeys", "path": "{configDir}/hotkeys.json", "type": "file", "devices": "all" },
    { "name": "vimrc", "path": ".obsidian.vimrc", "type": "file", "devices": "desktop" },
    { "name": "plugin-ioto-settings", "path": "{configDir}/plugins/ioto-settings/data.json",
      "type": "file", "devices": "all", "mode": "fields",
      "fields": [
        { "pattern": "*APIKey*", "action": "encrypt" },
        { "pattern": "*Token*", "action": "encrypt" },
        { "pattern": "*Secret*", "action": "encrypt" },
        { "pattern": "userEmail", "action": "strip" }
      ] }
  ]
}
```

规则组字段：`name`（唯一标识；仅限字母、数字、`-`/`_`，且必须以字母或数字开头——真实插件 id 可能包含大写字母，例如 `plugin-DEVONlink-obsidian`） · `path`（支持 `{configDir}` 变量） · `type`（`file`/`dir`） · `devices`（`all`/`desktop`/`mobile`） · `mode`（`plain`/`fields`/`encrypted`，可选，默认 `plain`） · `fields`（按键名设置的 `Strip`/`Encrypt` 规则，仅 `fields` 模式可用——详见[敏感设置](#敏感设置)） · `label`（可选的显示名称，在条目被启用或 capture 时写入，这样即使在未安装该插件的设备上也能正确显示名称）。

操作系统垃圾文件（`.DS_Store`、`Thumbs.db`、`desktop.ini`）永远不会被捕获。按条目的 sync mode 与密码短语加密详见[敏感设置](#敏感设置)。

## 实战演练

**在所有设备上同步快捷键、外观和 CSS 代码片段**
1. Settings → Config Sync → 在 *Obsidian* 分区下，勾选 **Hotkeys**、**Appearance**、**CSS snippets**。
2. 从功能区菜单打开 **Sync**，点击 **↑ Capture N items**。
3. 在其他每台设备上，等笔记同步工具把数据文件夹送达后：打开 **Sync**，点击 **↓ Apply N items**。

**同步某个插件的设置，但让凭证不进入 store**
1. 在 *Community plugins* 分区下，勾选该插件。
2. 将其 mode 设为 **Fields**，然后为其凭证键添加规则，例如 `*Token*`、`*Secret*`、`*APIKey*` → `Strip`（如果希望这些值也能同步，则选 `Encrypt`）。
3. 执行 Capture。被 Strip 的凭证永远不会进入 store；每台设备在每次 apply 后都会保留自己本地填入的值。

**IOTO vault，从零开始**
1. 安装插件——PKM 模式会自动检测 IOTO，并将数据存放在 `0-Extra/config-sync`（取自你的 ioto-settings 辅助文件夹）。
2. 勾选想同步的内容，在 Sync Center 中执行 Capture，交给 remotely-save 传输；其他设备在各自的 Sync Center 中执行 Apply。

**在没有共享笔记同步的情况下，用一个 vault 为另一个 vault 做初始化（桌面端）**
1. 在目标 vault 中：Settings → Config Sync → **Remotes** → 添加一个类型为 **Another vault** 的远程，点击 **Browse…** 并选择源 vault 的文件夹——其 store 会被自动识别并填入 **Store path**（也可以改为添加 git 远程：URL + 分支，可选仓库内的子文件夹）。
2. 打开 **Sync**，展开该远程，点击 **↓ Pull from `<name>`**；然后勾选要 apply 的条目，点击 **↓ Apply N items**。
3. 之后，在源 vault 自己的 Sync Center 中展开该远程，点击 **↑ Push to `<name>`**，发布更新供其他 vault 拉取。

## 安全与隐私

插件默认的一切行为都留在你的 vault 内部：Capture/Apply 只在你的配置目录和数据文件夹之间复制文件，你自己的笔记同步工具负责在设备间搬运它们。有两个**可选的、仅限桌面端**的远程功能会走得更远一些，这里做出说明：

- **网络访问（仅限 git 远程）。** 如果你在 Settings → Remotes 下添加了 git 远程，Pull/Push 会针对你配置的 URL 运行 `git` 二进制程序——这是插件唯一会进行的网络访问。没有遥测，没有其他任何端点。
- **访问 vault 之外的文件（vault 远程与 git 临时克隆）。** 如果你添加了类型为 "Another vault" 的远程，Pull/Push 会读写你配置的绝对 store 路径（通常是另一个 vault 的数据文件夹）。git 推送还会额外使用一个临时克隆目录，操作完成后会被删除。

这两个功能在你配置远程之前都处于禁用状态，并且只有在你于 Sync Center 中明确执行 Pull 或 Push 时才会运行。

## 敏感设置

每个条目都有一个 sync mode（同步模式），在 Settings 中按条目设置：

- **Plain**（默认） —— 原样同步。
- **Fields**（仅文件类条目） —— 按键设置规则：`Strip` 让某个键完全不进入 store（Apply 时保留本地值）；`Encrypt` 把该值存为加密信封，并在 Apply 时解密——凭证也能安全地传输。
- **Encrypt** —— 整个文件以加密形式存储（AES-256-GCM，密钥通过 PBKDF2 从密码短语派生）。

Encrypt 相关模式需要一个 vault 级别的 **Passphrase**（密码短语），在 Settings → General 中按设备设置一次——它绝不会写入任何文件，也不会被同步；只要每台设备使用相同的密码短语即可。如果某个条目含有加密内容，而当前设备尚未设置密码短语，会显示为 🔒 *locked*（已锁定）状态，在设置密码短语之前无法 capture 或 apply。Apply 时密码短语错误会干净地失败，不会写入任何内容。

在你启用同步**之前**，每个已安装的插件就已经被扫描，检查是否包含看起来敏感的键（API 密钥、令牌、密钥、密码、邮箱）或本身就是一整块不透明的加密数据——命中的行会带上 `⚠ N keys` / `⚠ opaque blob` 徽标并排到所在分区最前面；这仅用于提示，模式仍由你决定。每个已同步条目的行展开区域（点击箭头 chevron）中都有一个只读的 **View data.json**：键名按规则状态着色（青色 = 已加密，红色 = 已剥离，琥珀色 = 已检测到但尚未设置规则），点击某个键即可直接为其添加 strip/encrypt 规则——用来兜底内置检测可能遗漏的键。Sync Center 会为每个条目标注其模式徽标（`🔒`/`▤`），capture 报告会准确说明哪些内容被加密、哪些被剥离。

硬性黑名单已经取消——`remotely-save`、`ioto-update`、`slides-rup` 和 `config-sync` 现在都是与其他条目一样的普通条目（例如 `remotely-save` 可以整文件加密；`ioto-update` 很适合用 Fields 模式）。

## 开发

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

请针对专门的测试 vault 进行开发（切勿使用真实 vault）。

## 发布

1. `npm version <x.y.z>` —— 通过 `version-bump.mjs` 更新 `manifest.json` + `versions.json`，并提交、打标签。
2. `git push --follow-tags`
3. "Release Obsidian plugin" 工作流会执行构建、生成构建溯源认证(build provenance)，并创建一个包含 `main.js`、`manifest.json`、`styles.css` 的**草稿(draft)** GitHub release。
4. 在 GitHub 上发布该草稿——插件目录和 BRAT 只会看到已发布的 release。

## 许可证

[MIT](LICENSE)
