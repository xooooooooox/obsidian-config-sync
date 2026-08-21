# 2.25.0 · Plan 4b:每个 remote 一份密码短语 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 今天整个 vault 只有一个密码短语。一个 remote 是**另一个 vault 的 store**,它的密文可能是用另一个密码加的,而我们照搬密文。后果不是「看不懂」这么轻:拉进来的密文用本地密码解不开,要等到下一次 apply 才炸,离现场很远。本轮给每个 remote 一份**可选的**密码短语(留空 = 与本地同一个,今天唯一存在的情形,纯增量),让比较用对面的密钥去开对面那份,并把 4a 那个笼统的「无法比对」拆成三种照实的说法。

**Architecture:** 三件事,一条线。**取值**照 `resolveGitToken` 那套(`data.json` 只存钥匙串条目名,值永远不进 `data.json`),但缺失**不是错误**:没配就是「和本地同一个」。**比较**从此两侧各用各的密钥,于是 `cannot` 有了三种原因,而原因决定文案与入口。**运行**在本轮只做安全的一半:一个配了自己密码的 remote,**暂不交换任何带密文的项** —— 逐项跳过并说明,绝不把一份注定打不开的密文写进任何一侧的 store。转码(让它们真的能travel)是 4c。

**Tech Stack:** TypeScript(strict)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §3.9(取值、失败模式 3.9.2)、§3.8 的三种「无法比对」说法、§5.7 的 `Passphrase` 表单行。验收 16、18 条。

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b / 3c / 3d / 3e / 3f | 数据模型 → 统一面板 → 逐项方向 → 派生 lock → 逐键扣留 → 键级一致 → Keys 写入口 → 推送并发 | **DONE**,均已合入 main |
| 4a | 解密后比明文 + 「无法比对」+ `Can't compare` 桶 | **DONE**,分支 `remote-direction-p4a` 9 提交,待真机 |
| **4b** | **本文件** | 每个 remote 一份密码短语、三种说法、失败跳过不写脏 |
| 4c | 转码:两侧各用各的密码重新加密 + 信封复用(3.9.1)+ 指纹跟着走 | 未开始 |
| 4d | 字段级加密的 Keys 区、`relCanHaveKeys` 收紧、加密键扣留、`key-round`/`lock` 两字形 | 未开始 |

> **与 4a 计划里写的 4b/4c 边界不同,原因写在这里。** 4a 把「失败跳过不写脏(3.9.2)」划给了 4c。那样切会留下一个真实的坏窗口:4b 上线之后用户就能给 remote 配一个不同的密码,而运行侧还在照搬密文 —— 一次 pull 就把永远解不开的东西写进自己的 store。所以**安全的一半跟着表单走**,能力的一半(转码)留给 4c。仓库的规矩本来就是这条:不许留下一个能被配出来的坏状态。

## Global Constraints

- **留空 = 与本地同一个密码。** 这是整条设计的关键,也是「纯增量」的全部含义:今天两个 vault 共用一个密码的情形走的还是原路,一个字节都不变。只有显式配了一个不同的密码,新路径才被激活。
- **密码值绝不进 `data.json`。** 与 `tokenId` 同型:只存钥匙串条目名;同款保留名守卫(不得选中本地密码那个 `config-sync-passphrase`)。
- **`passphraseId` 已经存在**(Plan 1 落的 schema 与 `validateRemotes`),本轮**不动 schema**,只是第一次真的去读它。
- **一个配了自己密码的 remote,本轮不交换带密文的项。** 逐项跳过 + 报告里说明,而不是整次运行失败:能拉的都拉,能推的都推。
- **「没试过就不下结论」**(spec 3.8 末段):对面还没有这一项的副本时,不说任何跟密码有关的话。
- **入口跟着原因走**:本机未解锁 → Settings → General;这个 remote 没配 / 配错 → Settings → Remotes 的那一行。一句说明配一个去不到正确位置的链接,比没有链接更糟。
- 三绿:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`。**基线注意**:4a 之后是 0 error / **58** warn(多出来的那条是 `ui/sentence-case` 挑剔定稿文案 `Set it in Settings → General`)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/remotePassphrase.ts`(新建) | 取值:钥匙串条目名 → 这个 remote 的密码,缺失回落本地 |
| `src/core/cipherCompare.ts`(改) | `cannot` 带上**哪一侧**打不开 |
| `src/core/itemCompare.ts`(改) | 把它汇总成一项的原因 |
| `src/core/status.ts`(改) | `RemoteCheck.uncomparable` 从 ref 列表变成 ref → 原因 |
| `src/core/ConfigSyncCore.ts`(改) | 拉/推:带密文的项在异密码 remote 上跳过并说明 |
| `src/ui/SettingTab.ts`(改) | spec 5.7 的 `Passphrase` 行(**在类型分支之外**) |
| `src/ui/SyncCenterView.ts`(改) | 三种说法 + 两个入口 |
| `src/main.ts`(改) | 两处 wiring 的 `passphrase.theirs` 换来源 |
| 测试 | `tests/remotePassphrase.test.ts`(新)、`tests/cipherCompare.test.ts`、`tests/itemCompare.test.ts`、`tests/encryptedRemote.test.ts`、`tests/core.test.ts` |

