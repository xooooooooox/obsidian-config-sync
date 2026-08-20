# 2.25.0 · Plan 1:per-remote 方向规则的数据模型与迁移 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `Remote.excludeSelf` 这个布尔换成通用的 per-remote 方向规则(item 级 + key 级),`schemaVersion` 4 → 5,**行为完全不变**。

**Architecture:** 纯数据模型 + 迁移。新增一个 `RemoteDirection` 四档枚举与两层规则容器,挂在 `Remote` 对象内部(继承 `remotes` 字段既有的「只属于这台设备、永不进 store」锁定规则)。`excludeSelf: true` 迁移成 `items.community["config-sync"].direction = "none"`。四个传输接缝今天写死的 `excludeSelf ? [SELF_ITEM_REF] : []` 改成从新规则算出的 ref 集合 —— 迁移之后这两者逐值相等,所以本计划**不引入任何可观察的行为变化**。设置面板那个开关保留,只是改成读写新形状(**不要删**,删它要等 Plan 2 把面板行做出来,否则中间会出现「设不了」的空档)。

**Tech Stack:** TypeScript(strict)、vitest、无运行时依赖。core 层零 Obsidian / 零 Node 导入。

**Spec:** `docs/superpowers/specs/2026-08-20-remote-direction-rules-design.md`

## 迭代全景(本计划只做第 1 块)

| # | 计划 | 交付 |
|---|---|---|
| **1** | **数据模型与迁移(本文件)** | v5 文档形状、迁移、解析、四接缝改读新规则。**行为不变** |
| 2 | 面板统一 | remote 关系接进主面板,退役 remote 专用渲染器;能力仍是今天的整份 Pull/Push |
| 3 | 四档方向规则落地 | 传输语义(扣留、保留对面的值)、派生 lock、方向感知忽略集、并发复核、「一致」重定义 |
| 4 | 加密 | 解密后比对、per-remote 密码短语、转码、信封复用、失败模式 |

每一块单独交付可用软件。本计划完成后,用户看到的一切与 2.24.3 相同。

## Global Constraints

- **schemaVersion 5**:`schema/data.schema.json` 已经改完(`const: 5`,新增 `remoteDirection` / `remoteKeyRule` / `remoteItemRule` / `remoteItems`,两个 remote 分支去掉 `excludeSelf`、加 `items` 与 `passphraseId`)。**代码要追上 schema,不是反过来。**
- **`schemaVersion` 只有一个字面量**:`src/core/settingsMigration.ts` 的 `CURRENT_SCHEMA`。
- **未知字段一律原样带过**(invariant II.1)。迁移只改它认识的东西。
- **更高版本的文档一律拒绝**,不降级、不重置、不覆盖(invariant II.3)。
- **core 层零 Obsidian、零 Node 导入。**
- **词汇**:`direction` 的四个值是 `"both" | "push" | "pull" | "none"`。UI 文案是 `Both ways` / `Push only` / `Pull only` / `Neither way`,**本计划不写任何 UI 文案**。
- **不提交 Claude 署名**,提交信息不带任何 AI 归属尾注。
- 注释写不变量,不写变更史;不用 `§` 引章节。

---

### Task 1:`RemoteDirection` 与规则容器类型

**Files:**
- Modify: `src/core/types.ts`(`Remote` union,约 257 行)
- Test: `tests/remoteRules.test.ts`(新建)

**Interfaces:**
- Consumes: `ItemRef`、`parseItemRef`、`itemRef`(`src/core/itemKeys.ts`,已有)
- Produces:
  - `type RemoteDirection = "both" | "push" | "pull" | "none"`
  - `interface RemoteKeyRule { direction: RemoteDirection }`
  - `interface RemoteItemRule { direction?: RemoteDirection; keys?: Record<string, RemoteKeyRule> }`
  - `type RemoteItems = Record<string, Record<string, RemoteItemRule>>`
  - `Remote` 两个分支各加 `items?: RemoteItems` 与 `passphraseId?: string`,**去掉 `excludeSelf`**
  - `function directionFlows(d: RemoteDirection): { push: boolean; pull: boolean }`
  - `function intersectDirection(item: RemoteDirection, key: RemoteDirection): RemoteDirection`

- [ ] **Step 1: 写失败测试**

新建 `tests/remoteRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { directionFlows, intersectDirection, RemoteDirection } from "../src/core/types";

describe("directionFlows", () => {
  it("maps each of the four positions to the two flags", () => {
    expect(directionFlows("both")).toEqual({ push: true, pull: true });
    expect(directionFlows("push")).toEqual({ push: true, pull: false });
    expect(directionFlows("pull")).toEqual({ push: false, pull: true });
    expect(directionFlows("none")).toEqual({ push: false, pull: false });
  });
});

describe("intersectDirection", () => {
  it("is the intersection of the two direction SETS, not a max/min on an order", () => {
    // push and pull are incomparable: their intersection is empty, not one of them
    expect(intersectDirection("push", "pull")).toBe("none");
    expect(intersectDirection("pull", "push")).toBe("none");
  });

  it("lets an item widen nothing and a key narrow anything", () => {
    expect(intersectDirection("both", "pull")).toBe("pull");
    expect(intersectDirection("pull", "both")).toBe("pull");
    expect(intersectDirection("none", "both")).toBe("none");
    expect(intersectDirection("push", "push")).toBe("push");
  });

  it("is commutative for every pair", () => {
    const all: RemoteDirection[] = ["both", "push", "pull", "none"];
    for (const a of all) {
      for (const b of all) {
        expect(intersectDirection(a, b)).toBe(intersectDirection(b, a));
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRules.test.ts`
Expected: FAIL —— `directionFlows` / `intersectDirection` 不存在,TypeScript 报未导出。

