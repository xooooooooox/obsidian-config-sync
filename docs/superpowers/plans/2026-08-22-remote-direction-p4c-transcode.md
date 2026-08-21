# 2.25.0 · Plan 4c:转码 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4b 立了一条暂行禁令:异密码的 remote 不交换密文。本轮把能力补上 —— 拉取用对面的密码解、用本地的重新加密;推送反过来 —— 然后**把那条禁令连同它的模块和文案整条删除**。信封复用(3.9.1)不是优化是正确性:每次加密都抽新盐,不复用的话每次推送都重写每一个加密项,git 历史每次被搅一遍,面板那一行永远到不了 In sync。

**Architecture:** 转码是**内容变换**,和逐键扣留同一个位置:接在两个接缝的**计划阶段**(3f 的规矩 —— 落盘之前所有决定做完)。`pushExternal` 计划循环本来就为每个 rel 读了对面现有内容(`theirs`,扣留和 skip-if-identical 都靠它),转码的复用检查白拿这份;`planImport` 的 `remoteFileMap` 本来就是「拉取将写下什么」,转码后的内容放进去,合并分类、冲突弹窗、applyImport 全部免费拿到本地密码的字节。**复用命中时转码返回目的地现有的字节**,于是稳态在两个接缝里都走既有的「字节相同就跳过」路径 —— 报告安静、git 无提交,不需要任何新的跳过逻辑。检测按**内容**不按分组:信封和 `enc:v1:` 叶子自己认得出来,一个廉价的子串预检(`"csenc":1` / `enc:v1:`)挡住普通文件的解析成本。失败语义分两层:**预检**(main.ts,只对 own-key remote 的密文项,逐项试解)把打不开的项摘成 skipRefs + 报告行(3.9.2 的「能拉的都拉」);预检后仍失败的(窗口内对面变了密码)抛错中止 —— 计划阶段无写,中止 = 什么都没发生。

**Tech Stack:** TypeScript(strict)、vitest(真 WebCrypto)。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md` §3.9 使用点、§3.9.1 信封复用、§3.9.2 失败模式、§3.9.3 缓存容量。验收 14、15、16、17 条。

## 迭代全景

| # | 计划 | 状态 |
|---|---|---|
| 1 – 3f | 数据模型 → 统一面板 → 逐项方向 → 派生 lock → 逐键扣留 → 键级一致 → Keys 写入口 → 推送并发 | **DONE**,均已合入 main |
| 4a | 解密后比明文 + `Can't compare` 桶 | **DONE**(分支 p4a,待真机) |
| 4b | per-remote 密码短语、三种说法、暂行禁令 | **DONE**(分支 p4b,待真机) |
| **4c** | **本文件** | 转码 + 信封复用 + 删除暂行禁令 |
| 4d | 字段级加密的 Keys 区、`relCanHaveKeys` 收紧、加密键扣留、两字形 | 未开始 |

## Global Constraints

- **同密码走原路,一个字节不变。** 转码钩子只在 `RemoteKey.kind === "own"` 时构造;不传 = 逐字节转发,既有测试一条不许改。
- **复用命中 = 返回目的地现有字节**,让接缝自己的 identical-skip 生效。真正会重新加密的只有两种:内容真变了;一次性转换(每项一次,spec 3.9.1)。
- **被扣留的键不参与重新加密**(3.9.1 末条):转码先行、扣留后叠 —— overlay 的 `keep` 是对面现有内容,原封放回。
- **中止 = 什么都没写。** 转码全部发生在计划阶段;`pushExternal` 被转码改写的 rel 标 `reread`,3f 的写前复核照常盖住它们。
- **删干净**:`core/differentKeyHold.ts`、它在 `tests/core.test.ts` 的 describe、main.ts 的两处 wiring、ARCHITECTURE 的条目、GUIDE 的那条 bullet、CHANGELOG 的那条,全部移除或改写。
- 三绿,lint 基线 0 error / 57 warn。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/core/transcode.ts`(新建) | `transcodeContent`(信封/字段两形态 + 复用)与 `transcodePreflight`(逐项试解 → skipRefs + 报告行) |
| `src/core/ConfigSyncCore.ts`(改) | 两接缝的 opts 各加可选 `transcode` 钩子 |
| `src/core/differentKeyHold.ts`(**删除**) | |
| `src/main.ts`(改) | 构造钩子 + 预检,替换 differentKeyHold |
| 测试 | `tests/transcode.test.ts`(新)、`tests/core.test.ts`(改)、`tests/encryptedRemote.test.ts`(补端到端) |

---

### Task 1:内容变换本体

**Files:**
- Create: `src/core/transcode.ts`
- Test: `tests/transcode.test.ts`(新建)

**Interfaces:**
```ts
export class TranscodeError extends Error {}  // 携带 rel 与哪一侧打不开