---

### Task 1:取值 —— 缺失不是错误

**Files:**
- Create: `src/core/remotePassphrase.ts`
- Test: `tests/remotePassphrase.test.ts`(新建)

**Interfaces:**
- Produces:
  ```ts
  // 这个 remote 的 store 该用哪个密码开。`passphraseId` 没配 = 与本地同一个(spec 3.9 的默认值)。
  // 配了但这台设备没有那个条目,是一个要报的状态,不是一个可以糊过去的 null。
  export type RemoteKey =
    | { kind: "same-as-local"; passphrase: string | null }
    | { kind: "own"; passphrase: string }
    | { kind: "missing"; secretId: string };

  export function resolveRemotePassphrase(
    storage: { getSecret(id: string): string | null },
    remote: Remote,
    local: string | null
  ): RemoteKey;
  ```

**为什么不照抄 `resolveGitToken` 的抛错:** token 缺失时**没有别的路可走**,所以它抛。密码短语缺失时有一条完全正常的路 —— 用本地那份 —— 而它正是今天所有人走的那条。把「没配」抛成错误会让每一个从不加密的 vault 突然开始报错。

- [ ] **Step 1: 写失败测试** —— `tests/remotePassphrase.test.ts`:没配 → `same-as-local` 且带上本地那份(含本地也没有时的 `null`);配了且钥匙串有 → `own`;配了但钥匙串没有 → `missing` 带上条目名;空字符串的 secret 与没有等价(照 `resolveGitToken` 对 `""` 的处理)。
- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run tests/remotePassphrase.test.ts`。
- [ ] **Step 3: 实现**,叶子模块,只 import `types`。
- [ ] **Step 4** 全绿。

```bash
git add src/core/remotePassphrase.ts tests/remotePassphrase.test.ts
git commit -m "feat(core): which passphrase opens a remote's copy, with the old answer as the default"
```

---

### Task 2:`cannot` 说清是哪一侧

**Files:**
- Modify: `src/core/cipherCompare.ts`、`src/core/itemCompare.ts`、`src/core/status.ts`
- Test: `tests/cipherCompare.test.ts`、`tests/itemCompare.test.ts`、`tests/status.test.ts`

**Interfaces:**
- Changed:
  ```ts
  // 4a 的三态里,第三态从「不知道」升级成「不知道,而且知道是为什么」。
  export type ContentVerdict = "same" | "differs" | { cannot: "here" | "there" };

  // ref → 原因。`here` = 本机没有(或不对)那份密码;`there` = 这个 remote 那份打不开。
  // 至于「打不开」是因为没配还是配错,由 RemoteKey 说了算 —— 那是设置的事实,不是比较的发现。
  uncomparable: Record<string, UncomparableReason>;
  ```

**三种说法怎么来:** 比较只答**哪一侧**;`RemoteKey` 答**为什么**。两者相乘正好是 spec 3.8 要的三句,而且没有一句是猜的:

| 哪一侧 | `RemoteKey` | 说法 | 入口 |
|---|---|---|---|
| `here` | 任意 | `Encrypted — set the passphrase in settings to compare`(4a 已定稿) | Settings → General |
| `there` | `same-as-local` | `<remote>'s copy is encrypted with a different passphrase.` | Settings → Remotes |
| `there` | `own` / `missing` | `The passphrase saved for <remote> doesn't open its copy.` | Settings → Remotes |

**`missing` 单独一句吗?不。** 「配了个名字但这台设备没有这个条目」在**比较**这一侧的后果与「配错」完全一样:打不开。而它自己的说法已经在 Settings 那一行的状态里写着了(`⚠ 这台设备还没有这个条目`),照 token 今天的做法。同一件事说两遍,一遍在它该在的地方就够。

