# Store Stale Local-Key Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Purge a stale top-level `scope:"local"` key left in the shared store when a field's value was captured before it became device-local.

**Architecture:** Add a third base-hygiene guard to `captureGroup`'s write-skip callback, structurally identical to the two existing guards (`baseHasStaleClassKeys`, `baseHasStalePerItemElements`). When content compares equal but the store base still carries a now-local top-level key, the guard forces the rewrite that `captureTransform`'s strip has already removed the key from.

**Tech Stack:** TypeScript, Vitest. Single source file (`src/core/ConfigSyncCore.ts`) + one test file (`tests/sidecarLifecycle.test.ts`).

## Global Constraints

- **NO-COMMITS SDD:** implementers do NOT commit; the working tree is the review state; a single commit is made at cut by the controller. Replace every "commit" step with "leave uncommitted".
- No Claude/AI attribution in any commit, PR, or issue text.
- Bare version tags (`.npmrc` `tag-version-prefix=""`); versioning + release happen only at cut, not in this plan.
- Match the two existing guards exactly in structure, doc-comment style, and the spec reference (`2026-07-25-domain-mirror-design.md §2.2`).
- No token/secret value reaches process args, logs, errors, or `data.json` — not applicable here (no secret handling in this change), but do not introduce any.

---

### Task 1: Third base-hygiene guard — purge stale top-level local keys

**Files:**
- Modify: `src/core/ConfigSyncCore.ts` — add `stripPatterns` to the existing `./modes` import; add `baseHasStaleLocalKeys` beside the two existing guards (near line 241-276); extend the write-skip callback (near line 395).
- Test: `tests/sidecarLifecycle.test.ts` — new `describe` block mirroring the existing class-key base-hygiene block.

**Interfaces:**
- Consumes: `stripPatterns(group: SyncGroup): string[]` (exported from `src/core/modes.ts`), `isPlainObject`, `keyMatchesAny` (already imported in `ConfigSyncCore.ts`), `capture(ctx)`, `CoreContext`, `MemFS`, `FakePlugins`, `memGroupsIO` (test helpers).
- Produces: `baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean` (module-private; no export).

- [ ] **Step 1: Write the failing test**

Add to `tests/sidecarLifecycle.test.ts`:

```ts
// Regression for the third base-hygiene family (2026-08-04): a field re-scoped to "local"
// whose value was already in the store base (captured before the local rule) must be purged
// from the base. contentUnchanged strips top-level local keys on both sides (Fix B), so a stale
// base looked "unchanged" and was never rewritten — the leak the class-key and per-item guards
// already close for their families, now closed for top-level local keys too (§2.2 semantics).
describe("capture base-hygiene for top-level local keys", () => {
  const LOCAL_FIELD_GROUP: SyncGroup = {
    name: "app",
    path: "{configDir}/app.json",
    type: "file",
    devices: "all",
    mode: "fields",
    fields: [{ pattern: "userIgnoreFilters", scope: "local", encrypted: false }],
  };

  function setup(): { io: MemFS; ctx: CoreContext } {
    const io = new MemFS();
    const plugins = new FakePlugins();
    const ctx: CoreContext = {
      io,
      configDir: ".obs",
      rootPath: "cs",
      plugins,
      passphrase: null,
      deviceClass: "desktop",
      groupsIO: memGroupsIO([LOCAL_FIELD_GROUP]),
      now: () => "2026-08-04T00:00:00.000Z",
      switchExceptions: {},
    };
    return { io, ctx };
  }

  const LOCAL_CONTENT = JSON.stringify({ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] });
  const BASE_PATH = "cs/store/configdir/app.json";
  const LOCAL_SIDECAR_DESKTOP = "cs/store/configdir/app.json.__scopes__.desktop.json";
  const LOCAL_SIDECAR_MOBILE = "cs/store/configdir/app.json.__scopes__.mobile.json";

  it("purges a stale local key from the base; local content is untouched, no sidecar is written", async () => {
    const { io, ctx } = setup();
    io.seed({
      ".obs/app.json": LOCAL_CONTENT,
      // Store base written BEFORE the local rule existed — still carries the now-local key.
      [BASE_PATH]: LOCAL_CONTENT + "\n",
    });

    const results = await capture(ctx);
    const r = results.find((x) => x.group === "app");
    expect(r?.status).toBe("ok");

    // Base purged of the local-scoped key — the store must never carry a device-local value.
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
    expect(r?.changes.updated).toEqual(["app.json"]);

    // Local scope never lands in a sidecar (that is class scope) — neither class sidecar exists.
    expect(await io.exists(LOCAL_SIDECAR_DESKTOP)).toBe(false);
    expect(await io.exists(LOCAL_SIDECAR_MOBILE)).toBe(false);

    // The device keeps its own value.
    expect(JSON.parse(await io.read(".obs/app.json"))).toEqual({ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] });
  });

  it("no-op when the base is already clean: local patterns present but base carries no such key", async () => {
    const { io, ctx } = setup();
    const CLEAN = JSON.stringify({ attachmentFolderPath: "99" });
    io.seed({
      ".obs/app.json": CLEAN,
      [BASE_PATH]: CLEAN + "\n",
    });

    const results = await capture(ctx);
    const r = results.find((x) => x.group === "app");

    expect(r?.status).toBe("ok");
    expect(r?.changes).toEqual({ added: [], updated: [], deleted: [] });
    expect(r?.filesWritten).toEqual([]);
    expect(JSON.parse(await io.read(BASE_PATH))).toEqual({ attachmentFolderPath: "99" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sidecarLifecycle.test.ts`
