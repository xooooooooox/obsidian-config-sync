# 2.25.0 · Plan 4a:加密项能被比较了 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 加密项在 remote 面板上**永远显示有差异** —— 每份密文自带随机盐,同一段明文在两个 vault 里加出来的字节必然不同,而文件级 diff 比的是字节。3.3 要消灭的常亮态,今天就活在每一个加密项上。本轮把比较的对象从密文换成**解密后的明文**,并给这类项补上第三种答案:**无法比对**(本机没有密码短语),照实说明,不下差异结论。

**Architecture:** 「两份 store 副本是不是同一份内容」今天有两个答案(相同 / 不同),本轮变成三个,而第三个不是「不同」的一种 —— 它是**我们不知道**。三态一路走到面板:`checkRemote` 不给这类项判方向,`diffRemote` 不给它列文件,行落进 `Can't compare` 桶。新增两个模块:`core/cipherCompare.ts`(叶子,只认密文与 JSON)和 `core/itemCompare.ts`(按项走 rel,吐三态)。后者是 `keyWithholding.ts` 里 `storeItemsAgree` 的新家 —— 它从来就不是关于扣留键的,它是关于两份副本,3.8 之后还要懂密文,再留在原地就是两个概念挤一个文件。

**Tech Stack:** TypeScript(strict)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §3.8 前半(比较)、§5.1 的 `Can't compare` 桶。验收 6、7、18 条。

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 / 2a / 2b / 2c / 3a / 3b / 3c / 3d / 3e / 3f | 数据模型 → 统一面板 → 逐项方向 → 派生 lock → 逐键扣留 → 键级一致 → Keys 写入口 → 推送并发 | **DONE**,均已合入 main |
| **4a** | **本文件** | 比较解密后的明文 + 「无法比对」+ `Can't compare` 桶(3.8 比较半) |
| 4b | 每个 remote 一份密码短语:Settings 的 `Passphrase` 行(5.7)、取值接缝落到实处、另外两种「无法比对」的说法(没配 / 配错) | 未开始 |
| 4c | 转码:拉取/推送两侧各用各的密码、信封复用(3.9.1)、失败跳过不写脏(3.9.2) | 未开始 |
| 4d | 字段级加密的 Keys 区(键名是明文)、`relCanHaveKeys` 收紧到不认整份加密、加密键的扣留、行上 `key-round` / `lock` 两字形 | 未开始 |

## Global Constraints

