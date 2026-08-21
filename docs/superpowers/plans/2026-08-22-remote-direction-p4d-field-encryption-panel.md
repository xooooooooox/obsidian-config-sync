# 2.25.0 · Plan 4d:加密的两种形态,面板与闸门 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** spec 2.3 把加密按**存储形态**两分:字段级(store 里仍是正常 JSON,键名明文)与整份(一个信封)。面板今天只有一个加密标记(`lock`),而 4a 就记下了一道空着的闸:`relCanHaveKeys` 只看后缀是不是 `.json`,于是**整份加密的项也会被它认成能有键规则** —— 一条这样的规则真被写进 data.json 的话,`overlayWithheld` 会去「扣留」信封自己的 salt/iv/ct 键。本轮补两个字形(`key-round` 字段级 / `lock` 整份)、关上那道闸,并用测试钉死加密键扣留在两种密码情形下的字节行为。

**先说清楚哪些活已经不存在了。** 4a 的边界清单把三件事划给了 4d,其中两件在 4b/4c 落地过程中顺带成立:① **字段级加密项的 Keys 区已经开着** —— `keysRowModel` 的 `encrypted` 输入一直是 `isWholeFileEncrypted`,字段级项从来走的是 `rules` 分支,键名明文列出、文档可点;② **加密键的扣留在异密码下过明文**也已成立 —— 4c 的「转码先行、扣留后叠」意味着 overlay 的两侧都已是目的地密钥,被扣的键原封保留对面自己的信封。剩下的就是本文件的三件:字形、闸门、钉字节的测试。

**Tech Stack:** TypeScript(strict)、vitest(真 WebCrypto)。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §2.3、§5.3 的两字形。验收 6(字段级 Keys 区)、17(扣留的加密键)。

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 – 3f | 数据模型 → 统一面板 → 逐项方向 → 派生 lock → 逐键扣留 → 键级一致 → Keys 写入口 → 推送并发 | **DONE**,均已合入 main |
| 4a / 4b / 4c | 解密后比明文 → per-remote 密码短语 → 转码 | **DONE**(分支 p4a→p4b→p4c 串联,待真机) |
| **4d** | **本文件** | 两字形、`relCanHaveKeys` 收紧、加密键扣留钉字节 |

## Global Constraints

