# settings-ux-and-release-docs 设计文档

obsidian-config-sync v0.1.0 交付后的第一轮迭代。2026-07-09 定稿。主 spec（架构与核心语义）见 [2026-07-08-obsidian-config-sync-design.md](2026-07-08-obsidian-config-sync-design.md)，本文档只描述增量。

## 背景：四个用户需求

1. GitHub Release 需要能发布——核实结论：**流水线已存在**（模板自带 `.github/workflows/release.yml`，推 tag → CI 构建 + 溯源认证 + 建草稿 Release），缺的是文档；
2. obsidian-cli / dev vault 冒烟经验应沉淀成文档；
3. 设置面板的 "Create config-sync.json" 按钮没有意义——创建动作应该是隐含的；
4. JSON 文本编辑对不熟 JSON 的用户不友好——设置面板应提供表单化配置。

## A. 发布文档（不新增流水线）

- README 的 Releasing 一节重写为真实流程：
  1. `npm version <x.y.z>`（`version-bump.mjs` 同步 manifest.json + versions.json，创建 commit 与 tag）；
  2. `git push --follow-tags`；
  3. CI（release.yml）自动构建、attest、创建**草稿** Release 并挂 main.js / manifest.json / styles.css；
  4. 人工在 GitHub 上 Publish 该草稿——BRAT 只识别已发布的 Release。
- CLAUDE.md 增加指向该流程的简述。

## B. 冒烟 / CLI 知识沉淀

扩写 CLAUDE.md 的 "Smoke testing" 一节，记录硬知识：

- **vault 注册只能人工做**：Obsidian 启动时从内部状态重建 `obsidian.json`，外部注入的注册表条目会被剪除；CLI 无法注册/打开新库。dev/vault 首次使用需人工 "Open folder as vault" + Trust；
- obsidian-cli（`/Applications/Obsidian.app/Contents/MacOS/obsidian-cli`）能力速查：`command id=obsidian-config-sync:<cmd>`、`eval code=...`、`plugin:reload id=...`、`dev:dom` / `dev:errors` / `dev:screenshot` / `dev:mobile`、`vaults verbose`；
- 用 eval 驱动 Modal 的套路：`document.querySelectorAll('.modal .checkbox-container')[i].click()` 勾选 → 按钮文本定位 Continue → `.modal-close-button` 关报告；FuzzySuggestModal 点 `.suggestion-item`。

spec（主文档）与 plan 不动：前者是产品设计，后者是历史档案。

## C. 隐式创建 config-sync.json（移除按钮）

- **删除**设置面板的 "Create config-sync.json" 按钮（`createStarterManifest` 保留为内部函数）。
- **命令侧**：Publish 与 Apply 在 `loadManifest` 前检测文件缺失 → 自动写入 starter（`$schema` + snippets/hotkeys 两个安全组）→ `Notice` 告知已创建 → 继续执行。Apply 在新建 starter 后各组通常报 "store has no data"——这是可见的真实状态，不静默。Revert / Import 不依赖该文件，不涉及。
- **面板侧**：组编辑器（见 D）的任何合法编辑落盘时文件不存在则创建——创建成为配置动作的自然副作用。

## D. 设置面板表单化（组 + 外部源）

**文件是唯一真相源，面板只是它的视图。**

### 组编辑器（写 `<root>/config-sync.json`）

- 每组一行：`name` 文本框、`path` 文本框（占位提示 `{configDir}/…`）、`type` 下拉（file/dir）、`devices` 下拉（all/desktop/mobile）、`sanitize` 文本框（逗号分隔 glob，仅 file 组启用）、删除按钮；底部 "+ Add group" 按钮。
- 打开面板时从文件读入；文件缺失显示空列表（首次合法编辑时创建）。**生效根路径变更时草稿必须重载**：PKM 模式切换即重载；Data folder 为自由文本，在**失焦（blur）时**重载（输入过程中不重渲染以防丢焦）——否则旧根读入的草稿会在编辑时覆盖新根的文件。
- **字段变更即校验，合法即写盘**（含 `$schema`、2 空格缩进 + 尾换行）；非法不写盘，在该行显示原因（黑名单、重名、store 路径冲突等，复用核心校验）。
- JSON 熟手仍可直接编辑文件（`$schema` 提供编辑器校验），面板重开时重读。

