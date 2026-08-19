# 注释约定「留不变量、不留编年史」的文档化 — design

Date: 2026-08-19 · Scope: `CLAUDE.md` `## Rules` 一条 · Status: 待评审 ·
起因: 2.25.0 控件轨道那一轮,owner 指出注释不够简洁,并要求遵守用户级 CLAUDE.md 的注释约定

本轮不改任何代码。产出是一条 `CLAUDE.md` 规则,外加把**本轮已经动过的那几段注释**按它重写
(那部分已随 `2b84416` 落地)。与 `2026-08-19-section-citation-convention-design.md` 同一类
变更、同一处落点,故篇幅与结构对齐。

---

## §1 现状:注释在讲版本史,而版本史是 git 的

用户级 CLAUDE.md 的 Code Comments 一节写着两条,这个库都在违反:

- **Comment why, not what** —— 这条库里守得不错,注释确实在讲「为什么」。
- **Never write history into comments(`// added`、`// fixed #123`、`// previously X`)**
  —— 这条大面积失守。它不是以 `// added` 这种显式标记出现的,而是以**叙事**出现的:

  - `styles.css` 的 slots 段:`It used to hold both, so a row missing its aux control showed
    a visible hole and its remaining controls floated left of the rail.`
  - `styles.css` 的 card-trigger 段:`At 4px vs 6px the More row's icon sat 2px right of the
    merged controls above it — the boxes were aligned the whole time.`
  - `styles.css` 的 cardrow 段:`The shape before this pinned controls to a fixed 130px offset
    instead — unremarkable on a wide desktop card, dead centre of a 390px phone row.`

  三段都在复述「改之前是什么样、为什么改」。读者要判断的是**现在这条规则成不成立**,而不是
  它的来历;来历在 `git log -p` 里,而且更准。

第二个症状是**长度**:一条不变量常被写成 8 到 12 行。上述 card-trigger 那段 6 行里只有 1 行
是规则(两个盒子的 padding 必须相同),其余是那次调试的经过。

## §2 决定:留不变量,删编年史,度量搬 DESIGN

1. **留「为什么」和不变量**,删「曾经是什么样」。判据:删掉这句话之后,读者判断这条规则是否
   成立的能力有没有下降?没有,就该删。
2. **度量归 DESIGN.md**。`14px` 这类数字要有出处(实测)和归宿(设计文档的 1.4 表),注释里
   只需引用。这也让重测有唯一落点。
3. **一两行**。理由长过一段,通常说明这条规则本身该进 DESIGN.md,或者这段代码该拆。

## §3 方案

`CLAUDE.md` `## Rules` 增一条,置于 **Smoke before deploy** 之前,按该文件既有笔迹
(`- **Term:** …`,约 90 字符折行):

```markdown
- **Comments carry invariants, not history:** say why a rule exists and what breaks without it,
  in a line or two. Never write what the code already says, and never write the changelog
  ("used to be", "before this", "at 4px the icon sat 2px right") — git owns that. A rule whose
  reason takes a paragraph is usually a rule that wants a measurement in DESIGN.md instead.
```

## §4 不做

- **不做全库注释瘦身。** `src/` 与 `styles.css` 合计数千行注释,一次性重写是个与任何功能改动
  都无关的巨型 diff,还会把 blame 洗一遍。规则从此约束**新写和改到的**注释;存量按「谁动谁改」
  自然收敛,真要成批做就单独排一次迭代。
- **不加 lint 校验。** 「这句是不是在讲历史」不是正则能判的,人读一眼就够。
- 不动 `§` 引用约定 —— 那是同日另一份 spec 的议题,两者互不影响。

## §5 验证

1. `git --no-pager diff` 确认 `CLAUDE.md` 仅 +1 条;
2. §1 举的三处叙事应全部消失:前两处随 `2b84416`(轨道对齐)的注释重写落地,card-trigger 那处
   在本次提交中删除;三处的**规则本身**都保留,数字进了 DESIGN.md 1.4。核验:
   `grep -n "used to hold both\|At 4px\|shape before this" styles.css` 应无输出;
3. 行为验证(日常观察):后续注释若出现「以前是」「原来会」这类句式,即为违反。
