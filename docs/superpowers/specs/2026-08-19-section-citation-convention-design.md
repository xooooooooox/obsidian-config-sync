# `§N` 章节引用约定的文档化 — design

Date: 2026-08-19 · Scope: `CLAUDE.md` `## Rules` 一条 ·
Status: **已被 `2026-08-19-docs-and-comments-iteration-design.md` 取代** ·
起因: 用户级 CLAUDE.md 排版符号规则评审时,本仓库被取作样本实测

> 本份的结论是「保留 `§`,不做批量替换」。owner 随后裁定 `§` 全库退役,理由记在取代它的
> 那一份里。以下内容原样保留:它记录的是当时的判断。

本轮不改任何代码,也不改任何既有引用。唯一产出是把一个已在全仓运行、却零文档的约定写进
`CLAUDE.md`。

---

## §1 现状:约定是真的,文档是没有的

全仓 `§` 出现 **851 行 / 140 文件**(`src/` 9 文件 117 行,其余在 `tests/`、`styles.css`、
`docs/`)。抽样核对表明它**不是装饰性符号,而是能解析的交叉引用**,且是双向闭合的:

- **被引用侧**:`docs/design/DESIGN.md` 用显式编号标题(`## 1. Design tokens`、
  `### 1.1 Semantic colors` … `## 6. Open items`);`docs/superpowers/specs/*.md` 用
  `## §N` 编号标题,全库共 **134 个**。
- **引用侧**:代码注释逐一指得准。
  - `styles.css:704` `/* Orange fills carry --background-primary text (DESIGN.md §1.1) */`
    → §1.1 = Semantic colors;
  - `tests/versionGates.test.ts:17` `// spec 2026-08-11-data-model-hardening.md §4
    (invariant II.3)` → 该 spec `:121` 正是 `## §4 Version gates (invariant II.3)`,
    连括号内的 invariant 编号都对得上。

**但 `CLAUDE.md` 全文没有一句声明这个约定。** 851 处用法完全靠上下文传染维持——每个新
agent 读到既有文件才照着写。后果已经可见:出现 `§2.3/§4` 这类合写形式,以及 `§4 Leftover`
(编号 + 标题名混合)与纯 `§1.1` 两种引用粒度并存,无一处有依据可循。

## §2 决定:文档化,不是替换

1. **保留 `§`,不做批量替换。** 它在服务真实功能,替换要动 140 文件、重写 blame,收益仅为
   「少一个需 Option+6 输入的字符」,不成比例。
2. **写进 `## Rules` 而非 `## Doc map`。** `## Doc map` 回答「有哪些文档」;本条是跨切面写作
   约定,与同节的 **Schema-first, design-first**、**Documentation currency** 同类。
3. **同时写明重编号耦合。** 851 处引用指向编号标题,任何一侧重编号都会**静默失效**——没有
   任何测试或 lint 覆盖它。这是该约定唯一的真实风险,必须在规则里点名,而不是留给下一个人
   踩。
4. **引用必须可解析** —— 禁止凭印象写 `§N`。上文的 `§4 (invariant II.3)` 是正面样例:引用
   与标题逐字对齐。

上游背景:用户级 `~/.claude/CLAUDE.md` 同期新增了「新代码/英文散文优先 ASCII 标点」一条,
但该条带三重限定(仅 new code、仅英文散文、**既有仓库惯例优先**),第三重限定正是为保护本
仓库这类有效约定。两条规则不冲突,本 spec 即其落点。

## §3 方案

`CLAUDE.md` `## Rules` 增一条,置于 **Schema-first, design-first** 之后(二者同以
DESIGN.md 为轴),按该文件既有笔迹(`- **Term:** …`,~90 字符折行):

```markdown
- **Section citations:** cite a numbered heading as `DESIGN.md §2.3` or
  `<spec>.md §4` — every citation must resolve to a real heading, and renumbering
  either side updates its citations in the same branch. No test covers this.
```

## §4 不做

- 不改任何既有 `§` 引用(851 处)。
- 不加 lint / 测试校验引用可解析性 —— 需要解析 markdown 标题并跨文件比对,为一个从未失效过
  的风险建一套机制,成本高于收益;先用规则点名,真出问题再谈。
- 不动 `—`(2738 处)、`→`(284 处)等其它符号 —— 与本约定无关,属独立议题。

## §5 验证

1. `git --no-pager diff` 确认 `CLAUDE.md` 仅 +1 条,spec 为新增文件;
2. 回归护栏:
   `grep -rIc "§" --exclude-dir=.git --exclude-dir=node_modules . | grep -v ':0$' |
   awk -F: '{s+=$2} END {print s}'` 应仍为 **851**(本 spec 自身除外)——证明既有引用未被触动;
3. 行为验证(日常观察):后续新写的注释若含章节引用,应为可解析的 `<doc>.md §N` 形式,不再
   出现 `§2.3/§4` 这类无依据的合写。