- [ ] **Step 1: 写失败测试** —— `cipherCompare`:本机密码错 → `{cannot:"here"}`,对面密码错 → `{cannot:"there"}`,两边都错 → `here`(先答自己那一侧:让用户先解决自己能解决的);`itemCompare`:多个文件里 `here` 压过 `there`,`differs` 仍压过两者;`status`:`uncomparable` 是一张表而不是列表。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**。`ContentVerdict` 从字符串联合变成带载荷的联合,所有 `=== "cannot"` 的判断跟着改;`remoteRowStatuses` 的 `uncomparable` 收 `ReadonlySet<string>` 或表的键 —— 行状态不关心原因,只有卡片关心。
- [ ] **Step 4** 全绿。

```bash
git add src/core tests
git commit -m "fix(core): an unreadable copy says which side could not be opened"
```

---

### Task 3:Settings 的 `Passphrase` 行

**Files:**
- Modify: `src/ui/SettingTab.ts`
- Test: 无新增(这一行是 Obsidian 自己的 `SecretComponent`;可测的部分 —— 保留名守卫与草稿落盘 —— 由 `settingtab-commit.test.ts` 的既有形状覆盖)

**长相(spec 5.7,一字不差):** 与 `Access token` **完全同一个控件**(Obsidian 的密钥选择器:链接或新建、掩码显示、✕ 解除链接),下面挂同款**条件**状态行:

- `✓ Passphrase stored on this device.`
- `⚠ This remote uses a passphrase named "<id>", which this device doesn't have yet — link it here once.`
- 留空时**整行不渲染**(与 token 同)。

标签就叫 `Passphrase`,与 General 里那个同名 —— 它在 remote 编辑器里,归属不会误解。说明进悬停:`Only if this remote's vault uses a different passphrase than yours. Leave empty when they match.`

- [ ] **Step 1** 把这一行放在**类型分支之外**(今天 `Access token` 在 git 那一支里,和 URL/Branch/Store folder 并排)。**一个 vault 型 remote 的 store 一样可以是加密的**,所以密码短语对两种类型都成立;放进 git 分支是本轮最容易犯的错。
- [ ] **Step 2** 同款保留名守卫:选中 `PASSPHRASE_SECRET_ID` 时弹 `Config Sync's own vault passphrase is stored under that name — pick or create a different secret for this remote.` 并把选择器放回去(照 token 的原样)。
- [ ] **Step 3** `toDraft`/`fromDraft` 已经带 `passphraseId`(Plan 1 落的),确认落盘与清空(空串 = 不写这个字段)。
- [ ] **Step 4** 保存后与 token 同样的一对:`clearReaderCache()` + `refreshRemoteChecks()` —— 改了密码,比较结果当场就该变。

```bash
git add src/ui/SettingTab.ts
git commit -m "feat(settings): a remote whose vault uses its own passphrase"
```

---

### Task 4:三种说法与两个入口

**Files:**
- Modify: `src/ui/SyncCenterView.ts`、`src/ui/panelModel.ts`(文案的纯函数)
- Test: `tests/panelModel.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // 卡片 State 行的那一句,由「哪一侧 + 这个 remote 配了什么」决定。纯函数,可单测,文案即终稿。
  export function uncomparableClause(input: { side: "here" | "there"; remote: string }): string;
  ```

- [ ] **Step 1: 写失败测试** —— 三句逐字。
- [ ] **Step 2: 实现**,卡片 State 行按 `uncomparable` 表里的原因取句子。
- [ ] **Step 3** 入口分流:`here` 走 4a 建好的 `openSettingsGeneral(PASSPHRASE_ANCHOR_ID)`;`there` 需要一条**新的**深链 —— Settings → Remotes,落在这个 remote 的那一行。照 4a 那条的形状加(`openSettingsRemote(name)`),锚点用 remote 的名字。
- [ ] **Step 4** 行的句子:`there` 那两种在**行上**仍然是 4a 那一句吗?**不是。** 行上那句 `Encrypted — set the passphrase in settings to compare` 说的是本机没解锁;对面打不开时行上该说 `Can't read this remote's copy`。两句都进 `relationCopy` 的邻居,不写死在渲染里。

```bash
git add src/ui tests/panelModel.test.ts
git commit -m "feat(panel): three ways a copy stays unreadable, said apart"
```

---

