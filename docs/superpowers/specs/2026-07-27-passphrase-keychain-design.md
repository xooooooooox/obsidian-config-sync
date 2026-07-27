# Passphrase keychain 存储(1.12+ 加密,旧版降级)

日期:2026-07-27
状态:定稿(用户 ok:清除用公开 API `setSecret(id, "")`;面板两句英文文案照案)

## 行为

- 能力检测:`app.secretStorage !== undefined`(公开 API 自 1.11.4;不解析版本号)。
- secret id:`config-sync-passphrase`(SecretStorage 的小写字母数字+连字符约束)。
- `passphrase()`:keychain 可用 → `getSecret(id)`,`""`/null 均视为未设置;否则走现行
  localStorage(`loadLocalStorage("config-sync-passphrase")`)逻辑。
- `setPassphrase(v)`:keychain 可用 → 非空写 `setSecret(id, v)`,清除写 `setSecret(id, "")`
  (公开 typings 无 deleteSecret;代价:Settings → Keychain 里留一条空值条目,已定稿接受);
  否则现行逻辑。
- 一次性迁移(onload):keychain 可用且 localStorage 有明文 → keychain 无值(null/"")时搬入,
  随后无条件清明文(两边都有以 keychain 为准)。旧版 Obsidian 完全不动。
- 不升 minAppVersion;不用 SecretComponent(其语义是从 keychain 挑已有条目)。

## 面板说明(General → Passphrase)

静态 desc 不变,渲染时按能力追加一句(既有"动态后缀"模式,搜索索引不受影响):

- keychain:`On this device it is stored encrypted in Obsidian's keychain (Settings → Keychain).`
- 降级:`This device's Obsidian is older than 1.12, so it is stored unencrypted in app storage — update Obsidian to keep it in the encrypted keychain.`

## 验证(dev vault,Obsidian 1.12.7;无单测,main.ts getter/setter 无纯逻辑可抽)

明文预置 → reload 后 keychain 有值且明文被清;面板显示 keychain 句;set/clear 往返;
fileRule encrypted 的 capture 仍产出 csenc 信封。验证后清理测试值。

## 文档

README/zh 的 passphrase 描述若提到存储位置则同步;否则不动。