- [ ] **Step 3: 写实现**

在 `src/core/types.ts` 里,`Remote` 定义**之前**加:

```ts
// Which way one thing travels with ONE remote. Not an ordered scale: "push" and "pull" are
// incomparable, so a key's rule is a SUBSET of its item's allowed directions rather than a
// stricter point on a line — intersectDirection below is the only correct combiner.
export type RemoteDirection = "both" | "push" | "pull" | "none";

export interface RemoteKeyRule {
  direction: RemoteDirection;
}

export interface RemoteItemRule {
  direction?: RemoteDirection;
  // Key-name glob pattern -> that key's rule. Omitted when empty.
  keys?: Record<string, RemoteKeyRule>;
}

// Section -> item id -> that item's rules for this remote. Two levels, never flattened: an item's
// family and id are where it SITS, the same shape `items` and the store lock use.
export type RemoteItems = Record<string, Record<string, RemoteItemRule>>;

export function directionFlows(d: RemoteDirection): { push: boolean; pull: boolean } {
  return { push: d === "both" || d === "push", pull: d === "both" || d === "pull" };
}

// The item's rule and the key's rule combine by INTERSECTION of the direction sets. A stored key
// rule outside its item's subset stays as written and simply resolves to less here; nothing
// rewrites it, so widening the item again restores what the user chose.
export function intersectDirection(item: RemoteDirection, key: RemoteDirection): RemoteDirection {
  const a = directionFlows(item);
  const b = directionFlows(key);
  const push = a.push && b.push;
  const pull = a.pull && b.pull;
  return push && pull ? "both" : push ? "push" : pull ? "pull" : "none";
}
```

再把 `Remote` union 改成(替换整段,注意注释也换掉):

```ts
// items: this device's direction rules for the remote, keyed section -> id (RemoteItems above).
// It lives on the REMOTE and never on the item: a remote's name is this device's transport wiring,
// and a rule written on the item would ride that item's store copy to the far vault and point at a
// remote that does not exist there.
// passphraseId: name of the keychain secret holding THIS REMOTE's store passphrase, for a remote
// vault encrypting with a different one. Absent = the same passphrase as this vault.
export type Remote =
  | { name: string; type: "vault"; storePath: string; items?: RemoteItems; passphraseId?: string } // storePath: absolute path of the store directory; leading ~ allowed
  | { name: string; type: "git"; url: string; branch: string; subdir?: string; items?: RemoteItems; passphraseId?: string; tokenId?: string; username?: string }; // subdir: store folder inside the repo; absent = repo root. tokenId: name of the keychain secret holding the token — the token itself never enters data.json. username: sent alongside it; absent = "token", which PAT-only hosts ignore but a self-hosted GitLab validates
```

删掉 `Remote` 上方那段 `excludeSelf (either type): ...` 注释。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/remoteRules.test.ts`
Expected: PASS(3 条)

此时 `npx tsc --noEmit` 会在所有读 `excludeSelf` 的地方报错(`main.ts`、`SettingTab.ts`、`SyncCenterView.ts`、`manifest.ts`、`ConfigSyncCore.ts`、`status.ts`)。**这是预期的**,Task 2-5 逐个接上;本步骤只要 vitest 这一个文件绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts tests/remoteRules.test.ts
git commit -m "feat(types): per-remote direction rules replace the excludeSelf boolean"
```

---

### Task 2:规则查询 —— 一个读者,一处真源

**Files:**
- Create: `src/core/remoteRules.ts`
- Test: `tests/remoteRules.test.ts`(续写)

**Interfaces:**
- Consumes: Task 1 的 `RemoteDirection` / `RemoteItems` / `intersectDirection` / `directionFlows`;`ItemRef`、`parseItemRef`(`src/core/itemKeys.ts`);`keyMatchesAny`(`src/core/sanitize.ts`)
- Produces:
  - `function itemDirection(items: RemoteItems | undefined, ref: ItemRef): RemoteDirection`
  - `function keyDirection(items: RemoteItems | undefined, ref: ItemRef, key: string): RemoteDirection` —— 已经取过交集
  - `function withItemDirection(items: RemoteItems | undefined, ref: ItemRef, d: RemoteDirection): RemoteItems | undefined` —— 写回,默认值不落盘
  - `function refsBlockedFor(items: RemoteItems | undefined, dir: "push" | "pull"): ItemRef[]` —— 该方向上完全不流动的项

