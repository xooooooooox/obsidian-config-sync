# Settings 面板两层模型补齐 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「舰队级默认 + 本机级例外」两层模型补齐到 settings panel 卡片的整文件行与每键行,并修掉那一行现存的失效显示。

**Architecture:** 本机例外一律住在 localStorage,永不进 data.json、永不进 store。新表 `config-sync-device-fields`(`ItemRef → 规则 pattern → "not-synced"`)经 `CoreContext.fieldExceptions`(与既有 `switchExceptions` 同一条通路)进入纯核;三条语义在 `modes.ts` 里各自落到既有的**顶层键**机制上——capture 用 prior store 值覆盖、apply 走 `classPreserve`、比较走 `classIgnore`。UI 侧复用 `enablementRow.ts` 已有的两段式 producer,settings panel 只是它缺失的那个消费者。

**Tech Stack:** TypeScript(strict)· esbuild · vitest · Obsidian API · 纯核零 Node 依赖(必须能在移动端跑)

**Spec:** `docs/superpowers/specs/2026-08-16-settings-sync-two-layers-design.md`

## Global Constraints

- **纯核不许 import Obsidian / Node**:`src/core/` 只能操作注入的 `FileIO`/`PluginHost`。
- **Schema-first**:改持久化形状先改 `schema/*.schema.json`;`tests/schemaFiles.test.ts` 是闸门。
- **Design-first**:改 UI 结构先改 `docs/design/DESIGN.md`。定稿 mockup:https://claude.ai/code/artifact/154ad838-54b6-43e8-8a1c-7106dcfcf559
- **lint 门槛**:0 error / ≤58 warning,**零新增**,不许 inline disable。
- **CSS 只用 Obsidian 主题变量**:`./scripts/check-no-hardcoded-color.sh` 必须过。
- **容错读**:localStorage 表任何无法识别的形状读作「本设备无例外」——永不抛错、**永不回写**。
- **顶层键**:本轮的设备例外与既有 class 规则一样,**只作用于顶层键**(核心不变式:「Class field rules act on top-level keys only」)。
- **不许 Claude 署名**:commit message / PR 文本一律不带任何 AI 署名尾注。
- **绝不在真实 vault 里冒烟**,只用 `dev/vault/`。
- 文案:`Per-key rules decide — jump to them ↓`(可见文字,不是 tooltip)。`Follows the default` / `Not synced here` 沿用既有常量。

---

### Task 1: 本机例外表(数据层)

**Files:**
- Create: `src/core/deviceFields.ts`
- Modify: `schema/local-storage.schema.json`
- Test: `tests/deviceFields.test.ts`

**Interfaces:**
- Consumes: `ItemRef`(`src/core/types.ts`)
- Produces:
  - `DEVICE_FIELDS_KEY = "config-sync-device-fields"`
  - `type DeviceFields = Record<string, Record<string, "not-synced">>`
  - `parseDeviceFields(raw: unknown): DeviceFields`
  - `deviceFieldExcepted(table: DeviceFields, ref: string, pattern: string): boolean`
  - `deviceFieldPatterns(table: DeviceFields, ref: string): string[]`
  - `withDeviceField(table: DeviceFields, ref: string, pattern: string, excepted: boolean): DeviceFields`
  - `fieldExceptionsByGroupName(table: DeviceFields, groups: readonly SyncGroup[]): Record<string, string[]>`

- [ ] **Step 1: 写失败测试**

```ts
// tests/deviceFields.test.ts
import { describe, expect, it } from "vitest";
import {
  DEVICE_FIELDS_KEY,
  deviceFieldPatterns,
  fieldExceptionsByGroupName,
  parseDeviceFields,
  withDeviceField,
} from "../src/core/deviceFields";
import type { SyncGroup } from "../src/core/types";

describe("parseDeviceFields", () => {
  it("reads a well-formed table", () => {
    const raw = JSON.stringify({ "core/graph": { colorGroups: "not-synced" } });
    expect(parseDeviceFields(raw)).toEqual({ "core/graph": { colorGroups: "not-synced" } });
  });

  it("unreadable shapes read as no exceptions, never throw", () => {
    for (const raw of [undefined, null, 42, "not json", "[]", JSON.stringify([1, 2])]) {
      expect(parseDeviceFields(raw)).toEqual({});
    }
  });

  it("drops entries whose value is not a known state, keeps the rest", () => {
    const raw = JSON.stringify({ "core/graph": { colorGroups: "not-synced", other: "bogus" } });
    expect(parseDeviceFields(raw)).toEqual({ "core/graph": { colorGroups: "not-synced" } });
  });

  it("drops an item whose whole map is empty after filtering", () => {
    expect(parseDeviceFields(JSON.stringify({ "core/graph": { a: "bogus" } }))).toEqual({});
  });
});

describe("withDeviceField", () => {
  it("adds and removes without mutating the input", () => {
    const before = {};
    const set = withDeviceField(before, "core/graph", "colorGroups", true);
    expect(before).toEqual({});
    expect(set).toEqual({ "core/graph": { colorGroups: "not-synced" } });
    expect(withDeviceField(set, "core/graph", "colorGroups", false)).toEqual({});
  });
});

describe("fieldExceptionsByGroupName", () => {
  it("re-keys ItemRef -> group name, skipping groups with no ref and refs with no group", () => {
    const groups: SyncGroup[] = [
      { name: "graph", ref: "core/graph", path: "{configDir}/graph.json", type: "file", devices: "all" },
      { name: "orphan", path: "x.json", type: "file", devices: "all" },
    ];
    const table = { "core/graph": { colorGroups: "not-synced" as const }, "core/gone": { k: "not-synced" as const } };
    expect(fieldExceptionsByGroupName(table, groups)).toEqual({ graph: ["colorGroups"] });
  });
});

it("exports the storage key verbatim", () => {
  expect(DEVICE_FIELDS_KEY).toBe("config-sync-device-fields");
});

it("deviceFieldPatterns returns [] for an unknown ref", () => {
  expect(deviceFieldPatterns({}, "core/graph")).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/deviceFields.test.ts`
