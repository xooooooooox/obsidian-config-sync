<p align="center"><img src="assets/logo.svg" width="96" alt="Config Sync logo"></p>

# Config Sync

[![release](https://img.shields.io/github/v/release/xooooooooox/obsidian-config-sync?label=release)](https://github.com/xooooooooox/obsidian-config-sync/releases/latest)
[![downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22config-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)](https://obsidian.md/plugins?id=config-sync)
[![Static Badge](https://img.shields.io/badge/README-EN-blue)](./README.md)
[![Static Badge](https://img.shields.io/badge/README-中-red)](./README.zh.md)

在多台设备和多个 vault 之间，按需、选择性地同步 Obsidian 设置——快捷键、CSS 代码片段、主题、插件配置。数据默认借助你现有的笔记同步工具(note sync)（remotely-save、Obsidian Sync、iCloud……）传输，也可以使用 config-sync 自带的 git / vault 远程通道。任何设置在没有在 Sync Center 中明确执行 **Apply**(应用) 之前，绝不会落到设备上。

> [!IMPORTANT]
> **在任何一台设备再次 capture 或 pull 之前，先把所有设备都更新到本版本。**
> 本次发布把设置换成了新的格式，而且是单向的。仍停留在 **2.21.0** 或 **2.22.0** 的设备遇到新格式会明确拒绝并给出提示，什么都不会改动；而 **2.20.0 或更早**的设备会把 Config Sync 的设置**重置为默认值**——这一条事后无法补救。请先在所有设备上更新 Config Sync，然后照常使用。
> 一个你从未为它设过规则的插件，一旦共享名单本身开始同步，就会跟随它——因此**升级后的第一次同步可能会把某些插件打开或关闭**，把设备之间此前悄悄积累的差异收拢到一致。见[从 2.21.0 及更早版本更新](docs/GUIDE.md#updating-from-2210-and-earlier)。

![Sync Center](docs/assets/sync-panel.png)

## 功能特性

- **每个条目一张卡片** —— 每个被同步的对象（一组 Obsidian 选项、一个核心/社区插件、一份代码片段）都是一行 + 可展开抽屉，抽屉里放着它的规则；插件的启用状态就在它自己的卡片上。（[详情](docs/GUIDE.md#settings)）
- **逐键的正交规则** —— 每个键都带有一个 `{sharing, encrypted}` 二元组（`All devices` / `Desktop only` / `Mobile only` / `This device`），字符串数组类型的键还可以让每个元素拥有自己的共享规则。（[详情](docs/GUIDE.md#field-rules--sensitive-settings)）
- **凭证安全** —— `This device` 键永远不会离开本机，按设备设置的密码短语则为需要传输的内容加密。
- **明确的 Apply** —— 在你勾选条目并按下 Apply 之前，设备上不会有任何变化；每次运行都会留在贴顶结果条与可浏览的 **History** 中可见。
- **随时可见状态的 Sync Center** —— 每一行都会用大白话说清自己的命运（*开启 · 安装 · 应用设置*）、归一化的 JSON 差异、一个 *this device* 状态胶囊，以及每一类待办动作的总数。（[导览](docs/GUIDE.md#the-sync-center)）
- **安装引擎** —— 本设备上版本落后、被禁用或未安装的插件可以在 Apply 过程中一并更新、启用或安装，并锁定到 capture 时的版本。（[规则](docs/GUIDE.md#availability-facts-and-the-install-engine)）
- **Remotes（桌面端）** —— 针对 git 仓库或另一个 vault 执行 pull/push，并提供逐文件差异预览。（[详情](docs/GUIDE.md#transport)）
- **可以一台一台地更新** —— 由更新版本的 Config Sync 写下的设置或 store 会被明确拒绝并给出提示，绝不会被重置或覆盖；而某台设备自己的选择（它把哪些条目排除在同步之外）就留在那台设备上，pull 抹不掉它。这层保护从 2.21.0 才开始生效；若要从更早的版本更新，请先看上面的提示。（[详情](docs/GUIDE.md#transport)）
- **随处可搜索** —— 两个搜索框都支持带自动补全的 `key:value` 限定符（`section:`、`type:`、`action:`、`mode:`、`device:`），可与纯文本自由组合。
- **状态栏** —— ↑ capture / ↓ apply 加上每个 remote 各自的 ⇡ push / ⇣ pull 计数一目了然；点击即可打开 Sync Center。
- **移动端友好** —— capture、apply 与 Sync Center 在手机上均可正常工作；store 本身就是普通的 vault 内容，因此任何笔记同步工具都能携带它。

## 安装

在 Obsidian 内：**Settings → Community plugins → Browse**，搜索 **Config Sync**，安装并启用。

体验测试版：通过 [BRAT](https://github.com/TfTHacker/obsidian42-brat)，添加 `xooooooooox/obsidian-config-sync`。

## 快速开始

1. **Settings → Config Sync** —— 勾选你想同步的内容（Obsidian / Core plugins / Community plugins / Beta 标签页）。
2. 从功能区菜单打开 **Sync Center**（或使用 **Open Sync Center** 命令），勾选要 capture 的条目，点击 **Capture N items**。
3. 在另一台设备上，等你的笔记同步工具把数据文件夹送达之后：打开 **Sync Center**，勾选要 apply 的条目，点击 **Apply N items**。

![Settings picker](docs/assets/settings-picker.png)

## 工作原理

两个层面，彼此分离。

- **本地层面** —— **Capture** 把每个已启用条目的设置文件和 companion 文件夹复制进 store，按每个字段的 `{sharing, encrypted}` 规则处理；**Apply** 把你勾选的条目落地到本设备的配置目录。方向（↑ capture、↓ apply）来自每台设备各自的同步基线，而不是文件时间，因此 Sync Center 能判断究竟是哪一侧真正发生了变化。
- **传输层面** —— store 默认就是普通的 vault 内容，随你的笔记同步工具流转；全新设备会自行发现送达的 store，并提供一份 **Adopt** 引导。（桌面端）可选地，通过 Sync Center 的 Remotes 区块对 git 仓库或另一个 vault 执行 Pull/Push。

完整导览——Sync Center 结构、字段规则、加密、安装引擎、remotes、实战演练——都在 **[用户指南](docs/GUIDE.md)** 中。

## 安全与隐私

插件默认的一切行为都留在你的 vault 内部：Capture/Apply 只在你的配置目录和数据文件夹之间复制文件，你自己的笔记同步工具负责在设备间搬运它们。有三项**可选的、仅限桌面端**的远程行为会走得更远一些，这里做出说明：

- **网络访问（仅限 git 远程）。** 如果你在 Settings → Remotes 下添加了 git 远程，Pull/Push 会针对你配置的 URL 运行 `git` 二进制程序——这是插件唯一会进行的网络访问。没有遥测，没有其他任何端点。
- **访问 vault 之外的文件（vault 远程与 git 临时克隆）。** 如果你添加了类型为 "Another vault" 的远程，Pull/Push 会读写你配置的绝对 store 路径（通常是另一个 vault 的数据文件夹）。git 推送还会额外使用一个临时克隆目录，操作完成后会被删除。
- **访问令牌（仅限 git 远程）。** 你关联到某个 git 远程的 token 保存在该设备自己的 Obsidian 密钥库中，并通过环境变量交给 `git`，绝不出现在命令行上。插件设置里只写入该密钥的*名字*——token 本身不会进入 `data.json`、不会进入 store、也不会出现在任何错误信息中。远程列表本身也从不被 Config Sync 送出（它是锁定的「仅本设备」字段），因此这个名字只有在你自己的 vault 同步顺带搬运了插件的 `data.json` 时才会到达另一台设备；每台设备要么自行关联一份 token，要么一份也没有。

这三项在你配置远程之前都处于禁用状态，并且只有在你于 Sync Center 中明确执行 Pull 或 Push 时才会运行。

## 文档

- **[用户指南](docs/GUIDE.md)** —— 所有行为汇于一处：Sync Center、字段规则、敏感设置、传输、实战演练。
- **[架构](docs/ARCHITECTURE.md)** —— 代码地图与不变量，供贡献者参考。

## 开发

```bash
npm install
npm run dev     # watch build
npm test        # vitest
npm run build   # type-check + production bundle
```

请针对专门的测试 vault 进行开发（切勿使用真实 vault）。

## 许可证

[MIT](LICENSE)