- [ ] **Step 1: 写失败测试**

追加到 `tests/remoteRules.test.ts`:

```ts
import { itemDirection, keyDirection, withItemDirection, refsBlockedFor } from "../src/core/remoteRules";
import { RemoteItems } from "../src/core/types";

const RULES: RemoteItems = {
  community: {
    "config-sync": { direction: "none" },
    dataview: { direction: "push", keys: { accentColor: { direction: "pull" } } },
  },
  obsidian: { appearance: { keys: { "accent*": { direction: "none" } } } },
};

describe("itemDirection", () => {
  it("defaults to both for an item, a section, or a rule set nobody mentioned", () => {
    expect(itemDirection(RULES, "core/backlink")).toBe("both");
    expect(itemDirection(RULES, "obsidian/appearance")).toBe("both"); // has keys, no item rule
    expect(itemDirection(undefined, "community/dataview")).toBe("both");
  });

  it("reads the stored value when there is one", () => {
    expect(itemDirection(RULES, "community/config-sync")).toBe("none");
    expect(itemDirection(RULES, "community/dataview")).toBe("push");
  });
});

describe("keyDirection", () => {
  it("intersects the key rule with its item rule", () => {
    // item push, key pull -> empty
    expect(keyDirection(RULES, "community/dataview", "accentColor")).toBe("none");
  });

  it("matches glob patterns and falls back to the item's own direction", () => {
    expect(keyDirection(RULES, "obsidian/appearance", "accentColor")).toBe("none");
    expect(keyDirection(RULES, "obsidian/appearance", "cssTheme")).toBe("both");
  });

  it("never widens past the item", () => {
    expect(keyDirection(RULES, "community/config-sync", "anything")).toBe("none");
  });
});

describe("withItemDirection", () => {
  it("writes a non-default value", () => {
    const next = withItemDirection(undefined, "core/backlink", "pull");
    expect(next?.core?.backlink).toEqual({ direction: "pull" });
  });

  it("removes the entry instead of storing the default", () => {
    const next = withItemDirection(RULES, "community/config-sync", "both");
    expect(next?.community?.["config-sync"]).toBeUndefined();
  });

  it("keeps an entry that still carries key rules when its item rule returns to the default", () => {
    const next = withItemDirection(RULES, "community/dataview", "both");
    expect(next?.community?.dataview).toEqual({ keys: { accentColor: { direction: "pull" } } });
  });

  it("drops the whole map when nothing is left", () => {
    let next = withItemDirection(RULES, "community/config-sync", "both");
    next = withItemDirection(next, "community/dataview", "both");
    next = withItemDirection(next, "obsidian/appearance", "both");
    // obsidian/appearance still holds key rules, so the map survives
    expect(next).not.toBeUndefined();
    expect(withItemDirection(undefined, "core/backlink", "both")).toBeUndefined();
  });
});

describe("refsBlockedFor", () => {
  it("names the items that do not flow in the asked direction", () => {
    expect(refsBlockedFor(RULES, "pull").sort()).toEqual(["community/config-sync", "community/dataview"]);
    expect(refsBlockedFor(RULES, "push").sort()).toEqual(["community/config-sync"]);
  });

  it("is empty when there are no rules", () => {
    expect(refsBlockedFor(undefined, "push")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteRules.test.ts`
Expected: FAIL —— `src/core/remoteRules.ts` 不存在。

- [ ] **Step 3: 写实现**

新建 `src/core/remoteRules.ts`:

```ts
import { ItemRef, parseItemRef } from "./itemKeys";
import { keyMatchesAny } from "./sanitize";
import { intersectDirection, RemoteDirection, RemoteItemRule, RemoteItems } from "./types";

// THE reader for a remote's rules. Every consumer — the four transport seams, the panel, the
// counting surfaces — asks here, so "what does this remote do with this item" has one answer.

function ruleFor(items: RemoteItems | undefined, ref: ItemRef): RemoteItemRule | undefined {
  if (items === undefined) return undefined;
  const { section, id } = parseItemRef(ref);
  return items[section]?.[id];
}

export function itemDirection(items: RemoteItems | undefined, ref: ItemRef): RemoteDirection {
  return ruleFor(items, ref)?.direction ?? "both";
}

// The key's own answer, already intersected with its item's. A stored key rule outside the item's
// subset is honoured as written and simply resolves to less — never rewritten, so widening the
// item again restores the user's choice.
export function keyDirection(items: RemoteItems | undefined, ref: ItemRef, key: string): RemoteDirection {
  const rule = ruleFor(items, ref);
  const item = rule?.direction ?? "both";
  const keys = rule?.keys;
  if (keys === undefined) return item;
  for (const [pattern, kr] of Object.entries(keys)) {
    if (keyMatchesAny(key, [pattern])) return intersectDirection(item, kr.direction);
  }
  return item;
}

// Write one item's direction. The default is never stored: an entry that carries nothing else is
// removed, and a map that ends up empty becomes undefined, so a document only ever holds decisions
// somebody actually made.
export function withItemDirection(
  items: RemoteItems | undefined,
  ref: ItemRef,
  direction: RemoteDirection
): RemoteItems | undefined {
  const { section, id } = parseItemRef(ref);
  const next: RemoteItems = {};
  for (const [s, byId] of Object.entries(items ?? {})) next[s] = { ...byId };
  const bucket = { ...(next[section] ?? {}) };
  const existing = bucket[id];
  const keys = existing?.keys;
  if (direction === "both") {
    if (keys === undefined) delete bucket[id];
    else bucket[id] = { keys };
  } else {
    bucket[id] = keys === undefined ? { direction } : { direction, keys };
  }
  if (Object.keys(bucket).length === 0) delete next[section];
  else next[section] = bucket;
  return Object.keys(next).length === 0 ? undefined : next;
}

// Items that do NOT flow in the asked direction — the generalisation of today's
// `excludeSelf ? [SELF_ITEM_REF] : []`. Key rules never appear here: a key withheld inside an item
// that still travels is a content decision, not an item the seam should skip.
export function refsBlockedFor(items: RemoteItems | undefined, dir: "push" | "pull"): ItemRef[] {
  const out: ItemRef[] = [];
  for (const [section, byId] of Object.entries(items ?? {})) {
    for (const [id, rule] of Object.entries(byId)) {
      const d = rule.direction ?? "both";
      if (d === "none" || (d === "push" && dir === "pull") || (d === "pull" && dir === "push")) {
        out.push(`${section}/${id}` as ItemRef);
      }
    }
  }
  return out;
}
```

如果 `parseItemRef` 的返回不是 `{ section, id }`,按它实际的形状改这三处解构,不要改 `itemKeys.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/remoteRules.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: 提交**

```bash
git add src/core/remoteRules.ts tests/remoteRules.test.ts
git commit -m "feat(core): one reader for a remote's direction rules"
```

---

### Task 3:`parseRemote` 接受新形状

**Files:**
- Modify: `src/core/manifest.ts:689-735`(`parseRemote`)
- Test: `tests/manifest.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的类型;`PASSPHRASE_SECRET_ID`(`manifest.ts` 已导入)
- Produces: `parseRemote` 校验并保留 `items` / `passphraseId`;**不再认识 `excludeSelf`**(它由 Task 4 的迁移消化,到达这里时已经不存在)

- [ ] **Step 1: 写失败测试**

追加到 `tests/manifest.test.ts`:

```ts
describe("parseRemote — direction rules and passphrase", () => {
  it("carries a well-formed items map through", () => {
    const [r] = validateRemotes([
      { name: "work", type: "vault", storePath: "/tmp/store", items: { community: { dataview: { direction: "push" } } } },
    ]);
    expect(r.items).toEqual({ community: { dataview: { direction: "push" } } });
  });

  it("rejects a direction that is not one of the four", () => {
    expect(() =>
      validateRemotes([{ name: "work", type: "vault", storePath: "/tmp/store", items: { community: { dataview: { direction: "sideways" } } } }])
    ).toThrow(/direction/);
  });

  it("rejects a non-object items map", () => {
    expect(() => validateRemotes([{ name: "work", type: "vault", storePath: "/tmp/store", items: [] }])).toThrow(/rules/);
  });

  it("accepts a passphrase secret name and rejects the reserved one", () => {
    const [ok] = validateRemotes([{ name: "work", type: "vault", storePath: "/tmp/store", passphraseId: "work-pass" }]);
    expect(ok.passphraseId).toBe("work-pass");
    expect(() => validateRemotes([{ name: "work", type: "vault", storePath: "/tmp/store", passphraseId: "config-sync-passphrase" }])).toThrow(
      /own vault passphrase/
    );
  });

  it("no longer carries excludeSelf through", () => {
    const [r] = validateRemotes([{ name: "work", type: "vault", storePath: "/tmp/store", excludeSelf: true }]);
    expect((r as Record<string, unknown>).excludeSelf).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/manifest.test.ts -t "direction rules and passphrase"`
Expected: FAIL —— `items` 被丢弃、`passphraseId` 未校验。

- [ ] **Step 3: 写实现**

在 `manifest.ts` 的 `parseRemote` 之前加一个校验器:

```ts
const REMOTE_DIRECTIONS = new Set(["both", "push", "pull", "none"]);

// A remote's rules are hand-editable like everything else in data.json, so they are validated on
// write with the same voice as the rest of this form: name the remote, name the field, never quote
// JSON syntax.
function parseRemoteItems(value: unknown, name: string): RemoteItems | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new ManifestValidationError(`Remote "${name}": the per-item rules must be a set of sections`);
  const out: RemoteItems = {};
  for (const [section, byId] of Object.entries(value)) {
    if (!isPlainObject(byId)) throw new ManifestValidationError(`Remote "${name}": the rules under "${section}" must be a set of items`);
    const bucket: Record<string, RemoteItemRule> = {};
    for (const [id, raw] of Object.entries(byId)) {
      if (!isPlainObject(raw)) throw new ManifestValidationError(`Remote "${name}": the rule for "${section}/${id}" must be an object`);
      const rule: RemoteItemRule = {};
      if (raw.direction !== undefined) {
        if (typeof raw.direction !== "string" || !REMOTE_DIRECTIONS.has(raw.direction)) {
          throw new ManifestValidationError(`Remote "${name}": the direction for "${section}/${id}" must be both, push, pull or none`);
        }
        rule.direction = raw.direction as RemoteDirection;
      }
      if (raw.keys !== undefined) {
        if (!isPlainObject(raw.keys)) throw new ManifestValidationError(`Remote "${name}": the key rules for "${section}/${id}" must be a set of key names`);
        const keys: Record<string, RemoteKeyRule> = {};
        for (const [pattern, kraw] of Object.entries(raw.keys)) {
          if (!isPlainObject(kraw) || typeof kraw.direction !== "string" || !REMOTE_DIRECTIONS.has(kraw.direction)) {
            throw new ManifestValidationError(`Remote "${name}": the direction for "${pattern}" must be both, push, pull or none`);
          }
          keys[pattern] = { direction: kraw.direction as RemoteDirection };
        }
        if (Object.keys(keys).length > 0) rule.keys = keys;
      }
      if (rule.direction !== undefined || rule.keys !== undefined) bucket[id] = rule;
    }
    if (Object.keys(bucket).length > 0) out[section] = bucket;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRemotePassphraseId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9-]+$/.test(value) || value.length > 64) {
    throw new ManifestValidationError(`Remote "${name}": the passphrase's name can use lowercase letters, digits and dashes, up to 64 characters, e.g. work-passphrase`);
  }
  if (value === PASSPHRASE_SECRET_ID) {
    throw new ManifestValidationError(`Remote "${name}": "${PASSPHRASE_SECRET_ID}" is this vault's own vault passphrase. Give this remote its own secret instead`);
  }
  return value;
}
```

`parseRemote` 里:把解构行的 `excludeSelf` 换成 `items, passphraseId`,删掉那段 `excludeSelf !== undefined && typeof excludeSelf !== "boolean"` 的校验,并在两个分支各自的 `const remote: Remote = ...` 之后加:

```ts
    const rules = parseRemoteItems(items, name);
    if (rules !== undefined) remote.items = rules;
    const pass = parseRemotePassphraseId(passphraseId, name);
    if (pass !== undefined) remote.passphraseId = pass;
```

删掉两处 `if (excludeSelf === true) remote.excludeSelf = true;`。补上 `RemoteDirection` / `RemoteItemRule` / `RemoteItems` / `RemoteKeyRule` 的 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/manifest.ts tests/manifest.test.ts
git commit -m "feat(manifest): validate a remote's direction rules and passphrase name"
```

---

### Task 4:v5 迁移

**Files:**
- Create: `src/core/v5Migration.ts`
- Modify: `src/core/settingsMigration.ts:22`(`CURRENT_SCHEMA`)、`:54`(`MIGRATABLE_SCHEMAS`)、模块头注释
- Modify: `src/main.ts:2281-2282` 一带(迁移链)
- Test: `tests/migration.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `RemoteItems`;`SELF_ITEM_SECTION` / `SELF_ITEM_ID`(`src/core/catalog.ts`)
- Produces: `function migrateV5Settings(input: Record<string, unknown>): Record<string, unknown>`

- [ ] **Step 1: 写失败测试**

追加到 `tests/migration.test.ts`:

```ts
import { migrateV5Settings } from "../src/core/v5Migration";