- **「无法比对」不是「有差异」。** 这是本轮唯一有意义的承诺。今天这类项恒显差异,是在陈述一件我们并不知道的事;换成一条照实的说明,信息量是增加的,不是减少的。
- **对面还没有这一项的副本,不说任何跟密码有关的话**(spec 3.8 末段,验收 18)。一侧为空是一条普通的待推行,密码对不对只有真的试过才知道。
- **设备关系一个像素都不许变。** `locked` 这个 GroupState、它的句子、它今天落进 `none` 的计数位置,全部原样保留;本轮只在 **remote 关系**下给它自己的桶和自己的词。
- **本机密码为 null 时不弹密码框**(验收 6)。比较是后台刷新触发的,不是用户按下的按钮。
- **4a 两侧用同一个密码。** 「留空 = 与本地同一个密码」是 3.9 的默认值,也是今天唯一存在的情形。接缝(`passphrase: { mine, theirs }`)本轮就建好,4b 只把 `theirs` 换个来源。
- **不改任何持久化形状。** 没有新 schema、没有 lock 字段、没有 store 文件。加密项今天就不写指纹(`storeContentIsHashable`),本轮不去改它 —— 明文指纹进账本等于给小值的字典攻击开门(3.8 末段)。
- 三绿基线:`npx tsc --noEmit`、`npx vitest run`、`npx eslint .`(不超基线 0 error / 57 warn)。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/cipherCompare.ts`(新建) | 两份 store 副本的三态比较,懂整份信封与字段级密文 |
| `src/core/itemCompare.ts`(新建) | 按项走它的 rel,合成一项的三态;`storeItemsAgree` 迁入并升级 |
| `src/core/keyWithholding.ts`(改) | 迁出 `storeItemsAgree`,其余不动 |
| `src/core/modes.ts`(改) | 导出 `groupHasCiphertext`,让「哪些项带密文」只有一个说法 |
| `src/core/status.ts`(改) | `checkRemote` 的 `keyRuled` 升级成 `content`;`RemoteCheck` 加 `uncomparable`;`diffRemote` 的比较改成三态 |
| `src/core/ConfigSyncCore.ts`(改) | `storeContentIsHashable` 改用 `groupHasCiphertext` |
| `src/core/remoteRows.ts`(改) | 无法比对的 ref → 行状态 `locked` |
| `src/ui/panelModel.ts`(改) | `relationCopy` 给 `locked` 一个词;计数把 `locked` 从 `none` 里拆出来 |
| `src/ui/SyncCenterView.ts`(改) | remote 关系的 locked 行、筛选药丸、卡片 `State` 那句 |
| `src/main.ts`(改) | 两处 wiring:`content.compare` 与 `diffRemote` 的密码 |
| 测试 | `tests/cipherCompare.test.ts`(新)、`tests/itemCompare.test.ts`(新)、`tests/status.test.ts`、`tests/remoteRows.test.ts`、`tests/panelModel.test.ts`、`tests/keyWithholding.test.ts`(迁移后仍绿) |

---

### Task 1:「哪些项带密文」只留一个说法

**Files:**
- Modify: `src/core/modes.ts`、`src/core/ConfigSyncCore.ts`
- Test: `tests/modes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // store 副本里有密文:整份信封(mode:"encrypted" 或 Plain 模式的 fileRule),或某些字段是密文。
  export function groupHasCiphertext(group: SyncGroup): boolean;
  ```

**为什么先做这一件:** 今天 `ConfigSyncCore.storeContentIsHashable` 写的是 `!groupNeedsPassphrase(group) && !isWholeFileEncrypted(group)`,而本轮要在三个新地方问同一个问题。抄第四遍就会出现「记账本认为它带密文、比较认为它不带」的那天。

- [ ] **Step 1** `modes.ts` 新增 `groupHasCiphertext = (g) => groupNeedsPassphrase(g) || isWholeFileEncrypted(g)`,注释写明它与 `storeContentIsHashable` 是同一枚硬币。
- [ ] **Step 2** `ConfigSyncCore.storeContentIsHashable` 改成 `return !groupHasCiphertext(group);`,行为不变。
- [ ] **Step 3** `tests/modes.test.ts` 补三条:`mode:"encrypted"`、`fields` 里有一个 `encrypted:true`、Plain 模式 `fileRule.encrypted` —— 三种都为 true;纯 Plain 与纯 `fields` 无加密为 false。
- [ ] **Step 4** `npx vitest run tests/modes.test.ts tests/core.test.ts` 全绿。

```bash
git add src/core/modes.ts src/core/ConfigSyncCore.ts tests/modes.test.ts
git commit -m "refactor(core): whether an item's copy holds ciphertext has one answer"
```

---

### Task 2:两份副本的第三种答案

**Files:**
- Create: `src/core/cipherCompare.ts`
- Test: `tests/cipherCompare.test.ts`(新建)

**Interfaces:**
- Produces:
  ```ts
  export type ContentVerdict = "same" | "differs" | "cannot";

  export async function compareCopies(input: {
    mine: string | null;      // 本机 store 里那份的内容;null = 本机没有
    theirs: string | null;    // 对面那份;null = 对面没有
    passphrase: { mine: string | null; theirs: string | null };
    masked: readonly string[]; // 两边都不流动的键,比之前先抹掉(3.3)
    groupName: string;         // 只进错误消息
  }): Promise<ContentVerdict>;
  ```

**判定顺序,照这个次序写:**

| # | 条件 | 答 | 为什么 |
|---|---|---|---|
| 1 | 任一侧为 `null` | 两侧都 null → `same`,否则 `differs` | 一侧没有副本是一条普通的待推/待拉行,与密码无关(验收 18) |
| 2 | 字节相同 | `same` | 同一份 store 的两台设备就是这样,一次解密都不必付 |
| 3 | 两侧都不含密文 | 交给 `sameApartFromWithheld` | 今天的路,`cannot` 在这条路上永不出现 |
| 4 | 一侧含密文、另一侧不含 | `differs` | 形态不同就是内容不同,不去猜「它解开之后也许一样」 |
| 5 | 两侧都是整份信封 | 见下 | |
| 6 | 两侧都是带密文字段的 JSON | 见下 | |
| 7 | 任一侧解不开 | `cannot` | |

**整份信封:** 先用**对面的**密码解对面那份;解不开 → `cannot`。再用**本机的**密码,拿本机那份信封对刚得到的明文做一次 mac 比对(`fileUnchanged`):对得上 → `same`。对不上有两个可能 —— 内容真变了,或者本机的密码不对 —— 所以再解一次本机那份来分辨:解不开 → `cannot`,解开了 → `differs`。**稳态(两边一致)只付一次解密加一次 hmac**,而 hmac 本来就是为这种确定性比较存在的。

> **与 spec 3.8 的措辞有一处出入,写在这里备案:** spec 说「不必逐字节较真密文,信封里的 HMAC 让比对是确定性的」。HMAC 确实解决了确定性,但它分辨不了「密码不对」与「内容变了」—— 而这个分辨正是 3.8 自己要的第三态。所以 mac 只用作**快路径**,答不上来时落回真解密。spec 的意图(确定性比较、不比密文字节)完全保留。

**字段级:** 两侧都 `JSON.parse`,任一侧不是 JSON → `differs`(第 4 条同理:形态对不上)。先按 `masked` 抹掉两边不流动的键(`sanitizeJson`),再把每一个 `enc:v1:` 叶子换成它的明文;**任一侧任一个叶子解不开 → `cannot`**。最后 `sortKeysDeep` 后比较字符串。两侧各用各的密码,一次都不要拿本机的密码去解对面那份。

- [ ] **Step 1: 写失败测试** —— 新建 `tests/cipherCompare.test.ts`。用真 WebCrypto(vitest 跑在 Node ≥18,`tests/fileEncrypt.test.ts` 已是这么做的),不要 mock 掉 crypto,本轮唯一要证的就是真信封的行为。

```ts
describe("compareCopies", () => {
  it("calls two encryptions of the same plaintext the same content", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"x"}\n');
    expect(a).not.toEqual(b); // 随机盐:字节本来就不同,这正是今天常亮的根
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("same");
  });

  it("says it cannot compare when this device has no passphrase", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"y"}\n');
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("cannot");
  });

  it("still reports a real difference once both sides open", async () => {
    const a = await encryptFile("pw", '{"token":"x"}\n');
    const b = await encryptFile("pw", '{"token":"y"}\n');
    expect(await compareCopies({ mine: a, theirs: b, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("differs");
  });

  it("compares encrypted FIELDS by their plaintext", async () => {
    const mine = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", token: await encryptField("pw", "s3cret") }, null, 2) + "\n";
    expect(mine).not.toEqual(theirs);
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "pw", theirs: "pw" }, masked: [], groupName: "g" })).toBe("same");
  });

  it("masks the keys that travel neither way before deciding", async () => {
    const mine = JSON.stringify({ theme: "dark", local: 1, token: await encryptField("pw", "s") }, null, 2) + "\n";
    const theirs = JSON.stringify({ theme: "dark", local: 999, token: await encryptField("pw", "s") }, null, 2) + "\n";
    expect(await compareCopies({ mine, theirs, passphrase: { mine: "pw", theirs: "pw" }, masked: ["local"], groupName: "g" })).toBe("same");
  });

  it("says nothing about passphrases when the other end has no copy yet", async () => {
    const mine = await encryptFile("pw", '{"token":"x"}\n');
    expect(await compareCopies({ mine, theirs: null, passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("differs");
  });

  it("leaves plain items on the byte path — never `cannot`", async () => {
    expect(await compareCopies({ mine: '{"a":1}', theirs: '{"a":2}', passphrase: { mine: null, theirs: null }, masked: [], groupName: "g" })).toBe("differs");
  });
});
```

- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run tests/cipherCompare.test.ts`,Expected: 模块不存在。
- [ ] **Step 3: 实现** `src/core/cipherCompare.ts`,只 import `crypto.ts`、`sanitize.ts`、`merge.ts`、`keyWithholding.ts`(`sameApartFromWithheld`)。不 import `ConfigSyncCore`、不 import `status`,保持叶子。
- [ ] **Step 4** `npx vitest run tests/cipherCompare.test.ts` 全绿。

```bash
git add src/core/cipherCompare.ts tests/cipherCompare.test.ts
git commit -m "feat(core): two copies of an encrypted item are compared by what they say"
```

---

### Task 3:一项的答案,由它的每个文件合成

**Files:**
- Create: `src/core/itemCompare.ts`
- Modify: `src/core/keyWithholding.ts`(迁出 `storeItemsAgree`)
- Test: `tests/itemCompare.test.ts`(新建)、`tests/keyWithholding.test.ts`(迁移后仍绿)

**Interfaces:**
- Produces:
  ```ts
  // 两条 lock 条目判不了的项:有键规则的(指纹按设计对不上),或带密文的(根本没有指纹)。
  export function refsNeedingContentCompare(input: { groups: readonly SyncGroup[]; items: RemoteItems | undefined }): string[];

  export async function compareStoreItem(input: {
    io: { exists(path: string): Promise<boolean>; read(path: string): Promise<string> };
    rootPath: string;
    reader: { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> };
    groups: readonly SyncGroup[];
    ref: string;
    masked: (rel: string) => string[];
    passphrase: { mine: string | null; theirs: string | null };
  }): Promise<ContentVerdict>;
  ```
  `storeItemsAgree` 不再存在;`keyWithholding.ts` 保留 `sameApartFromWithheld` / `overlayWithheld` / 两个 predicate / `refsWithKeyRules`。

**这一项有哪些 rel:**

- **file 项**:base 加两个分设备类附属文件(今天 `storeItemsAgree` 就是这三个)。
- **folder 项**:两侧 `store/<storePath>/` 前缀下 rel 的**并集**。今天这里直接 `return true` —— 因为文件夹项不可能有键规则。但 `mode:"encrypted"` 没有被限制在 file 项上(`manifest.ts` 只把 `fields` 和 `fileRule` 限制住了),所以一个整份加密的**文件夹**项是能存在的,而它正是本轮要救的那类。

**合成规则:`differs` 压过 `cannot`。** 一个文件明明白白不一样、另一个文件看不懂时,整项答 `differs`:我们已经知道有东西要动了,不必因为看不懂另一个文件就把整项降级成「不知道」。只有**没有任何一个文件判出差异、而至少一个文件看不懂**时,整项才是 `cannot`。

- [ ] **Step 1: 写失败测试** —— 新建 `tests/itemCompare.test.ts`,用 `tests/memfs.ts` 与既有的 fake reader。至少五条:
  - 一个整份加密的 file 项,两侧同明文不同密文 → `same`(今天这条会是 `differs`,就是常亮那个 bug);
  - 同上但本机无密码 → `cannot`;
  - 一个字段级加密的 file 项,base 一致而 desktop 附属文件里那个加密字段不同 → `differs`;
  - 一个整份加密的 folder 项,两侧文件名相同、密文不同、明文相同 → `same`;
  - 一个 file 项:base 看不懂、desktop 附属文件明白白不同 → `differs`(合成规则);
  - `refsNeedingContentCompare` 把「有键规则的」与「带密文的」并起来、不重复。
- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run tests/itemCompare.test.ts`。
- [ ] **Step 3: 实现** —— 从 `keyWithholding.ts` 迁出 `storeItemsAgree`,改名 `compareStoreItem`,返回值从 `boolean` 换成 `ContentVerdict`,rel 列表按上表分两种项算,每个 rel 交给 `compareCopies`。
- [ ] **Step 4** `npx vitest run tests/itemCompare.test.ts tests/keyWithholding.test.ts` 全绿。

```bash
git add src/core/itemCompare.ts src/core/keyWithholding.ts tests/itemCompare.test.ts tests/keyWithholding.test.ts
git commit -m "feat(core): an item's two copies answer same, different, or not knowable"
```

---

### Task 4:面板不再替加密项猜方向

**Files:**
- Modify: `src/core/status.ts`(`checkRemote`、`diffRemote`)、`src/core/remoteRows.ts`、`src/main.ts`
- Test: `tests/status.test.ts`、`tests/remoteRows.test.ts`

**Interfaces:**
- Changed:
  ```ts
  // checkRemote 的第四个参数:keyRuled → content。名字要换 —— 它不再只关于键。
  content: {
    refs: readonly string[];
    compare: (ref: string) => Promise<ContentVerdict>;
  }

  export interface RemoteCheck {
    state: RemoteState;
    remoteCapturedAt: string | null;
    items: RemoteItemCounts | null;
    itemVerdicts: Record<string, ItemVerdict> | null;
    uncomparable: string[]; // 本轮判不出的项:既不进 itemVerdicts,也不进 items 的两个计数
  }

  // diffRemote 的 opts 多一个 passphrase;条目多一个可选标记
  export interface RemoteDiffEntry { group: string; files: RemoteDiffFile[]; uncomparable?: true }
  ```

**三态在 `checkRemote` 里的去处:** `same` → 进 `settled`(与今天的键规则项一样,不判方向);`differs` → 什么都不做,照旧走两条 lock 条目的判断(加密项没有指纹,于是按捕获时间判 —— 这正是 spec 3.8 说的「方向退回按捕获时间判」);`cannot` → 进 `uncomparable`,并且**同时**进 `settled`,因为不知道的事不许拿来判方向。

**`RemoteCheck` 每一处构造都要补 `uncomparable: []`** —— `checkRemote` 里四条提前返回、`main.ts` 的 catch 分支各一处。

**`diffRemote`:** `filesMatch` 变成 async 并返回 `ContentVerdict`。`cannot` 时**不给这个文件列行**,而是把它所属的条目标上 `uncomparable: true`。理由与行上那条一样:不知道就不要列一行说「变了」。

**`remoteRowStatuses`:** 多收一个 `uncomparable: readonly string[]`,该 ref 的行状态直接是 `locked`,压过 verdict 与 diff 证据。

**接缝的形状(`main.ts`,两处):**

```ts
const passphrase = { mine: ctx.passphrase, theirs: ctx.passphrase }; // 4b 把 theirs 换成这个 remote 自己的
const check = await checkRemote(localLock, reader, ignore, {
  groups: this.compiledGroups,
  content: {
    refs: refsNeedingContentCompare({ groups: this.compiledGroups, items: remote.items }),
    compare: (ref) => compareStoreItem({ io: ctx.io, rootPath: ctx.rootPath, reader, groups: this.compiledGroups, ref, masked: unexchanged, passphrase }),
  },
});
```

- [ ] **Step 1: 写失败测试** —— `tests/status.test.ts` 的 `describe("checkRemote")` 加三条:`same` 不判方向、`cannot` 既不判方向也进 `uncomparable`、`differs` 仍按捕获时间判;`tests/remoteRows.test.ts` 加一条:ref 在 `uncomparable` 里时行状态是 `locked`,即使 diff 给了它文件。
- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run tests/status.test.ts tests/remoteRows.test.ts`。
- [ ] **Step 3: 实现**(含 `main.ts` 两处 wiring 与全部 `uncomparable: []` 补齐)。
- [ ] **Step 4** `npx vitest run` 全绿,`npx tsc --noEmit` 通过。

```bash
git add src/core/status.ts src/core/remoteRows.ts src/main.ts tests/status.test.ts tests/remoteRows.test.ts
git commit -m "feat(panel): an item nobody can open is not an item with a difference"
```

---

### Task 5:先改 DESIGN,再改界面

**Files:**
- Modify: `docs/design/DESIGN.md`
- 定稿视图:https://claude.ai/code/artifact/95978151-658d-4965-89b5-5ff04e598370(**更新时必须把这个 URL 作为 `url` 参数传进去**,否则会另建一个 artifact)

**规矩,不是流程:** 改持久化形状先改 schema,改界面先改 DESIGN + mockup。本轮不动 schema,但动了三处计数区域和一条卡片行,所以这一步在写界面代码之前。

- [ ] **Step 1** DESIGN.md 补 `Can't compare` 这个桶:它只在 **remote 关系**下出现;词表(5.1)里它是 remote 侧独有的那一格;三处按状态分桶的区域(侧边栏分区计数徽章、筛选药丸行、顶部状态药丸组)各多一格;行的句子**沿用今天 locked 行那句已定稿的英文**(`Encrypted — set the passphrase in settings to compare`),不新造一句。
- [ ] **Step 2** DESIGN.md 补卡片 `State` 行在这个状态下的那句,以及它右边通往 `general-passphrase` 锚点的入口(`settingsDeepLink.ts` 已有这条路)。
- [ ] **Step 3** 更新 mockup:remote 列表里画一条 `Can't compare` 的行、它展开后的卡片(`State` 那句 + 入口,`Files` 区**不画**,因为我们并不知道有什么变了)、以及三处计数区域多出来的那一格。图标手绘 Lucide 线性 SVG,固定深色单主题。
- [ ] **Step 4** 拿定稿视图与 DESIGN 对一遍词,两处一字不差。

```bash
git add docs/design/DESIGN.md
git commit -m "docs(design): the bucket for an item this device cannot open"
```

---

### Task 6:`Can't compare` 在面板上

**Files:**
- Modify: `src/ui/panelModel.ts`、`src/ui/SyncCenterView.ts`
- Test: `tests/panelModel.test.ts`、`tests/panelRelation.test.ts`

**Interfaces:**
- Changed:
  ```ts
  export interface RelationCopy {
    bucket: Record<RowBucket, string>; // FateBucket → RowBucket:多出 locked 这一格
    // …其余不变
    lockedFold: (n: number) => string;
  }

  export interface FateBucketCounts extends BucketCounts { excluded: number; locked: number }
  ```

**词:**

| 位置 | device 关系 | remote 关系 |
|---|---|---|
| 桶 | 与今天一致(`locked` 并进 `No settings yet`) | `Can't compare` |
| 折叠行 | 不变 | `N items can't be compared`(单数 `1 item can't be compared`) |
| 行的句子 | `Encrypted — set the passphrase in settings to compare` | 同左,一字不改 |
| 卡片 `State` | 不变 | `This item is encrypted and this device has no passphrase, so its two copies can't be compared.` + 通往 Settings 的入口 |

**`locked` 从 `none` 里拆出来,但设备关系照旧把两者相加着显示。** `fateBucketCounts` 今天把 `locked` 计进 `none`;拆成两个字段之后,设备关系那三处渲染显示 `none + locked`,逐像素与今天一致(spec 5.1 的硬要求),remote 关系才把 `locked` 单独画一格。

**筛选药丸:** `visibleUnderFilter` 今天写死 `if (bucket === "locked") return false`(只在 `all` 下可见)。改成:device 关系维持这一条,remote 关系下 `locked` 桶有自己的药丸、点它只筛出这些行。

**行:** `deriveRemoteRow` 加一条在最前面 —— `state === "locked"` 时给非 stageable 的 `—` 命运、`encrypted` chip、桶 `locked`,与 `deriveDeviceRow` 那条并排,句子共用同一个常量(把今天写死在 `deriveDeviceRow` 里的那句提成 `LOCKED_SENTENCE`,两处共用,免得日后只改一处)。

- [ ] **Step 1: 写失败测试** —— `tests/panelModel.test.ts`:`relationCopy({kind:"remote"}).bucket.locked === "Can't compare"`、device 那一格维持今天的词、`fateBucketCounts` 把 locked 单独计;`tests/panelRelation.test.ts`:remote 关系下 locked 行的桶与句子。
- [ ] **Step 2: 跑测试确认失败** —— `npx vitest run tests/panelModel.test.ts tests/panelRelation.test.ts`。
- [ ] **Step 3: 实现**(含 `SyncCenterView` 三处计数区域、筛选药丸、`deriveRemoteRow`、卡片 `State` 那句与入口)。
- [ ] **Step 4** `npx vitest run`、`npx tsc --noEmit`、`npx eslint .` 三绿。

```bash
git add src/ui tests/panelModel.test.ts tests/panelRelation.test.ts
git commit -m "feat(panel): items this device cannot open get their own bucket, not a wrong one"
```

---

### Task 7:真机冒烟

**Files:** 无(验证任务)

对应 spec 验收第 6、7、18 条。夹具:`npm run smoke:install`、`obsidian command id=app:reload`、remote 指向 scratchpad 的 `remote-vault2`。

- [ ] **Step 1 造两份独立捕获的密文**:两边各自捕获同一个加密项(明文相同、密码相同),确认 store 里两份的字节**不同** —— 这是本轮要修的现象的现场证据。
- [ ] **Step 2 字段级加密项,已解锁**:面板上该行读作 `In sync`,不再常亮待推。改一个非加密键 → 读作待推;推完回到 `In sync`。
- [ ] **Step 3 字段级加密项,未解锁**:Settings → General 清掉密码短语,刷新 remote。Expected:该行落进 `Can't compare`,句子是那句已定稿的英文,**不弹密码框**;卡片 `State` 说明 + 入口能跳到 General 的 Passphrase 那一行。
- [ ] **Step 4 整份加密项**:同 Step 2/3 两态,且卡片里**没有** `Files` 区。
- [ ] **Step 5 对面还没有这一项**:把对面那份删掉再刷新。Expected:一条**普通的待推行**,没有任何跟密码有关的字样(验收 18)。
- [ ] **Step 6 设备关系没变**:切回 `This device ↔ store`,三处计数区域、筛选药丸、locked 行的长相与 2.24.3 逐像素一致。

---

### Task 8:文档追平

- [ ] `docs/ARCHITECTURE.md`:新增 `core/cipherCompare.ts` 与 `core/itemCompare.ts` 两条,写明**为什么是三态而不是两态**,以及 `storeItemsAgree` 为什么搬家;`checkRemote` 那条把 `keyRuled` 改成 `content`。
- [ ] `docs/GUIDE.md`:加密一节补两句 —— 两个 vault 各自捕获出来的密文字节本来就不同,Config Sync 比的是它们说的内容;这台设备没有密码短语时,那些项会照实说「无法比对」,而不是显示成有差异。
- [ ] `CHANGELOG.md`:

> Fixed encrypted items always looking out of sync with a remote. Every encryption uses fresh randomness, so two vaults holding the very same setting still hold different bytes — Config Sync now compares what the two copies say instead of the bytes they are stored as
>
> Added an honest answer for an encrypted item this device can't open: it now says the two copies can't be compared, instead of claiming a difference nobody could act on

```bash
git add docs CHANGELOG.md
git commit -m "docs: encrypted items are compared by what they say"
```

---

## 完成标准

- 三绿,lint 不超基线。
- **常亮态消失**:Task 2 的第一条单测(同明文两次加密 → `same`)与 Task 7 的 Step 2。
- **不知道就说不知道**:`cannot` 既不进 `itemVerdicts` 也不进两个计数,行落进 `Can't compare`。
- **对面没有副本时不提密码**(Task 2 第六条 + Task 7 Step 5)。
- **设备关系逐像素不变**(Task 7 Step 6)。
- 既有 remote 测试**一条未改**其断言 —— 明文项的判断不因三态而变。

## 交给 4b / 4c / 4d 的边界

- **`passphrase.theirs` 本轮永远等于 `mine`。** 接缝已经建好,4b 把它换成这个 remote 自己的钥匙串条目,并补上另外两种「无法比对」的说法(没配 / 配错)—— 这两种今天根本无从发生,提前造一句文案就是在猜。
- **一个计数上的取舍,记在这里:** 无法比对的项不进 remote 的 push/pull 计数,于是一个只剩这类项的 remote,View 选择器上那两个徽章是空的。这是对的 —— 没有任何可做的事 —— 但代价是用户不切过去就不知道有东西看不懂。真要提示,是给 `RemoteItemCounts` 加第三个数字,一并改三处徽章渲染,不在本轮。
- **拉取与推送本轮一个字节都不碰。** 密码不对时照搬密文进本地 store 的那个坑(3.9.2)还在,只是现在面板会先告诉你比不了。4c 补。
- **字段级加密项的 Keys 区仍然不开。** `relCanHaveKeys` 今天只看后缀是不是 `.json`,于是**整份加密的项也会被它认成能有键规则** —— 面板不提供入口,所以今天造不出这样的规则,但那道闸是空的。4d 把闸补上,同时给字段级加密项开出 Keys 区。
- **3f 的写前复核比的仍是字节**(p3f 已记)。4d 让加密项也能被逐键改写时,复核的比较对象要跟着换成解密后的明文,否则每一次推送都会误报一次并发 —— 那时正好复用本轮的 `compareCopies`。