Expected: FAIL — `Cannot find module '../src/core/deviceFields'`

- [ ] **Step 3: 写实现**

```ts
// src/core/deviceFields.ts
/**
 * THE per-key local exception table: which of THIS item's per-key rules this device has taken out
 * of sync, keyed the same way the lock, the baselines and the whole-file opt-out list are.
 *
 * It lives in localStorage and nowhere else: a datum true only of this device, stored in a
 * document that travels wholesale, is a datum another device's pull will overwrite. Same
 * discipline as deviceElements.ts — the two are siblings, one per layer.
 *
 * The inner key is the RULE'S PATTERN, verbatim as data.json's `settingsFile.rules` spells it —
 * not an expanded key name. Excepting a `plugins.*` rule excepts every key that rule covers, which
 * is the only reading that stays true when the document gains a key tomorrow.
 *
 * Every read is tolerant exactly the way parseDeviceElements is: a user or a half-finished write
 * can leave any shape here, and a device that cannot read its own table must still sync.
 * Unreadable ⇒ "no exception here" — never a load failure, and never a rewrite of what was found.
 */
import { SyncGroup } from "./types";

export const DEVICE_FIELDS_KEY = "config-sync-device-fields";

// One state only. "Is this key synced here?" has no on/off pair to choose between — that is the
// enablement layer's question, not this one.
export type DeviceFieldState = "not-synced";

// ItemRef -> rule pattern -> this device's exception.
export type DeviceFields = Record<string, Record<string, DeviceFieldState>>;

function isState(v: unknown): v is DeviceFieldState {
  return v === "not-synced";
}

export function parseDeviceFields(raw: unknown): DeviceFields {
  if (typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: DeviceFields = {};
  for (const [ref, patterns] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof patterns !== "object" || patterns === null || Array.isArray(patterns)) continue;
    const kept: Record<string, DeviceFieldState> = {};
    for (const [pattern, state] of Object.entries(patterns as Record<string, unknown>)) {
      if (isState(state)) kept[pattern] = state;
    }
    if (Object.keys(kept).length > 0) out[ref] = kept;
  }
  return out;
}

export function deviceFieldExcepted(table: DeviceFields, ref: string, pattern: string): boolean {
  return table[ref]?.[pattern] !== undefined;
}

export function deviceFieldPatterns(table: DeviceFields, ref: string): string[] {
  return Object.keys(table[ref] ?? {});
}

// Pure. Clearing the last pattern drops the item entry, so a round trip through the control leaves
// the stored string identical to how it started (same rule withEnablementRule follows).
export function withDeviceField(table: DeviceFields, ref: string, pattern: string, excepted: boolean): DeviceFields {
  const forRef = { ...(table[ref] ?? {}) };
  if (excepted) forRef[pattern] = "not-synced";
  else delete forRef[pattern];
  const next = { ...table };
  if (Object.keys(forRef).length === 0) delete next[ref];
  else next[ref] = forRef;
  return next;
}

// The bridge into the pure core: CoreContext keys device-local facts by GROUP NAME (the key every
// capture/apply/compare call site already holds), while this table — like the lock and the
// baselines — is keyed by ItemRef. One producer for the mapping, so the two key spaces never drift.
// A group with no ref has no identity to hold an exception by; a ref with no compiled group is a
// stale entry and is skipped rather than deleted (unknown ⇒ preserve).
export function fieldExceptionsByGroupName(table: DeviceFields, groups: readonly SyncGroup[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    if (g.ref === undefined) continue;
    const patterns = deviceFieldPatterns(table, g.ref);
    if (patterns.length > 0) out[g.name] = patterns;
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/deviceFields.test.ts`
Expected: PASS(7 个用例)

- [ ] **Step 5: 加 schema 条目**

在 `schema/local-storage.schema.json` 的 `properties` 里,紧挨 `config-sync-device-elements` 之后加:

```json
"config-sync-device-fields": {
  "$ref": "#/definitions/deviceFields",
  "description": "THIS device's exception table for per-key rules (stored as a JSON string). See the definition."
}
```