// content 是源侧那份;existing 是目的地现有那份(复用的对照物),null = 目的地没有。
// from/to 相同(含都为 null)→ 原样返回。信封与 enc:v1: 叶子按内容自识别;
// 都不含 → 原样返回(子串预检挡住解析成本)。
export async function transcodeContent(input: {
  rel: string;
  content: string;
  existing: string | null;
  from: string | null;
  to: string | null;
}): Promise<string>;
```

**复用规则(3.9.1),逐形态:** 整份信封 —— 用 `from` 解出明文;`existing` 也是信封且 `fileUnchanged(to, existingEnv, plaintext)` → **返回 existing**;否则 `encryptFile(to, plaintext)`。字段级 —— 逐叶子:`existing` 同路径的叶子 `fieldUnchanged(to, leaf, plaintext)` → 复用那串密文;否则重加密;**文档整体**若最终与 `existing` 逐字节相同则返回 existing(让 identical-skip 生效要求字节级一致,JSON.stringify 顺序照 store 既有形状)。

- [ ] **Step 1: 写失败测试**(真 WebCrypto):同明文复用返回 existing 字节;内容变了才新加密;一次性转换(existing=null)产出 `to` 能解开的信封;字段级只重加密变了的叶子;`from` 打不开 → `TranscodeError`;`to` 为 null 且有密文 → `TranscodeError`;纯明文文件原样返回;`from === to` 原样返回。
- [ ] **Step 2: 确认失败 → 实现 → 全绿。**

```bash
git add src/core/transcode.ts tests/transcode.test.ts
git commit -m "feat(core): ciphertext re-encrypted for its destination, reusing what already says the same"
```

---

### Task 2:接进两个接缝

**Files:**
- Modify: `src/core/ConfigSyncCore.ts`
- Test: `tests/core.test.ts`

**`pushExternal`**:opts 加 `transcode?: (rel, content, existing) => Promise<string>`。计划循环里 `content` 先过转码(`existing = theirs`),再叠扣留;`reread` 改为 `patterns.length > 0 || content !== mine`(转码动过的内容依赖对面现状,3f 的复核必须盖住)。**`sentHashes` 不受影响**:密文项本就不可指纹(`storeContentIsHashable` 为 false),派生 lock 从不给它们写 hash。

**`planImport`**:同名可选钩子。`remoteFileMap` 循环里 `raw` 先过转码(`existing = 本地 store 同 rel 现有内容`),再叠扣留。复用命中 → 与本地字节相同 → `classifyMerge` 判无差异,既不冲突也不写。

- [ ] **Step 1: 写失败测试** —— push:异密码 remote 上稳态连推两次,第二次 `writeLog` 为空(验收 15);一次性转换后对面那份用**它自己的**密码解开内容正确(验收 14);扣留的加密键推后对面原封(验收 17,断言字节)。pull:对面 own-key 的信封拉进来后本地那份用**本地**密码解开正确;稳态拉取无写。
- [ ] **Step 2: 确认失败 → 实现 → 全绿**,既有 push/pull 测试一条未改。

```bash
git add src/core/ConfigSyncCore.ts tests/core.test.ts
git commit -m "feat(transport): what crosses re-encrypts for the side that will hold it"
```

---

### Task 3:预检替换禁令,禁令删除

**Files:**
- Create(并入 `src/core/transcode.ts`): `transcodePreflight`
- Delete: `src/core/differentKeyHold.ts`
- Modify: `src/main.ts`、`tests/core.test.ts`

**Interfaces:**
```ts
// own-key remote 的密文项逐项试解(pull 试对面那份、push 试本地那份),打不开的摘出去。
// missing-key remote:全部密文项摘出(没有钥匙可试)。same-as-local:空手而归,零成本。
export async function transcodePreflight(input: {
  key: RemoteKey;
  remoteName: string;
  direction: "pull" | "push";
  groups: readonly SyncGroup[];
  io: FileIO; rootPath: string;
  reader: { listFiles(): Promise<string[]>; readFile(rel: string): Promise<string> };
  localPassphrase: string | null;
}): Promise<{ skipRefs: ItemRef[]; results: GroupResult[] }>;
```

**报告文案(两句都要你点头):**
- 试了打不开:`Skipped — the passphrase saved for <remote> doesn't open its copy. Nothing was written.`(spec 3.9.2 原句)
- 条目没链:`Skipped — the passphrase named for <remote> isn't linked on this device. Nothing was written.`
- push 方向本机开不了自己的(本机未解锁):`Skipped — this item is encrypted and this device has no passphrase. Nothing was written.`

