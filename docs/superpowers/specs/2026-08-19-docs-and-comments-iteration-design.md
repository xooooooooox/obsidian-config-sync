# 注释与文档专项迭代(2.24.2)— design

Date: 2026-08-19 · Scope: `CLAUDE.md` 规则、两份新文档、全库注释与常青文档 · Status: 待评审 ·
起因: owner 指定本轮为「代码注释加文档」专项迭代,并裁定 `§` 全库退役

**取代 `2026-08-19-section-citation-convention-design.md`。** 那份的结论是「保留 `§`,不做批量
替换」,本份反转它。那份的 Status 改为「已被本份取代」,内容保留不动:它记录的是当时的判断。

本轮**不改一行代码逻辑**,不改测试断言,不改测试名。产出是规则、两份新文档,以及按规则对既有
注释与文档的清理。

---

## 1. 现状:变更史写进了只该讲现状的地方

三处都在漏,根因是同一个。

**代码注释。** 全量普查 `src/` 66 文件 / 23631 行,其中 6396 行是注释(27%),392 处违反
`CLAUDE.md` 的 **Comments carry invariants, not history**:88 处讲版本史(两处直接写 git SHA
`987eacf`),50 处分节与步骤旁白,22 处复述下一行,227 处超过 6 行(57 处超过 12 行)。
`styles.css` 另有 8 处历史叙事、6 处版本戳注释、9 处分节横幅;`tests/` 约 28 处历史叙事、16 处
版本戳。

**章节引用。** 全库 851 处 `§` / 140 文件,`src/` 占 126 处。这 126 处里只有 17 处是合规的
`<file>.md §N`:45 处写 `spec §N` 却从不点名哪一份 spec,58 处连文档名都没有,22 行是
`§2.3/§4`、`§4.2b/N3` 这类合写。而 `§4.2b`、`N3`、`P4`、`batch2`、`Task 2 fix round 1` 指向的是
`docs/superpowers/` 下的工作文档,而 `CLAUDE.md` 自己写着那些文件 "never a statement of the
current system"。**代码注释的依据,仓库自己声明为非权威。**

**常青文档。** `README.md` 顶部一段 `> [!IMPORTANT]` 是升级通告;`docs/GUIDE.md` 有一整节
"Updating from 2.21.0 and earlier";`docs/ARCHITECTURE.md` 里躺着一整段**发布说明的起草指令**
("This (v4) release's notes must LEAD with…"),外加几十处 "unchanged by this release" 与
"2.21.0 §6 deferred";`docs/design/DESIGN.md` 有 15 处 "used to" 旁白和一处裸 SHA。

**根因是规则的射程。** 反编年史规则只写给代码注释,散文文档从未被它管过,于是同一种毛病在
DESIGN 与 ARCHITECTURE 里无阻碍地长了两年。

**一处活证据。** `src/ui/panelTaxonomy.ts`、`docs/ARCHITECTURE.md`、`docs/design/DESIGN.md` 都
写着 "until 2.25.0",但那批工作实际是以 2.24.0 / 2.24.1 发的。注释里的版本号本身就是错的:
写进注释的版本史无人维护,也无从维护。

## 2. 决定

**2.1 `§` 全库退役,不是换符号继续引。** 替代形式是**直接说那一节讲了什么**:注释里的不变量
必须自己站得住,删掉引用不影响读者判断规则是否成立;确实需要出处时,写文档名加标题名
(`DESIGN.md 的 Semantic colors 一节`),不写编号。三条理由都成立:编号引用在任一侧重编号时
静默失效,且无测试覆盖;`§` 是排版符号,与「新代码与英文散文优先 ASCII 标点」相抵触;103 处
指不到实处的现状,证明这套引用从未真正被维护过。

`N3`、`P4`、`batch2`、`Task 2 fix round 1`、`real-vault find 2026-07-17` 这类评审流水号直接删,
它们从来不是章节。