并在 `definitions` 里加:

```json
"deviceFields": {
  "type": "object",
  "description": "ItemRef -> rule pattern -> this device's exception. Written by src/core/deviceFields.ts; unreadable shapes read as an empty table and are never rewritten.",
  "additionalProperties": {
    "type": "object",
    "additionalProperties": { "type": "string", "const": "not-synced" }
  }
}
```

- [ ] **Step 6: 跑 schema 闸门 + 全量测试**

Run: `npx vitest run tests/schemaFiles.test.ts && npm test`
Expected: PASS。若 `schemaFiles.test.ts` 要求键名与源码常量对齐,按它的报错把 `DEVICE_FIELDS_KEY` 接进去。

- [ ] **Step 7: 提交**

```bash
git add src/core/deviceFields.ts tests/deviceFields.test.ts schema/local-storage.schema.json
git commit -m "feat(core): per-key device exception table"
```

---

### Task 2: 三条语义(capture / apply / 比较)

**Files:**
- Modify: `src/core/modes.ts`(`captureTransform` / `applyTransform` / `contentUnchanged`)
- Modify: `src/core/ConfigSyncCore.ts`(`CoreContext` + 访问器 + capture/apply 调用点)
- Modify: `src/core/status.ts`(比较调用点)
- Test: `tests/deviceFieldSemantics.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `fieldExceptionsByGroupName` 产物形状(`Record<groupName, string[]>`)
- Produces:
  - `CoreContext.fieldExceptions?: Record<string, string[]>`
  - `fieldExceptionsFor(ctx: CoreContext, group: SyncGroup): string[]`(`ConfigSyncCore.ts` 导出)
  - 三个 transform 各多一个**可选尾参** `deviceExcepted?: string[]`

- [ ] **Step 1: 写失败测试**

```ts
// tests/deviceFieldSemantics.test.ts
import { describe, expect, it } from "vitest";
import { applyTransform, captureTransform, contentUnchanged } from "../src/core/modes";
import { EVERYWHERE, SyncGroup } from "../src/core/types";

const group: SyncGroup = {
  name: "graph",
  ref: "core/graph",
  path: "{configDir}/graph.json",
  type: "file",
  devices: "all",
  mode: "fields",
  fields: [{ pattern: "colorGroups", sharing: EVERYWHERE, encrypted: false }],
};

const local = JSON.stringify({ colorGroups: ["mine"], scale: 1 }, null, 2) + "\n";
const store = JSON.stringify({ colorGroups: ["theirs"], scale: 1 }, null, 2) + "\n";

describe("capture with a device exception", () => {
  it("keeps the store's value for the excepted key — never publishes the local one", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["theirs"], scale: 1 });
  });

  it("does not invent the key when the store never had it", async () => {
    const bare = JSON.stringify({ scale: 1 }, null, 2) + "\n";
    const out = await captureTransform(group, local, null, "desktop", bare, null, ["colorGroups"]);
    expect(JSON.parse(out.content)).toEqual({ scale: 1 });
  });

  it("is idempotent — a second capture reproduces the same bytes", async () => {
    const first = await captureTransform(group, local, null, "desktop", store, null, ["colorGroups"]);
    const second = await captureTransform(group, local, null, "desktop", first.content, null, ["colorGroups"]);
    expect(second.content).toBe(first.content);
  });

  it("without the exception the local value wins, exactly as before", async () => {
    const out = await captureTransform(group, local, null, "desktop", store, null, []);
    expect(JSON.parse(out.content)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });
});

describe("apply with a device exception", () => {
  it("keeps this device's value and still applies the rest", async () => {
    const out = await applyTransform(group, store, local, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ colorGroups: ["mine"], scale: 1 });
  });

  it("with no local file the excepted key does not land", async () => {
    const out = await applyTransform(group, store, null, null, "desktop", null, ["colorGroups"]);
    expect(JSON.parse(out)).toEqual({ scale: 1 });
  });
});

