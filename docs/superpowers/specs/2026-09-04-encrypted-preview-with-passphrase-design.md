# 整文件加密项:密码短语在手时恢复变更预览 — design

Date: 2026-09-04 · 迭代 **2.25.7** · Scope: Sync Center 文件级预览(段 A,capture 与 apply 两个方向)· Status: 已批准 ·
起因: owner 真机反馈 — capture 前 IOTO Framework Settings 的 `data.json` 显示 `changed (encrypted, no preview)`,质疑「并不是做不到」。诊断确认属实。

---

## 1. 现状:形状判断顶替了密钥判断

- `main.ts` 的 `diffPair` 对 `isWholeFileEncrypted(group)` 一律提前返回 null —— 在读取任何内容之前,与密码短语是否在手无关。
- `SyncCenterView` 三处把 `isWholeFileEncrypted(r.group)` 直接作为 `encrypted` 传给展示层;`fileEntryFor` 收到 true 就压掉 diff 入口并挂 `changed (encrypted, no preview)`。
- 2026-07-16 反馈三件套 spec 的原话是「encrypted **without passphrase** → null」,实现丢掉了限定词,变成无条件。
- 不对称:字段级加密(`fields` + `encrypted:true` keys)在同一个 `diffPair` 里早就产出明文 diff。`modes.ts` 上的注释只反对「把密文当行 diff 展示」,不反对先解密再比。
- 密钥同步可得(`passphrase()` 是 keychain/localStorage 读,无弹窗),派生结果按 passphrase+salt 缓存,store envelope 用固定 salt,解一次的成本可忽略。

## 2. 决定

**有密码短语就解密预览;没有才保留 note。** 与字段级加密的既有行为对齐:明文出现在可展开的 diff 面板里不是新口子 —— 字段级加密的 secrets 今天就这样展示,整文件加密没有理由更严。

### 2.1 diffPair(main.ts)

- 提前返回的条件从 `isWholeFileEncrypted(group)` 收窄为 `isWholeFileEncrypted(group) && passphrase 缺失`。
- capture 方向:`base` 从 store 密文 envelope 改为 `decodeFileEnvelope` 解出的明文(store 缺失仍为 `""`);`produced` 本来就是本地明文,不动。
- apply 方向:`produced` 从 store 密文改为解密明文;`base` 本来就是本地明文,不动。
- 解密失败(坏 envelope、错口令)落进函数既有的 catch → null → 既有「no diff available」渲染,不新增错误 UI。

### 2.2 展示层的 `encrypted` 旗标

`FateInput.encrypted` **保持形状语义不动**:它还驱动行上的 `encrypted` chip(存储形态的固有事实,密钥在手也该显示)和 keysRowModel 的「整文件加密、整走整留」note(与密钥无关)。收窄只发生在文件条目一处:`renderFilesRow` 的 `encrypted` 实参由调用方改传 `input.encrypted && (remote 关系 || 密码短语缺失)`,host 接口新增 `passphraseSet(): boolean` 供视图查询。**remote 关系保持形状语义**:那条路的 diff(`renderRemoteFileDiff`)渲染两侧 store 原始副本,对 envelope 就是密文行 diff,note 必须留着挡住入口;解密预览只放开 device 关系(store ↔ 本机,diffPair 会解密的那条)。self-pane 的 `renderSelfDataJsonDiff` 无需改动 —— diffPair 能解密后 pair 不再为 null,「encrypted file」note 自然只剩无密钥一种情形。

### 2.3 必须保留 note 的两种情形

- `fileRule.encrypted` + 无密码短语:status 刻意降级(不锁整项),会产出变更条目而 store 副本确实不可读 —— note 照旧。
- `mode:"encrypted"` + 无密码短语:整项 state 为 `locked`,本就进不了文件列表,无需处理。

## 3. 文案

note 字符串 `changed (encrypted, no preview)` 本身不改,只是出现条件收窄为「无密码短语」。GUIDE/DESIGN 中对该 note 的描述补上限定词。

## 4. 验证

- panelModel 测试:`fileEntryFor` 本身不改语义(入参 true 仍压预览、false 仍给 diff,两态断言已存在且保留);新条件是视图里一个布尔组合(`encrypted && (remote || !passphraseSet)`),不为它另造纯函数包装(YAGNI),靠真机两态验证。
- 真机:整文件加密项制造本地改动,capture 方向点开 diff 应见明文行 diff;清掉密码短语后 note 回归。