**2.2 反编年史规则的射程扩到散文文档。** 常青文档描述系统现在是什么样;「哪一版改的、以前是
什么样、升级要注意什么」有专门的家。版本号只在两种情况下允许留在常青文档里:描述本构建**今天
仍必须容忍**的线上兼容事实(混版设备、旧格式 store),或一行指向 UPGRADING 的链接。

**2.3 发布史与升级指引各有其家。** `CHANGELOG.md` 记每一版改了什么;`UPGRADING.md` 记需要人工
干预的升级。两份都放仓库根,与业内主流一致。

**2.4 混版兼容不是历史。** 本构建今天仍在执行的拒绝行为(遇到更新格式就拒绝并说明、不覆盖)
留在 `GUIDE.md`,那是当前行为。搬走的只有「从旧版升上来要按什么顺序做」。这条界线在实施时逐句
判,判据是:这句话描述的是本构建今天的行为,还是一次已经过去的迁移?

**2.5 文档与代码冲突,以代码为准。** 勘察发现 9 处漂移,全部是文档追不上重命名或重构,无一处
代码可疑,因此 9 处全部改文档。代码本身可疑的另立登记表,本轮只记不修。

**2.6 破折号不做补充说明。** 新写的散文改用冒号、分号或断句;本轮被重写的句子照新约定写。
**不做全库破折号清理**:仓库英文散文里有 2738 处 `—`,那是这套英文文案已成型的笔迹,批量替换
是一个与本轮无关的巨型 diff,还会改变已定稿的语感。

## 3. 方案

**3.1 `CLAUDE.md` 的 `## Rules`**:删掉 `Section citations` 一条,换成禁用 `§` 并给出替代形式;
新增 `Docs state the current system, not its history`;`Comments carry invariants, not history`
保持原样。这三条是本轮所有删改的依据,先落。

**3.2 `CHANGELOG.md`(新增,仓库根)**。格式以 `anthropics/claude-code` 仓库里的 `CHANGELOG.md`
原文为准,不是文档站的渲染页,三处关键差别:

- 全文前言只有一行 `# Changelog`,没有说明段落。
- 版本标题是裸的 `## x.y.z`,**不带日期**。
- 条目是平铺的 `-` bullet,**不带指回 release 的链接**,不套二级 bullet,不设分类小标题。

条目写法照抄它的笔迹:开头动词自带分类(`Added` / `Fixed` / `Improved`),组件相关的用前缀冒号
(本仓库对应 `Sync Center:`、`Settings:`、`Remotes:`),平台相关的用方括号(`[Mobile]` /
`[Desktop]`),行内用反引号标 UI 词与设置名。

没有链接这一点改变了回填的性质:每条必须自己把话说完,不能指回 GitHub release 兜底。回填
**2.x(2.0.0 起,62 版)**,逐版读原 release body 后压成 bullet。0.x 不回填,文末一行说明更早
的历史在 GitHub Releases。

`CONTRIBUTING.md` 的 Releasing 流程插一步:先写 CHANGELOG 条目,再 `npm version`。GitHub release
body 就是该版的 CHANGELOG 条目;需要人工干预的版本,body 末尾加一行指向 `UPGRADING.md`。

**3.3 `UPGRADING.md`(新增,仓库根)**:按版本倒序,每个需要人工干预的版本一节。首批内容全部
是搬运,不重写:`GUIDE.md` 的 "Updating from 2.21.0 and earlier" 整节、混版两块里属于升级指引
的部分、退役的 `scope:` 语法段(现有两处重复,合并成一处)、两份 README 顶部的 `[!IMPORTANT]`
块、`ARCHITECTURE.md` 那段发布说明起草指令(改写成 2.23.0 升级须知)。

**3.4 两份 README**:删顶部通告块;把带版本号的括注收成不带版本号的表述;`## Documentation`
增两行指向 CHANGELOG 与 UPGRADING。两份现在逐行对齐,改完必须仍然对齐;`README.zh.md` 的锚点
指向英文 GUIDE,搬节时一起改。