describe("comparison with a device exception", () => {
  it("differing only in the excepted key reads as unchanged", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, ["colorGroups"])).toBe(true);
  });

  it("a real difference elsewhere still reads as changed", async () => {
    const moved = JSON.stringify({ colorGroups: ["mine"], scale: 2 }, null, 2) + "\n";
    expect(await contentUnchanged(group, moved, store, null, "desktop", null, ["colorGroups"])).toBe(false);
  });

  it("without the exception the same pair reads as changed", async () => {
    expect(await contentUnchanged(group, local, store, null, "desktop", null, [])).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/deviceFieldSemantics.test.ts`
Expected: FAIL — 多余实参被 TS 拒绝 / 断言不符

- [ ] **Step 3: 改 `modes.ts` 的三个 transform**

`captureTransform` 签名尾部加一个参数:

```ts
  priorOwnScopeContent?: string | null,
  // Patterns THIS device has excepted (deviceFields.ts). Semantics differ from every other rule
  // here: an exception is a device-local fact with NO fleet consensus behind it, so capture must
  // leave the store's existing value exactly as it found it. Stripping instead would let one
  // device's private decision delete another device's data on the next push.
  deviceExcepted?: string[]
```

在 `return { content: ... }` **之前**、`finalContent` 的 perElement 合并之后插入:

```ts
  // Device exceptions act on TOP-LEVEL keys only, like every other class rule here.
  const excepted = excludingPerElement(group, deviceExcepted ?? []);
  if (excepted.length > 0 && isPlainObject(finalContent)) {
    const priorObj = isPlainObject(priorStoreParsed) ? priorStoreParsed : {};
    const out: Record<string, unknown> = {};
    // Local's key order is preserved: an excepted key keeps its slot and only its VALUE comes
    // from the store, so a capture that changes nothing writes the same bytes it read.
    for (const [k, v] of Object.entries(finalContent)) {
      if (!keyMatchesAny(k, excepted)) {
        out[k] = v;
      } else if (k in priorObj) {
        out[k] = priorObj[k];
      }
      // else: the store never had it and this device must not contribute it — drop.
    }
    for (const [k, v] of Object.entries(priorObj)) {
      if (keyMatchesAny(k, excepted) && !(k in out)) out[k] = v;
    }
    finalContent = out;
  }
```

`applyTransform` 签名尾部加 `deviceExcepted?: string[]`,并把 `classPreserve` 改为:

```ts
  // An excepted key behaves exactly like an other-class key on this device: the store never gets
  // to place it here, and local's own value wins wherever local has one.
  const excepted = excludingPerElement(group, deviceExcepted ?? []);
  const classPreserve = [...other, ...(ownScopeContent === null ? own : []), ...excepted];
```

`contentUnchanged` 签名尾部加 `deviceExcepted?: string[]`,并把 `classIgnore` 改为:

```ts
  const excepted = excludingPerElement(group, deviceExcepted ?? []);
  // Symmetric with applyTransform's classPreserve — masked on BOTH sides, or the item reads as
  // to-capture forever.
  const classIgnore = [...other, ...(ownScopeContent === null ? own : []), ...excepted];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/deviceFieldSemantics.test.ts`
Expected: PASS(9 个用例)

- [ ] **Step 5: 把例外接进 `CoreContext` 与三个调用点**

`src/core/ConfigSyncCore.ts` 的 `CoreContext`,在 `switchExceptions` 之后加:

```ts
  // group name -> rule patterns THIS device has excepted (deviceFields.ts). Same shape and same
  // reason as switchExceptions above: a device-local fact the pure core must be TOLD, never read.
  // Optional — a bare test context has none.
  fieldExceptions?: Record<string, string[]>;
```

同文件加访问器(紧邻既有 `switchExceptions` 的访问器):

```ts
export function fieldExceptionsFor(ctx: CoreContext, group: SyncGroup): string[] {
  return ctx.fieldExceptions?.[group.name] ?? [];
}
```

改调用点,各自把 `fieldExceptionsFor(ctx, <effGroup|group>)` 作为新尾参传进去:
- `ConfigSyncCore.ts:814` `captureTransform(effGroup, …, existingSidecar)` → 追加实参
- `ConfigSyncCore.ts:821` `contentUnchanged(effGroup, …, existingSidecar)` → 追加实参
- `ConfigSyncCore.ts:861`/`:863`(无 sidecar 的分支)→ 同样追加
- `ConfigSyncCore.ts:1259`/`:1277` `applyTransform(...)` → 追加
- `src/core/status.ts:117` `contentUnchanged(effGroup, …, ownScope)` → 追加(`status.ts` 需 import `fieldExceptionsFor`)

- [ ] **Step 6: 把 spec §3.2 的编译规约钉成断言**

追加到 `tests/registry.test.ts`(不是语义测试文件——它测的是编译,归属那边)。

**用该文件里既有的构造方式**建一个 item:`synced: true`、`settingsFile.mode = "fields"`、`rules` 里有一条规则,**并且**留着一条 `fileRule`(例如 `{ sharing: { kind: "per-class", class: "desktop" }, encrypted: true }`)——模拟「先设过整文件规则,后来才加 per-key 规则」的残留。`compileItems(defs, settings)` 的签名见 `registry.ts:682`;实参怎么造,照该测试文件里现成的用法,**不要自创**。

断言恰好两条:

```ts
expect(group?.devices).toBe("all");
expect(group?.fileRule).toBeUndefined();
```

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS —— 这条不改任何行为,它把「fields 模式下 `fileRule` 不参与编译」这个既有事实钉住,防止 Task 6 的显示改动将来被某次「顺手也编译上」的改动拆掉。

- [ ] **Step 7: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全绿。既有用例不传新参,走 `?? []`,行为逐字节不变。

- [ ] **Step 8: 提交**

```bash
git add src/core/modes.ts src/core/ConfigSyncCore.ts src/core/status.ts tests/deviceFieldSemantics.test.ts
git commit -m "feat(core): honour per-key device exceptions in capture, apply and comparison"
```

---

### Task 3: main.ts 宿主接线

**Files:**
- Modify: `src/main.ts`
- Modify: `src/ui/SettingTab.ts`(只加 `SettingsHost` 的四个方法签名)

**Interfaces:**
- Consumes: Task 1 的全部导出;Task 2 的 `CoreContext.fieldExceptions`
- Produces(`SettingsHost` 新增四个方法):
  - `deviceFieldExceptedFor(ref: ItemRef, pattern: string): boolean`
  - `setDeviceFieldExcepted(ref: ItemRef, pattern: string, excepted: boolean): Promise<void>`
  - `deviceOptedOut(groupName: string): boolean`
  - `setDeviceOptOut(groupName: string, optedOut: boolean): Promise<void>`

- [ ] **Step 1: 加读写原语**

在 `main.ts` 加(位置紧邻 `deviceOptOutGroups`/`saveDeviceOptOutGroups`,`:1125` 一带,与它们同一段注释所辖):

```ts
  // Parsed at most once per load — this is read per rule row per render, same discipline as
  // deviceOptOutsCache above.
  private deviceFieldsCache: DeviceFields | null = null;

  // Unreadable ⇒ an empty table. Never thrown, and NEVER written back: a shape this build does not
  // recognise may be a newer build's, and rewriting it here would destroy that device's own answer.
  private deviceFields(): DeviceFields {
    if (this.deviceFieldsCache !== null) return this.deviceFieldsCache;
    this.deviceFieldsCache = parseDeviceFields(this.app.loadLocalStorage(DEVICE_FIELDS_KEY));
    return this.deviceFieldsCache;
  }

  private saveDeviceFields(table: DeviceFields): void {
    this.app.saveLocalStorage(DEVICE_FIELDS_KEY, JSON.stringify(table));
    this.deviceFieldsCache = table;
  }
```

`import { DEVICE_FIELDS_KEY, DeviceFields, deviceFieldExcepted, fieldExceptionsByGroupName, parseDeviceFields, withDeviceField } from "./core/deviceFields";`

- [ ] **Step 2: 喂给 CoreContext**

在构造 ctx 的地方(`main.ts:1796` 一带,`switchExceptions` 那一行旁)加:

```ts
      fieldExceptions: fieldExceptionsByGroupName(this.deviceFields(), this.compiledGroups),
```

`compiledGroups` 用该处已有的那份编译结果;不要另编译一次。

- [ ] **Step 3: 暴露给 UI**

在 `SettingsHost`(`SettingTab.ts:169-235` 那个 interface)加上 Interfaces 里的四个签名,并在 `main.ts` 的 settings-host 对象里实现:

```ts
      deviceFieldExceptedFor: (ref, pattern) => deviceFieldExcepted(this.deviceFields(), ref, pattern),
      setDeviceFieldExcepted: async (ref, pattern, excepted) => {
        this.saveDeviceFields(withDeviceField(this.deviceFields(), ref, pattern, excepted));
        // The comparison lens just moved — the panel and the status indicators must re-derive.
        await this.refreshStatus();
      },
```

`deviceOptedOut`/`setDeviceOptOut` **复用 Sync Center 宿主已有的那两个实现**(`main.ts:797` 一带)——把同一个表达式绑到 settings host 上,不要写第二份。

`refreshStatus` 用该文件里既有的那个状态刷新入口(Sync Center 宿主的 opt-out 写入用的是同一个);名字以源码为准,不要新造一个。

- [ ] **Step 4: 构建 + 全量测试**

Run: `npm run build && npm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/main.ts src/ui/SettingTab.ts
git commit -m "feat: wire the per-key device exception table into the core context and settings host"
```

---

### Task 4: 本机段 producer 改名(两层共用)

**Files:**
- Modify: `src/ui/enablementRow.ts`
- Modify: `src/ui/SyncCenterView.ts`(调用点)
- Test: `tests/enablementRow.test.ts`、`tests/fateChipIcons.test.ts`(改引用)

**Interfaces:**
- Produces:`optOutLocalSegment(optedOut: boolean): RowSegment`、`buildOptOutLocalMenu(optedOut: boolean, handlers: FileLocalMenuHandlers): LocalMenuItem[]`

- [ ] **Step 1: 改测试里的名字先跑红**

把 `tests/enablementRow.test.ts` 与 `tests/fateChipIcons.test.ts` 里的 `fileLocalSegment` → `optOutLocalSegment`、`buildFileLocalMenu` → `buildOptOutLocalMenu`。

Run: `npx vitest run tests/enablementRow.test.ts tests/fateChipIcons.test.ts`
Expected: FAIL — 导出不存在

- [ ] **Step 2: 改名并更新注释**

`enablementRow.ts` 里两个函数改名。注释同步改为「两层共用」:

```ts
// The local half alone — shared by BOTH layers that have a two-state local answer: the whole-file
// opt-out (`Settings sync`) and a per-key rule's own exception. Same states, same words, so it is
// one producer; a second copy would be a second place for "not synced here" to drift.
export function optOutLocalSegment(optedOut: boolean): RowSegment {
```

`fileEnablementRowModel` **名字不动**——它的 fleet 半边确实是文件专属的 `FileSharing`。

- [ ] **Step 3: 更新 Sync Center 调用点**

`SyncCenterView.ts` 的 import 与 `:3073`、`:3113` 两处调用改名。

- [ ] **Step 4: 跑测试 + 构建**

Run: `npm test && npm run build`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/ui/enablementRow.ts src/ui/SyncCenterView.ts tests/enablementRow.test.ts tests/fateChipIcons.test.ts
git commit -m "refactor(ui): one local-segment producer for both opt-out layers"
```

---

### Task 5: A′ 行形态(改名 + eye 归位)

**Files:**
- Modify: `src/ui/SettingTab.ts`(`renderSettingsFilePathRow`,`:1385-1529`)
- Modify: `styles.css`
- Modify: `docs/design/DESIGN.md`

**Interfaces:** 无新导出。

- [ ] **Step 1: 先改 DESIGN.md**

在两段式行那一节(`:205-222`)的适用范围里补上 settings panel 的 `Settings sync` 行;并记下 A′:文件名行不带标签、eye 随文件名右推、**不得**用 `.config-sync-scrow-end`(`grid-column:4`,会与 `1/-1` 跨列重叠)。

- [ ] **Step 2: 改 CSS**

```css
/* A′: the eye is an action on the FILE, so it rides the filename line, right-flushed inside the
   existing pathhost flex. Not .config-sync-scrow-end — that is grid-column:4 and would overlap
   .config-sync-card-pathline's 1/-1 span. */
.config-sync-card-pathline .config-sync-card-previewicon { margin-left: auto; flex: none; }
```

- [ ] **Step 3: 改渲染**

`"Settings file"` 这个标签在 `SettingTab.ts` 里出现 **三处**,全部改成 `"Settings sync"` —— `:1356`(zone kind `none`)、`:1360`(zone kind `state-only`)、`:1400`(path 行,即 A′ 的第 1 行)。漏掉前两处会让同一个词在同一个设置页里有两种叫法。

`renderSettingsFilePathRow` 里:
1. `line1` 的标签文本 `"Settings file"` → `"Settings sync"`;
2. 把 `previewIcon` 及其两个事件监听整块从 `slots.aux` 移到 `line2` 的 `pathHost` 末尾(**编辑态与非编辑态都要 append**,否则编辑时它会消失——见 §5.1 约束 3);
3. `line1` 的 aux 槽保持空 div(列宽不变)。

- [ ] **Step 4: 构建 + 冒烟**

Run: `npm run build && npm run smoke:install`
然后在 `dev/vault` 里:点 eye 开关预览、点文件名进编辑态确认 eye 仍在、`Reset to default` 与 eye 不打架、Escape 取消。

- [ ] **Step 5: 提交**

```bash
git add src/ui/SettingTab.ts styles.css docs/design/DESIGN.md
git commit -m "feat(ui): settings sync row — rename and move the file preview onto the filename line"
```

---

### Task 6: fields 模式下的那一格

**Files:**
- Modify: `src/ui/SettingTab.ts`
- Modify: `styles.css`
- Modify: `docs/design/DESIGN.md`

- [ ] **Step 1: 先改 DESIGN.md**

`:188` 的 `airplay` 条目改为**收窄**:仅用于 per-element array rule 的 picker(它没有本机层);删掉「settings-file row 的 per-key-rules-active 禁用态」那一段,改为记录新的 dim `settings-2` + 就地说明。

- [ ] **Step 2: 改渲染**

**先读 Task 5 落下的代码**:这一步改的是同一个函数 `renderSettingsFilePathRow`。Task 5 已经把 eye 从 `slots.aux` 移到了文件名行(`line2` 的 `pathHost` 末尾),并把三处标签改成了 `Settings sync`。**这两样都必须原样保留** —— 本步只改 `locked` 分支里 sharing 与 lock 两个槽的画法,不得回退 Task 5 的任何一处。

`renderSettingsFilePathRow` 里,当 `locked`(= `hasKeyRules(item)`)为真时:
1. **不读 `fileRule`**——sharing 与 lock 都不读(§3.2:fields 模式下 `fileRule` 不参与任何显示与编译);
2. sharing 槽画 dim `settings-2`,`role="button"`、`tabindex="0"`,`aria-label` = `Per-key rules decide — jump to them`,点击/Enter/Space 滚动并高亮本卡的 per-key 规则区;
3. lock 槽留空;
4. 在这一行下方加一行可见的就地说明 `Per-key rules decide — jump to them ↓`,同为点击目标;
5. 删除 `PER_KEY_RULES_ACTIVE_HINT` 常量(`:283`)及其唯一用处(`:1526`)。

新常量放在 `SettingTab.ts` 顶部常量区:

```ts
// Visible text, not a tooltip: this row is unreadable on a phone precisely because the old
// explanation only existed on hover. The dim settings-2 carries the same sentence without the
// arrow as its aria-label — one sentence, one producer.
const PER_KEY_RULES_JUMP_TEXT = "Per-key rules decide — jump to them";
```

- [ ] **Step 3: 构建 + 冒烟(桌面 + 手机)**

Run: `npm run build && npm run smoke:install`
在 `dev/vault`:给某项加一条 per-key 规则 → 该行 sharing 变 dim `settings-2`、lock 空白、下方出现可见说明;点击后滚动并高亮规则区。**再在 `body.is-phone` 下跑一遍**,确认说明是可见文字。
另造一个 `fileRule.encrypted: true` 且有 per-key 规则的项,确认 lock 格**空白**(不画失效的锁)。

- [ ] **Step 4: 提交**

```bash
git add src/ui/SettingTab.ts styles.css docs/design/DESIGN.md
git commit -m "fix(ui): a fields-mode item no longer shows a whole-file rule it does not have"
```

---

### Task 7: `SETTINGS SYNC` 的本机例外列

**Files:**
- Modify: `src/ui/SettingTab.ts`

- [ ] **Step 1: 抽出通用的本机段画法**

现有 `renderLocalSegment`(`:1164`)是 enablement 专用的(`list`/`elementId`/`DeviceElementState`)。抽出只吃「段 + 是否例外 + 菜单」的底层画法,让 enablement 版与新的 opt-out 版都走它——DOM 结构一份,不许复制:

```ts
  // The local segment's PAINT, shared by every layer that has one: the enablement exception, the
  // whole-file opt-out, and a per-key rule's own exception. What each layer differs in is its
  // model and its menu, not its shape — so the shape lives here once.
  private paintLocalSegment(
    cell: HTMLElement,
    opts: { seg: RowSegment; isException: boolean; showEyebrow: boolean; menu: () => Menu }
  ): void {
    cell.createSpan({ cls: "config-sync-tworow-vline" });
    const wrap = cell.createDiv({ cls: `config-sync-tworow-localcell${opts.isException ? " is-set" : ""}` });
    if (opts.showEyebrow) wrap.createSpan({ cls: "config-sync-tworow-eyebrow", text: THIS_DEVICE_EYEBROW });
    const local = wrap.createSpan({ cls: "config-sync-tworow-seg", attr: { "aria-label": opts.seg.tooltip } });
    if (opts.seg.icon !== null) setIcon(local.createSpan({ cls: "config-sync-tworow-ic" }), opts.seg.icon);
    setIcon(local.createSpan({ cls: "config-sync-tworow-chev" }), "chevrons-up-down");
    this.wireMenuTrigger(local, opts.menu);
  }
```

然后把既有的 `renderLocalSegment` 改成只负责「算出模型 + 组装 enablement 菜单」,末尾调用 `paintLocalSegment`。**行为必须逐像素不变**——这一步是纯重构,冒烟时先确认 `Enabled on` 那一列跟改动前一模一样,再往下做。

- [ ] **Step 2: 在 `SETTINGS SYNC` 行接上**

`renderSettingsFilePathRow` 的 `line1` 末尾加本机段。fields 模式(Task 6 的分支)同样要画——它是另一份数据:

```ts
    const optedOut = this.host.deviceOptedOut(def.groupName);
    this.paintLocalSegment(line1, {
      seg: optOutLocalSegment(optedOut),
      isException: optedOut,
      showEyebrow: true,
      menu: () => {
        const menu = new Menu();
        // buildOptOutLocalMenu is the SAME producer the Sync Center's own row asks (§5.3) — two
        // entrances, one entry list, so they cannot offer different choices.
        for (const entry of buildOptOutLocalMenu(optedOut, {
          follow: () => void this.host.setDeviceOptOut(def.groupName, false).then(() => this.renderItemCard(wrap, def)),
          optOut: () => void this.host.setDeviceOptOut(def.groupName, true).then(() => this.renderItemCard(wrap, def)),
        })) {
          menu.addItem((i) => {
            i.setTitle(entry.title).setChecked(entry.checked).onClick(entry.action);
            if (entry.icon !== null) i.setIcon(entry.icon);
          });
        }
        return menu;
      },
    });
```

`def.groupName` 是这张卡对应的编译组名(`SettingTab` 里已在别处这样取用);若该处的取法不同,以源码为准,**不要新造一个名字来源**。

- [ ] **Step 3: 构建 + 冒烟**

Run: `npm run build && npm run smoke:install`
在 `dev/vault`:设「不在本设备同步」→ Sync Center 对应行应立刻读作 `— Not synced on this device`(两个入口同一份数据);再改回 `Follows the default` 复原。

- [ ] **Step 4: 提交**

```bash
git add src/ui/SettingTab.ts
git commit -m "feat(ui): settings sync carries this device's own answer in the settings panel too"
```

---

### Task 8: 每键规则行的本机例外列 + 词汇统一

**Files:**
- Modify: `src/ui/SettingTab.ts`(`renderRuleRow`,`:1675`)
- Test: `tests/enablementRow.test.ts`(补一条收窄断言)

- [ ] **Step 1: 写失败测试(词汇收窄)**

```ts
// tests/enablementRow.test.ts —— 追加
import { FIELD_SHARING_OPTIONS } from "../src/ui/itemCard";
import { ruleIcon } from "../src/ui/enablementRow";
import { sharingIcon } from "../src/ui/itemCard";

it("a per-key rule row speaks the enablement vocabulary; airplay survives only where there is no local layer", () => {
  // per-key rows now have a local layer -> users, never airplay
  expect(FIELD_SHARING_OPTIONS.map(ruleIcon)).not.toContain("airplay");
  // per-element array rows still have none -> airplay is still their this-device glyph
  expect(sharingIcon({ kind: "this-device" })).toBe("airplay");
});
```

Run: `npx vitest run tests/enablementRow.test.ts`
Expected: PASS 或 FAIL 皆可能——若 `FIELD_SHARING_OPTIONS` 未导出,先导出它;这条断言的作用是把 §5.5 的收窄钉住。

- [ ] **Step 2: 规则行改两段式**

`renderRuleRow` 里:
1. `renderSharingPicker` 增加 `iconFor: ruleIcon, labelFor: ruleLabel`——第四挡随之由 `airplay`/`This device` 变为 `users`/`Each device decides`。**存储值不变**;
2. 行尾加本机段:

```ts
    const ref = itemRef(storageSection(def.section), def.id); // 用该文件里既有的 ref 取法,不要新造
    const excepted = this.host.deviceFieldExceptedFor(ref, row.key);
    this.paintLocalSegment(fr, {
      seg: optOutLocalSegment(excepted),
      isException: excepted,
      // `this device` is the rules zone's COLUMN HEADER (step 3), so the member rows carry no eyebrow
      showEyebrow: false,
      menu: () => {
        const menu = new Menu();
        for (const entry of buildOptOutLocalMenu(excepted, {
          follow: () => void this.host.setDeviceFieldExcepted(ref, row.key, false).then(() => this.refreshCardBody(wrap, def)),
          optOut: () => void this.host.setDeviceFieldExcepted(ref, row.key, true).then(() => this.refreshCardBody(wrap, def)),
        })) {
          menu.addItem((i) => {
            i.setTitle(entry.title).setChecked(entry.checked).onClick(entry.action);
            if (entry.icon !== null) i.setIcon(entry.icon);
          });
        }
        return menu;
      },
    });
```

3. 规则区的 zone header 那一行加 `this device` 列头(`config-sync-scrow-col4` + `THIS_DEVICE_EYEBROW`),成员行**不重复** eyebrow——与 `renderCarrierElements`(`:1331-1334`)一致;
4. `renderPerElementRow`(`:1772`)**不动**:它没有本机层(§2)。

- [ ] **Step 3: 构建 + 全量测试 + 冒烟**

Run: `npm test && npm run build && npm run smoke:install`
在 `dev/vault`:给某键设「不在本设备同步」→ Capture 一次 → 该键在 store 里的值**逐字节不变**(用 eye 预览或直接看 store 文件);Sync Center 不得出现该项的 to-capture。

- [ ] **Step 4: 提交**

```bash
git add src/ui/SettingTab.ts tests/enablementRow.test.ts
git commit -m "feat(ui): each per-key rule carries this device's own exception"
```

---

### Task 9: 文档现时化

**Files:**
- Modify: `docs/ARCHITECTURE.md`、`docs/GUIDE.md`、`README.md`、`README.zh.md`
- Modify: `CLAUDE.md`(数据词汇一节)

- [ ] **Step 1: ARCHITECTURE.md**

在 localStorage 键那一段(`:627-652` 一带)登记 `config-sync-device-fields`;在 Core invariants 里补一条:**本机例外的 capture 语义是「保留 store 既有值」,不是 strip**,并写明理由(一台设备的局部决定不得删除别人的数据)。

- [ ] **Step 2: GUIDE.md**

在 Field rules 那一节说明:每条 per-key 规则现在有两层——共享的默认答案,和这台设备自己的例外;例外只影响这台设备,store 里的值原样保留。`Settings sync` 一节补上 settings panel 现在也有这一列。

- [ ] **Step 3: CLAUDE.md**

「Data vocabulary」一节的 localStorage 键清单里加上 `config-sync-device-fields`。

- [ ] **Step 4: README.md / README.zh.md**

一句话即可,两份保持一致。

- [ ] **Step 5: 四道门槛全跑**

Run: `npm run build && npm test && npm run lint && ./scripts/check-no-hardcoded-color.sh`
Expected: 全绿,lint 零新增 warning。

- [ ] **Step 6: 提交**

```bash
git add docs README.md README.zh.md CLAUDE.md
git commit -m "docs: per-key device exceptions"
```

---

## 收尾验收(全部任务完成后,交付前)

- [ ] **防数据删除的核心断言**已在 Task 2 覆盖并通过(capture 后 store 中该键逐字节不变;store 没有该键时不凭空写入)。
- [ ] **spec §9 的冒烟清单五条**在 `dev/vault` 全部点过,移动端另跑第 3 项。
- [ ] `npm run build` / `npm test` / `npm run lint`(0 error、≤58 warning,零新增)/ `./scripts/check-no-hardcoded-color.sh` 四道全绿。
- [ ] `git log` 里没有任何 AI 署名尾注。
- [ ] 不 cut 版本、不 publish——交由 owner 决定(迭代约定:下一版本号)。