- **两个形态互斥是清单校验保证的**(`mode:"fields"` 不许配 `fileRule`,`mode:"encrypted"` 不许配 `fields`),所以行上最多一枚加密 chip,不需要处理并存。
- **一形一义**:chip 字符串是图标注册表的键(`FATE_CHIP_ICON`),同一个文本配两个图标违反注册表的合同 —— 字段级用**新的 chip 文本**,不复用 `encrypted`。
- **`FateInput.encrypted` 的既有含义不动**(= 整份;`Files` 的 diff 抑制与 `keysRowModel` 都读它),字段级另加一个输入,不把布尔改三态 —— 改三态要动的每一处恰好都只关心整份。
- 三绿,lint 基线 0 error / 57 warn。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/keyWithholding.ts`(改) | `relCanHaveKeys` 拒绝整份加密的组 |
| `src/ui/fateModel.ts`(改) | `FateInput.encryptedKeys` + chip |
| `src/ui/fateChipIcons.ts`(改) | 新 chip → `key-round` |
| `src/ui/SyncCenterView.ts`(改) | 三处 FateInput 构造 + lockedFate 的 chip |
| 测试 | `tests/keyWithholding.test.ts`、`tests/fateModel.test.ts`、`tests/fateChipIcons.test.ts`、`tests/core.test.ts` |

---

### Task 1:关上那道闸

**Files:**
- Modify: `src/core/keyWithholding.ts`(`relCanHaveKeys`)
- Test: `tests/keyWithholding.test.ts`

一个整份加密的项没有键可言:它的 store 副本是一个信封,信封恰好也是 JSON,于是 `.json` 后缀这道判据放它通过 —— 而 `overlayWithheld` 拿到它会去合并 salt/iv/ct。面板从不提供入口,所以今天**造不出**这样的规则;但闸门的意义正是防住不该来的来路(另一个 build、手编的 data.json)。

- [ ] **Step 1: 写失败测试** —— 一个 `mode:"encrypted"` 的 `.json` 文件组,`withheldPatternPredicate` / `unexchangedPatternPredicate` 对它的 rel 恒答空,即使 items 里有它的键规则;`fileRule.encrypted` 同理;字段级(`mode:"fields"` 带 encrypted 字段)照旧放行。
- [ ] **Step 2: 实现** —— `relCanHaveKeys` 加 `isWholeFileEncrypted(group)` 拒绝(import 自 `modes.ts`,注释写明信封也是 JSON 这件事)。
- [ ] **Step 3** 全绿。

```bash
git add src/core/keyWithholding.ts tests/keyWithholding.test.ts
git commit -m "fix(core): an envelope is JSON too — a whole-file-encrypted item can carry no key rule"
```

---

### Task 2:两个字形

**Files:**
- Modify: `src/ui/fateModel.ts`、`src/ui/fateChipIcons.ts`、`src/ui/SyncCenterView.ts`
- Test: `tests/fateModel.test.ts`、`tests/fateChipIcons.test.ts`

**Interfaces:**
```ts
// FateInput 新增(encrypted 保持 = 整份):
encryptedKeys: boolean;   // mode:"fields" 且至少一个字段 encrypted — store 副本是明文 JSON,个别值是密文
// buildChips:整份 → "encrypted"(lock,照旧);字段级 → "encrypted keys"(key-round)
```

**chip 文本 `encrypted keys` 是新造的文案,要你点头。** 不能复用 `encrypted`:chip 字符串就是图标注册表的键,一文两图违反「一形一义」。

- [ ] **Step 1: 写失败测试** —— fateModel:`encryptedKeys: true` 出 `encrypted keys` chip、两者互斥时各出各的;fateChipIcons:注册表含 `"encrypted keys": "key-round"`,并过既有的碰撞守卫(`key-round` 已被 remote 状态徽章用作 locked —— 同义,锁类家族)。
- [ ] **Step 2: 实现** —— 三处 FateInput 构造补 `encryptedKeys: groupNeedsPassphrase(g) && !isWholeFileEncrypted(g)`;`lockedFate` 的 chips 参数化(锁住的字段级项行上也该是 `encrypted keys`)。
- [ ] **Step 3** 全绿,设备关系下无加密与整份加密的行逐像素不变。

```bash
git add src/ui tests/fateModel.test.ts tests/fateChipIcons.test.ts
git commit -m "feat(panel): the two shapes of encryption wear two glyphs"
```

---

### Task 3:加密键的扣留,钉住字节

**Files:**
- Test only: `tests/core.test.ts`(新 describe)

两种密码情形各一条,断言的都是**字节**(验收 17 的单测版):

- **同密码**:字段级项、`token` 键 `Neither way`,push —— 对面文档里 `token` 的信封**逐字节**是对面原有那串;其余键更新。
- **异密码**(4c 的转码 + 扣留同场):同上加 `transcode` 钩子 —— 对面 `token` 信封仍逐字节原封(它本来就是对面密钥封的,转码复用返回它),其余键换成对面密钥能解开的新信封。

- [ ] **Step 1: 写测试**(若发现行为不符则这是 4c 的 bug,按 systematic-debugging 走,不改测试迁就实现)。
- [ ] **Step 2** 全绿。

```bash
git add tests/core.test.ts
git commit -m "test: a withheld encrypted key keeps the other side's envelope, byte for byte"
```

---

### Task 4:文档追平

- [ ] DESIGN:两字形那句从「待 4d」改为现状(chip 文本、图标、互斥)。
- [ ] GUIDE:状态表/字段规则一节补一句两形态的标记区分。
- [ ] ARCHITECTURE:`relCanHaveKeys` 条目补拒绝整份加密及理由。
- [ ] CHANGELOG。

```bash
git add docs CHANGELOG.md && git commit -m "docs: the two shapes of encryption, told apart"
```

---

### Task 5:真机冒烟(与 4a/4b/4c 同一轮,等 dev vault 注册)

- [ ] 验收 6:字段级加密项 Keys 区列出键名;解锁时判得出一致/差异,未解锁时 `Can't compare`。
- [ ] 验收 7:整份加密项没有 Keys 区,照实说明。
- [ ] 验收 17:扣留的加密键推送后去对面核对原封未动。
- [ ] 行上字形:字段级 `key-round`、整份 `lock`,悬停文案各自成立。

## 完成标准

- 三绿;`relCanHaveKeys` 的拒绝有测试;两 chip 的注册与互斥有测试;两条字节断言全绿。
- 2.25.0 的代码面就此**收口** —— 之后只剩真机冒烟与 cut。