**3.5 `docs/GUIDE.md`**:删迁移节与重复的退役语法段,TOC 相应更新并加一行指向 UPGRADING;把
`schemaVersion: 4` 与转换说明改成不带版本号的现状陈述。共 6 处内链指向被删的锚点,全部要改。

**3.6 `docs/ARCHITECTURE.md`**(工作量最大)分三类逐段判,不做无差别删除。发布期评论删或搬;
迁移模块的描述留下但改语气(`v2Migration.ts` 在代码里真实存在,它的职责必须被记录,写「它把
v2 文档转成 v3」,不写「本次发布没有动它」);由历史 bug 论证的不变量,留不变量、删编年史。
另有两处**散文形式**的跨文件引用(`CONTRIBUTING.md` 与 `DESIGN.md` 各一处按标题名引用
ARCHITECTURE 的一节,不是 markdown 链接),搬节会静默断掉,一并改。

**3.7 `docs/design/DESIGN.md`**:15 处 "used to" 旁白改成现状陈述;裸 SHA 删除;错误的版本号
删除。**测量值与设计理由全部保留**:那是这份文档的正业,也是代码注释瘦身时那些数字的去处。

**3.8 注释清理分批**,每批一次提交、一次 review,任何一批都能独立停下:批 1 无争议的删除(纯
编年史、分节旁白、复述);批 2 `§` 引用;批 3 超长块瘦身(模块头 JSDoc 豁免);批 4 判断题。

**3.9 漂移修正**:9 处以代码为准修文档,含两处过期的 lint 数字(文档写 58 warnings,实测 0
errors / 57 warnings)。其中一处需给 `schema/run-history.schema.json` 补两个字段的 `description`
(结构不动),受 `tests/schemaFiles.test.ts` 把关。

**3.10 冲突登记表** `docs/superpowers/notes/2026-08-19-code-doc-conflicts.md`:本轮不修、留待
裁决的条目,一条一行,记文档主张 file:line、代码实况 file:line、可疑点。

## 4. 不做

- **不改任何代码逻辑。** 硬证据是 production 构建的 `main.js` 逐字节对比:`esbuild.config.mjs`
  的 `minify: prod` 会剥掉全部注释,字节相同即证明只动了注释。
- **不改测试断言,不改测试名。** 约 8 个测试名本身在讲历史(`it("no longer …")`),入登记表。
- **不动 `docs/superpowers/specs/` 与 `plans/` 下的既有存档。** 251 个文件是带日期的历史记录,
  含 134 个 `## §N` 标题;`CLAUDE.md` 本就声明它们不代表现状。批量改写等于篡改当时写下的东西,
  还要洗一遍 blame,收益为零。唯一例外是给被取代的那份 spec 补一行 Status。
- **不回填 0.x 的 changelog。** 仓库有 125 个 release、约 160KB 手写发布说明;0.x 是史前史,
  回填成本与收益不成比例。
- **不给章节引用加 lint 或测试校验。** `§` 都删了,没有可校验的对象。
- **不做全库破折号清理**(见 2.6)。
- **不动 `version-bump.mjs`。** 它有 3 处复述型注释,但属上游 vendored 文件,按模板合并规则
  「toolchain 取上游」。
- 不新增 zh 版 GUIDE。

## 5. 验证

1. 四道门全绿:`npm run build`、`npm test`、`npm run lint`、`scripts/check-no-hardcoded-color.sh`。
   lint 基线按实测的 0 errors / 57 warnings,同时改正文档里的 58。
2. 每批前后 `main.js` 逐字节相同。这是「不改代码」这条要求唯一可信的验收方式。
3. `§` 归零:除 `docs/superpowers/` 存档外,全库 grep `§` 应无输出。
4. 断链:grep 被删的锚点与被搬的标题名,确认 6 处内链加 2 处散文引用全部改到位。
5. `CHANGELOG.md` 的版本号逐一对齐 `git tag`,条目内容与对应 release body 的事实一致。
6. 冒烟:`npm run smoke:install` 后在 `dev/vault` 打开 Sync Center 与 Settings。CSS 删注释误伤
   大括号会静默改变样式,`npm test` 对此无能为力。