### 外部源编辑器（写插件 data.json）

- 替换现有 JSON 文本框：每源一行——`name`、`type` 下拉（local-path/git）、按类型条件显示 `path` 或 `remote`+`branch`、`root`、删除按钮；底部 "+ Add source"。
- 校验语义与现有 `parseExternalSources` 一致；非法不保存并显示原因。

### 实现层重构

校验从"只收字符串的 parse 函数"中拆出对象级函数：`validateSyncManifest(obj): SyncManifest`（parse = JSON.parse + validate；表单直接 validate，不绕 stringify→parse）。`parseExternalSources` 同理拆出 `validateExternalSources(arr)`。对外行为不变，现有测试全部保留。

## E. PKM MODE（含自动探测）

- 新增插件设置 `pkmMode: "auto" | "ioto" | "default"`（默认 `auto`），设置面板顶部下拉。
- **自动探测（auto 模式）**：运行时检测 `ioto-update` 插件是否启用（经 PluginHost.isPluginEnabled，不加新依赖）——启用 → 生效模式 ioto，否则 default。下拉在 auto 项上标注当前探测结果（如 "Auto (detected: IOTO)"）。
- 各生效模式的 Data folder 默认值：
  - `default` → `config-sync`（内容区、以插件名命名）；
  - `ioto` → 读取 `{configDir}/plugins/ioto-settings/data.json` 的 **`extraFolder`** 键（IOTO 辅助目录，如 `0-Extra`），默认值为 `<extraFolder>/config-sync`；文件/键缺失或非法时回退 `0-Extra/config-sync`。
- **rootPath 语义调整**：设置里 rootPath 为空串 = "跟随生效模式的默认值"（运行时解析，settings 面板以 placeholder 展示当前解析结果）；非空 = 用户自定义覆盖，永远优先。解析后的 rootPath 永不为空，原 rootPath 合法性防线作用于解析结果。清空输入框即回到跟随模式。
- 约束：默认值必须在内容区——store 依赖 remotely-save 同内容同步（主 spec §2）；配置目录（含插件安装目录）不可作为默认值。

## 错误处理

延续主 spec 原则：非法输入不落盘、不静默，就地显示原因；命令侧自动创建失败（如 rootPath 非法）沿用现有 Notice 报错路径。

## 测试

- `validateSyncManifest` / `validateExternalSources` 拆分：现有 parse 测试不动，新增对象级直调用例（合法对象、黑名单命中、重名）；
- 命令侧自动创建：core 层测试（缺文件 → publish 自动建 starter 并发布两组；apply 自动建后组报 store-missing error result）；
- PKM MODE 解析：core 层纯逻辑测试（auto+ioto-update 启用 → ioto；extraFolder 读取与回退；空 rootPath → 解析为模式默认；自定义覆盖优先）；
- 表单 UI 不做单测（项目惯例），用 dev/vault + obsidian-cli 冒烟：面板加组→文件落盘、非法输入不落盘、PKM MODE 探测与切换、外部源表单增删。

## 验收清单

1. README/CLAUDE.md 发布流程与实际 release.yml 行为一致（可选：实际发布 v0.1.0 验证）；
2. CLAUDE.md 冒烟章节含 vault 注册限制与 CLI 速查；
3. 设置面板无创建按钮；缺文件时 Publish/Apply 自动建 starter 并 Notice；
4. 面板可增删改组并落盘生效（Publish 按新组执行）；非法输入不落盘且有提示；
5. 外部源表单可配置 local-path 与 git 两类源，Import 正常使用；
6. PKM MODE：auto 下启用 ioto-update 的库自动解析为 `<extraFolder>/config-sync`（kickstart 实测 `0-Extra/config-sync`）；无 IOTO 的库解析为 `config-sync`；手动模式与自定义 rootPath 覆盖均生效。