### Task 5:异密码时不交换密文,并说明

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`(`planImport` / `pushExternal`)、`src/main.ts`
- Test: `tests/core.test.ts`

**规则,一句话:** 一个 remote 的 `RemoteKey` 不是 `same-as-local` 时,**带密文的项(`groupHasCiphertext`)不参与这次运行** —— 两个方向都是。它们的 rel 在计划阶段就被摘出去,报告里各占一行。

**为什么是「不交换」而不是「试着交换」:** 两端用不同的密码时,照搬密文**按构造就是错的** —— 不需要先解一遍才知道。等到 4c 真的会转码了,这条限制随之解除,而在那之前它是唯一诚实的行为。

**报告文案(要你点头,这是新造的一句):**

> `Skipped — <remote> keeps its own passphrase, so this item's encrypted contents can't travel between the two. Nothing was written.`

- [ ] **Step 1: 写失败测试** —— `tests/core.test.ts`:配了不同密码的 remote,一次 pull:加密项**字节不变**、非加密项照常拉进来、报告里那一项单列一行;push 同理,对面那份加密文件字节不变。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** —— 计划阶段摘除,不是写盘阶段跳过(3f 立下的规矩:落盘之前所有决定都已经做完)。
- [ ] **Step 4** 全绿。

```bash
git add src/core src/main.ts tests/core.test.ts
git commit -m "fix(transport): a copy the other end could never open is not sent"
```

---

### Task 6:真机冒烟

**Files:** 无(验证任务)

对应 spec 验收第 16、18 条。**前置**:`dev/vault` 要先在 Obsidian 里注册(只有 owner 能做),4a 的 Task 7 同样卡在这里 —— 两轮一起验。

- [ ] **Step 1** 给 `remote-vault2` 那份 store 用**另一个密码**重新捕获一个加密项(最省事:在第二个 dev vault 里设另一个密码再捕获)。
- [ ] **Step 2 没配**:面板上那一项读 `Can't compare`,卡片说 `<remote>'s copy is encrypted with a different passphrase.`,入口跳到 Settings → Remotes 的那一行。
- [ ] **Step 3 配对**:在那一行链上正确的密码 → 该项立刻能判出一致/有差异。
- [ ] **Step 4 配错**:链一个错的 → 卡片说 `The passphrase saved for <remote> doesn't open its copy.`
- [ ] **Step 5 拉取不写脏**(验收 16):配着不同密码时拉一次 —— 那一项**字节不变**,报告里单列一行,其余项照常拉进来。
- [ ] **Step 6 对面没有副本**(验收 18):删掉对面那一项再刷新 —— 行上**没有**任何密码字样,是一条普通的待推行。

---

### Task 7:文档追平

- [ ] `docs/ARCHITECTURE.md`:新增 `core/remotePassphrase.ts` 一条(为什么缺失不是错误);`ContentVerdict` 那条改成带载荷的三态;运行侧那条限制写清楚**它是暂时的**以及**它为什么必须先于表单存在**。
- [ ] `docs/GUIDE.md`:加密一节补一段 —— 两个 vault 用不同密码时怎么配、配了之后比较会怎样、以及**在能转码之前那些项不会交换**。
- [ ] `docs/design/DESIGN.md`:`Passphrase` 行(5.7)与三种说法的分流。
- [ ] `CHANGELOG.md`。

```bash
git add docs CHANGELOG.md
git commit -m "docs: a remote whose vault keeps its own passphrase"
```

---

## 完成标准

- 三绿,lint 不超 4a 之后的基线(0 error / 58 warn)。
- **留空的 remote 一个字节都没变**:既有的加密项测试一条未改。
- **三种说法各有一条单测**,逐字。
- **配了不同密码之后不会写脏**:Task 5 的两条(pull / push 各一),断言的是**字节不变**,不是报告里说了什么。
- Task 6 的六步真机全过(与 4a 的 Task 7 同一轮)。

## 交给 4c / 4d 的边界

- **转码整块**:拉取用对面的密码解、用本地的重新加密,推送反过来;信封复用(3.9.1 —— 不做的话每次推送都重写每一个加密项,git 历史每次被搅一遍);派生 lock 的指纹要按**实际发出去的字节**算(3b 的 `rewrittenHashes` 已经是这条路)。4c 落地时 Task 5 那条限制**整条删除**,连同它的文案。
- **密钥派生缓存**(3.9.3):转码之后两侧的盐一起挤 `derivedKeyCache` 那一个 256 条的表,而写侧每次都是新盐、跨运行无法缓存。4c 实测,必要时上调容量或改 LRU。
- **字段级加密的逐键扣留**在异密码下要过一遍明文(同密码时搬密文串就够),归 4d。