- [ ] **Step 1: 写失败测试** —— 配错密码拉一次:密文项字节不变、报告单列、其余项照常(验收 16);`missing` 全摘;`same-as-local` 空手。
- [ ] **Step 2: 实现**;main.ts 两处 `differentKeyHold` 换成 `transcodePreflight` + 转码钩子(`kind === "own"` 时构造)。
- [ ] **Step 3: 删除** `differentKeyHold.ts` 与它的 describe;`git rm`。
- [ ] **Step 4** 全绿。

```bash
git add -A
git commit -m "feat(transport): the standing hold gives way to trying the key and saying what failed"
```

---

### Task 4:端到端 + 缓存观察

- [ ] `tests/encryptedRemote.test.ts` 补一条全链:vault A(密码 a)推给 own-key remote(密码 b)→ 对面用 b 解开正确;再推一次零写;从对面拉回改动 → 本地用 a 解开正确。
- [ ] **3.9.3 只记录不动代码**:`derivedKeyCache` 容量 256、满了整清。转码后两侧盐同挤一表,但读侧盐固定、写侧只有变更字段付新盐 —— 在 ARCHITECTURE 的条目里写明这个判断与「实测反复清空再改 LRU」的触发条件。

---

### Task 5:真机冒烟(与 4a/4b 同一轮,等 dev vault 注册)

- [ ] 验收 14:配不同密码推一个加密项,去对面 vault 用它自己的密码打开,内容正确。
- [ ] 验收 15:内容不变连推两次,第二次 git 无新提交,面板 In sync。
- [ ] 验收 16:密码配错拉取,该项被跳过并说明,本地 store 字节不变,其余照拉。
- [ ] 验收 17:扣留的加密键推送后去对面核对原封未动。

---

### Task 6:文档追平

- [ ] ARCHITECTURE:`core/transcode.ts` 条目(复用为什么是正确性、预检为什么在 main、缓存判断);删 `differentKeyHold` 条目;两接缝条目补钩子。
- [ ] GUIDE:删「不交换」那条 bullet,改写成转码行为(每项一次的一次性转换、稳态安静、配错时逐项跳过)。
- [ ] CHANGELOG:删 4b 那条「don't travel」,换成转码条目。

```bash
git add docs CHANGELOG.md && git commit -m "docs: ciphertext travels by being re-encrypted for its destination"
```

## 完成标准

- 三绿;既有同密码测试一条未改。
- 稳态零写(push 与 pull 各一条断言 `writeLog`/文件字节)。
- 一次性转换与配错不写脏各有断言**字节**的测试。
- `differentKeyHold` 在仓库里 `grep` 不到。