describe("migrateV5Settings", () => {
  it("does nothing to a document that is not v4", () => {
    const doc = { schemaVersion: 5, remotes: [] };
    expect(migrateV5Settings(doc)).toBe(doc);
  });

  it("turns excludeSelf into a direction rule on the self item", () => {
    const out = migrateV5Settings({
      schemaVersion: 4,
      remotes: [{ name: "work", type: "vault", storePath: "/s", excludeSelf: true }],
    });
    expect(out.schemaVersion).toBe(5);
    const remotes = out.remotes as Record<string, unknown>[];
    expect(remotes[0].excludeSelf).toBeUndefined();
    expect(remotes[0].items).toEqual({ community: { "config-sync": { direction: "none" } } });
  });

  it("writes no rules at all when excludeSelf was absent or false", () => {
    const out = migrateV5Settings({
      schemaVersion: 4,
      remotes: [
        { name: "a", type: "vault", storePath: "/s" },
        { name: "b", type: "vault", storePath: "/s", excludeSelf: false },
      ],
    });
    const remotes = out.remotes as Record<string, unknown>[];
    expect(remotes[0].items).toBeUndefined();
    expect(remotes[1].items).toBeUndefined();
    expect(remotes[1].excludeSelf).toBeUndefined();
  });

  it("carries every other field, known and unknown, untouched", () => {
    const out = migrateV5Settings({
      schemaVersion: 4,
      pkmMode: "ioto",
      somethingNewerWrote: { a: 1 },
      remotes: [{ name: "g", type: "git", url: "u", branch: "main", tokenId: "t", excludeSelf: true, futureField: 7 }],
    });
    expect(out.pkmMode).toBe("ioto");
    expect(out.somethingNewerWrote).toEqual({ a: 1 });
    const r = (out.remotes as Record<string, unknown>[])[0];
    expect(r.tokenId).toBe("t");
    expect(r.futureField).toBe(7);
  });

  it("leaves a non-array remotes value exactly as found", () => {
    const out = migrateV5Settings({ schemaVersion: 4, remotes: "nonsense" });
    expect(out.remotes).toBe("nonsense");
    expect(out.schemaVersion).toBe(5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/migration.test.ts -t migrateV5Settings`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

新建 `src/core/v5Migration.ts`:

```ts
/**
 * v4 -> v5: each remote's `excludeSelf` boolean becomes a general direction rule.
 *
 * The boolean said exactly what `items.community["config-sync"].direction = "none"` says, and one
 * rule with two spellings drifts. The conversion is the whole migration: no other field moves, and
 * everything this migration does not recognise rides through untouched (invariant II.1).
 */
import { SELF_ITEM_ID, SELF_ITEM_SECTION } from "./catalog";
import { isPlainObject } from "./sanitize";

type Doc = Record<string, unknown>;

export function migrateV5Settings(input: Doc): Doc {
  if (input.schemaVersion !== 4) return input;
  const doc: Doc = { ...input, schemaVersion: 5 };
  // A non-array `remotes` is not data any build could read; it is left exactly as found rather than
  // replaced, the same way the earlier migrations treat a value they cannot walk.
  if (!Array.isArray(doc.remotes)) return doc;
  doc.remotes = doc.remotes.map((raw) => {
    if (!isPlainObject(raw)) return raw;
    const { excludeSelf, ...rest } = raw;
    if (excludeSelf !== true) return rest;
    const existing = isPlainObject(rest.items) ? { ...(rest.items as Doc) } : {};
    const bucket = isPlainObject(existing[SELF_ITEM_SECTION]) ? { ...(existing[SELF_ITEM_SECTION] as Doc) } : {};
    bucket[SELF_ITEM_ID] = { ...(isPlainObject(bucket[SELF_ITEM_ID]) ? (bucket[SELF_ITEM_ID] as Doc) : {}), direction: "none" };
    existing[SELF_ITEM_SECTION] = bucket;
    return { ...rest, items: existing };
  });
  return doc;
}
```

`settingsMigration.ts`:`CURRENT_SCHEMA = 5`;`MIGRATABLE_SCHEMAS = [2, 3, 4]`;模块头注释里把迁移链改成 `v2Migration.ts, then v4Migration.ts, then v5Migration.ts`,并把 `SettingsLoad` 的 `migrate` 注释改成「v2 / v3 / v4 文档:逐级带上来」。

`main.ts`(约 2281):

```ts
      const v3 = load.from === 2 ? migrateV2Settings(data ?? {}) : { document: data ?? {}, carriedDeviceOptOuts: undefined };
      const v4 = load.from <= 3 ? migrateV4Settings(v3.document) : { document: v3.document, freeze: [] };
      const migrated = migrateV5Settings(v4.document);
```

—— 之后原本用 `v4.document` 的地方改用 `migrated`,`v4.freeze` 照旧。加上 `import { migrateV5Settings } from "./core/v5Migration";`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/migration.test.ts tests/schemaFiles.test.ts`
Expected: PASS —— 其中 `schemaVersion.const agrees with CURRENT_SCHEMA` 由红转绿(schema 已经是 5)。

- [ ] **Step 5: 提交**

```bash
git add src/core/v5Migration.ts src/core/settingsMigration.ts src/main.ts tests/migration.test.ts
git commit -m "feat(migration): fold excludeSelf into the per-remote direction rules (schema v5)"
```

---

### Task 5:四个接缝与设置表单改读新规则(行为不变)

**Files:**
- Modify: `src/main.ts:532`、`:902`、`:910`、`:930`、`:977`
- Modify: `src/core/ConfigSyncCore.ts`(`planImport` / `applyImport` / `pushExternal` 的 `opts`)
- Modify: `src/core/status.ts:466`(`diffRemote` 的 `opts`)
- Modify: `src/ui/SyncCenterView.ts:4094`、`:4143`
- Modify: `src/ui/SettingTab.ts:336-395`(`RemoteDraft` / `toDraft` / `toCandidate`)、`:3754`、`:3971-3979`
- Test: `tests/remoteExclusion.test.ts`(新建)

**Interfaces:**
- Consumes: Task 2 的 `refsBlockedFor` / `itemDirection` / `withItemDirection`;`SELF_ITEM_REF`(`catalog.ts`)
- Produces: 三个 core 入口的 opts 从 `{ excludeSelf: boolean }` 变成 `{ skipRefs: ItemRef[] }`

**为什么这一步行为不变:** 迁移把 `excludeSelf: true` 变成 self 项 `direction: "none"`,而 `refsBlockedFor` 对这样一份规则在两个方向上都只返回 `[SELF_ITEM_REF]` —— 与今天写死的表达式逐值相等。

- [ ] **Step 1: 写失败测试**

新建 `tests/remoteExclusion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { refsBlockedFor } from "../src/core/remoteRules";
import { SELF_ITEM_REF } from "../src/core/catalog";
import { RemoteItems } from "../src/core/types";

// The bridge this task rests on: a migrated excludeSelf remote must produce exactly the list the
// four seams were hard-coding, in both directions. If this ever stops holding, the "behaviour
// unchanged" claim of schema v5 stops holding with it.
describe("migrated excludeSelf equals the old hard-coded skip list", () => {
  const migrated: RemoteItems = { community: { "config-sync": { direction: "none" } } };

  it("skips exactly the self item on push", () => {
    expect(refsBlockedFor(migrated, "push")).toEqual([SELF_ITEM_REF]);
  });

  it("skips exactly the self item on pull", () => {
    expect(refsBlockedFor(migrated, "pull")).toEqual([SELF_ITEM_REF]);
  });

  it("skips nothing when the remote had no rules", () => {
    expect(refsBlockedFor(undefined, "push")).toEqual([]);
    expect(refsBlockedFor(undefined, "pull")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/remoteExclusion.test.ts`
Expected: 若 `SELF_ITEM_REF` 恰为 `"community/config-sync"` 则此测试可能直接通过 —— 那也没关系,它是护栏而非驱动。**真正要看的是 `npx tsc --noEmit` 仍然报错**(接缝还在读 `excludeSelf`),那就是本任务的失败信号。

- [ ] **Step 3: 写实现**

**core 三处 opts 换形状**(`ConfigSyncCore.ts`):

```ts
export async function planImport(ctx: CoreContext, reader: ExternalStoreReader, opts: { skipRefs: ItemRef[] }): Promise<PendingPull>
export async function pushExternal(ctx: CoreContext, writer: ExternalStoreWriter, opts: { skipRefs: ItemRef[] }): Promise<GroupResult[]>
```

`PendingPull` 的 `excludeSelf: boolean` 改成 `skipRefs: ItemRef[]`。每个接缝把 `opts.excludeSelf && isSelfStoreRel(rel)` 换成同一个形状的判定,**用它自己作用域里已有的 group 列表**建:

```ts
// A rel belongs to a skipped item when its owning group's ref is in the list. isSelfStoreRel stays
// the self item's fast path: it is the one ref whose rels are known without a group lookup, and it
// keeps working while a device's own registry is still empty.
const skipped = (rel: string): boolean => {
  if (opts.skipRefs.length === 0) return false;
  if (opts.skipRefs.includes(SELF_ITEM_REF) && isSelfStoreRel(rel)) return true;
  const ref = resolveGroupByStoreRel(groups, rel)?.ref;
  return ref !== undefined && opts.skipRefs.includes(ref);
};
```

`resolveGroupByStoreRel` 来自 `pathing.ts`(已导出)。各接缝的 `groups` 分别是:

| 接缝 | 作用域里的 group 列表 |
|---|---|
| `planImport` | `localGroups`(已有)与 `remoteGroups`(已有)—— 两者串起来查,本地查不到就查远端,和 `owningGroupName` 今天的取舍一致 |
| `pushExternal` | `manifest.groups`(已有,来自 `loadManifest(ctx)`) |
| `diffRemote`(`status.ts:467-472`) | `manifest.groups` 与 `remoteGroups`,两者都已在作用域里,串法同 `planImport` |

`applyImport` 里 `pending.excludeSelf && ref === SELF_ITEM_REF` 改成 `pending.skipRefs.includes(ref)` —— 这一处本来就拿到的是 ref,不需要 rel 解析。`pushExternal` 的镜像删除豁免用同一个 `skipped(rel)`。

**`status.ts` 的 `diffRemote`** 把 `opts: { excludeSelf: boolean }` 换成 `{ skipRefs: ItemRef[] }`,`:502` 与 `:516` 两处按上表建 `skipped`。

**`main.ts` 五处调用**:

```ts
import { refsBlockedFor } from "./core/remoteRules";
// :532 与 :910 —— 这两处问的是「拉方向上谁不算」
const ignore = refsBlockedFor(remote.items, "pull");
// :902 diffRemote —— 比较两个方向都要看,取并集
const skipRefs = [...new Set([...refsBlockedFor(remote.items, "pull"), ...refsBlockedFor(remote.items, "push")])];
// :930 planImport
{ skipRefs: refsBlockedFor(remote.items, "pull") }
// :977 pushExternal
{ skipRefs: refsBlockedFor(remote.items, "push") }
```

**`SyncCenterView.ts`**:`:4094` 的 `remote.excludeSelf === true && g.name === SELF_GROUP_NAME` 改成 `refsBlockedFor(remote.items, "pull").includes(SELF_ITEM_REF) && g.name === SELF_GROUP_NAME`;`:4143` 那条 selfnote 的条件同样改。两处都只是把布尔换成同值的查询,文案一字不动。

**`SettingTab.ts`** —— 这一处最容易出事:`RemoteDraft` 今天不带 `items`,而 `toCandidate` 从 draft 重建整个 remote,**改个名字就会把规则全擦掉**。所以:

```ts
interface RemoteDraft {
  name: string;
  type: "vault" | "git";
  storePath: string;
  url: string;
  branch: string;
  subdir: string;
  items: RemoteItems | undefined;   // carried opaquely: the form never edits it, and rebuilding a
  passphraseId: string;             // remote from a draft that dropped it would erase every rule
  tokenId: string;
  username: string;
}
```

`toDraft`:`items: r.items`、`passphraseId: r.passphraseId ?? ""`,删掉 `excludeSelf`。
`toCandidate`:`if (d.items !== undefined) c.items = d.items;`、`if (d.passphraseId !== "") c.passphraseId = d.passphraseId;`,删掉 `if (d.excludeSelf) ...`。
`:3754` 新建草稿:`items: undefined, passphraseId: ""`,去掉 `excludeSelf: false`。
`:3971-3979` 那个开关**保留**,只是改成读写新形状:

```ts
    const selfExcluded = itemDirection(draft.items, SELF_ITEM_REF) === "none";
    new ToggleComponent(selfLine).setValue(selfExcluded).onChange((v) => {
      if (!this.host.settingsWritable()) return;
      draft.items = withItemDirection(draft.items, SELF_ITEM_REF, v ? "none" : "both");
      void this.saveRemotes();
    });
```

补上 import:`RemoteItems`(`../core/types`)、`itemDirection` / `withItemDirection`(`../core/remoteRules`)、`SELF_ITEM_REF`(`../core/catalog`)。

**不要删这个开关。** Plan 2 把它变成面板上的一行之后再删;现在删会留下一个「设不了」的空档。

- [ ] **Step 4: 跑全套**

Run: `npx tsc --noEmit && npx vitest run && npx eslint .`
Expected: 类型干净;测试全绿;lint 不超过既有基线(0 error / 57 warn)。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor(remote): the four seams read direction rules instead of a self-only boolean"
```

---

### Task 6:文档追平

**Files:**
- Modify: `docs/ARCHITECTURE.md`(Data model 一节的 `data.json` 条目;`ConfigSyncCore` 条目里 `excludeSelf` 的整段说明)
- Modify: `UPGRADING.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: 前五个 Task 的最终形状
- Produces: 无代码接口

- [ ] **Step 1: 改 ARCHITECTURE.md**

Data model 一节里 `data.json, locked-local preset (selfPresetRules)` 那一行,把内容从「`rootPath`, `remotes` (with their `tokenId` names)」改成「`rootPath`, `remotes`(含各自的 `tokenId` / `passphraseId` 名字与 `items` 方向规则)」,并补一句:方向规则嵌在 remote 内部,因此自动继承这条 locked-local strip,不需要新的保护规则。

`ConfigSyncCore.ts` 那一条里所有讲 `excludeSelf` 的句子换成 `skipRefs`:说明它是**一组 ItemRef**,由 `remoteRules.ts` 的 `refsBlockedFor` 按方向算出;`isSelfStoreRel` 仍然是 self 项的快路。

- [ ] **Step 2: 改 UPGRADING.md**

加一节 `2.25.0`:说明 `schemaVersion` 升到 5、`excludeSelf` 自动转成方向规则、**用户无需任何操作**、以及旧版本读不了新文档(向前拒绝那条既有保护)。

- [ ] **Step 3: 改 CHANGELOG.md**

按既有格式加 `2.25.0` 条目,本计划部分只写:per-remote 方向规则的数据模型与迁移落地,行为不变。

- [ ] **Step 4: 核对**

Run: `npx vitest run tests/schemaFiles.test.ts`
Expected: PASS(schema 与产出者一致)

人工核对:`grep -rn "excludeSelf" src docs` 只应剩下迁移代码与 UPGRADING 里的历史说明。

- [ ] **Step 5: 提交**

```bash
git add docs UPGRADING.md CHANGELOG.md
git commit -m "docs: per-remote direction rules replace excludeSelf"
```

---

## 完成标准

- `npx tsc --noEmit`、`npx vitest run`、`npx eslint .` 三绿(lint 不超既有基线)。
- `grep -rn "excludeSelf" src/` 只在 `v5Migration.ts` 里出现。
- 真机冒烟:把 2.24.3 写的 `data.json` 放进 dev vault,启动 → `schemaVersion` 变成 5,原来勾了「Config Sync 自己的设置不参与」的 remote 现在带 `items.community["config-sync"].direction = "none"`,设置里那个开关仍然勾着,Pull / Push / 比较的行为与升级前一致。