Expected: the "purges a stale local key" test FAILS — the base still equals `{ attachmentFolderPath: "99", userIgnoreFilters: ["a/"] }` because the write-skip callback reports "unchanged" and never rewrites. The "no-op" test passes already (documents the complement).

- [ ] **Step 3: Add the guard function**

In `src/core/ConfigSyncCore.ts`, add `stripPatterns` to the existing `./modes` import:

```ts
import { applyTransform, captureTransform, classPatterns, contentUnchanged, stripPatterns } from "./modes";
```

Add the guard immediately after `baseHasStalePerItemElements` (after line 276), mirroring the two existing guards:

```ts
// Base-hygiene guard for stale top-level local-scoped keys (third family, 2026-08-04): like the
// two guards above, contentUnchanged deliberately ignores top-level scope:"local" keys on both
// sides (Fix B's withContractLocals — correct for diff/status, prevents a phantom to-capture on a
// re-scoped field), so a base written before the field became local can still carry that key after
// contentUnchanged reports equal. The store must never hold a device-local value, so this forces
// the rewrite that captureTransform's strip has already removed the key from. A per-item key is
// never a scope:"local" field (it lives in group.perItem, not group.fields), so stripPatterns
// never overlaps the per-item guard's responsibility. No-op when the group has no local patterns,
// or the existing content isn't a parseable JSON object.
function baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean {
  const patterns = stripPatterns(effGroup);
  if (patterns.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return false;
  }
  if (!isPlainObject(parsed)) return false;
  return Object.keys(parsed).some((k) => keyMatchesAny(k, patterns));
}
```

- [ ] **Step 4: Wire the guard into the write-skip callback**

In `captureGroup` (near line 395), extend the terminal expression:

```ts
      return !baseHasStaleClassKeys(effGroup, existing) && !baseHasStalePerItemElements(effGroup, existing) && !baseHasStaleLocalKeys(effGroup, existing);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/sidecarLifecycle.test.ts`
Expected: both new tests PASS. The base is purged to `{ attachmentFolderPath: "99" }` on first capture; the no-op case writes nothing.

- [ ] **Step 6: Run the full suite + build**

Run: `npx vitest run` then `npm run build`
Expected: full suite green (prior total + 2), build clean. Note lint baseline (0 errors) is unchanged.

- [ ] **Step 7: Leave uncommitted (NO-COMMITS)**

Do not commit. The working tree is the review state; the controller makes the single commit at cut.

---

## Self-Review

- **Spec coverage:** the spec's single fix (new `baseHasStaleLocalKeys` guard + callback clause) and both test cases (purge, no-op) are covered by Task 1. Non-goals (apply path, status prompt) are intentionally absent — no task, by design.
- **Placeholder scan:** none — all code and test bodies are concrete.
- **Type consistency:** `baseHasStaleLocalKeys(effGroup: SyncGroup, existing: string): boolean` matches the call site in the callback; `stripPatterns` signature matches its `modes.ts` export; `SyncGroup`/`isPlainObject`/`keyMatchesAny` are already in scope in `ConfigSyncCore.ts`.

## Docs Currency (do at cut, not in Task 1)

Before cut, check whether `docs/ARCHITECTURE.md` / `docs/design/DESIGN.md` document the base-hygiene invariant. If they list the class-key and per-item families, add the top-level-local-key family alongside them. If the invariant is not documented there, no doc change is required (the code comment carries it).
