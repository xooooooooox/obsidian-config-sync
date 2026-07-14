# Settings Reliability, Sensitive Workflow & Advanced Redesign (0.21.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Config Sync settings panel save reliably (uppercase ids, rollback-on-failure), surface sensitive items proactively (detect-before-enable, sensitive-first ordering), correct item classification (Workspaces core plugin, no Not-recommended section), give every synced row a unified expansion (fields / View data.json / Advanced), record display names on disk, and align the Sync Center select-all.

**Architecture:** Core changes are small and pure (name regex, `CORE_PLUGIN_FILES` entry, section builders, `SyncGroup.label`, `displayLabelForGroup` priority). The bulk is `src/ui/SettingTab.ts`: a `commitGroups` mutate-write-rollback helper replacing `saveGroups`, detection running per catalog item, sensitive-first section sorting, a shared row expansion, and the Advanced-tab redesign. Tests are the node/vitest suite with the MemFS + FakePlugins harness; UI behavior is verified in the controller obsidian-cli smoke.

**Tech Stack:** TypeScript, Obsidian API, vitest + MemFS/FakePlugins, esbuild.

## Global Constraints

- Cards/panel colors are existing CSS — this iteration does NOT restyle cards.
- Error copy has no prefixes (no "Not saved"): what failed + why + one example.
- `name` stays the stable key everywhere; new display data is a separate optional `label`.
- User-facing names go through the display-name chain; raw names only in code/store files.
- No back-compat migrations; widened validator and optional `label` are read leniently.
- Gate for every task: `npm test && npm run build && npm run lint` — green; lint baseline 0 errors / 66 warnings, do not add errors.
- Commits: conventional messages, no Claude/AI attribution of any kind.
- Verbatim copy (use exactly):
  - Name error: `rule "{name}" has an invalid name — use only letters, digits, "-" or "_", starting with a letter or digit, e.g. "my-plugin"`
  - Inline save error: `couldn't save this change — {message}. The change was reverted.`
  - Badge: `⚠ {n} keys` (aria-label `{n} sensitive-looking keys`); blob badge `⚠ opaque blob` (aria-label `opaque encrypted blob`)
  - Advanced banner line 1: `{n} items use a customized rule`; button `Reset all to defaults`
  - `device-specific` badge text: `device-specific`

---

### Task 1: Relax the group-name validator

**Files:**
- Modify: `src/core/manifest.ts:74-78`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Produces: `parseSyncGroup`/`validateSyncManifest` accept names with uppercase letters.

- [ ] **Step 1: Write failing tests** — append to `tests/manifest.test.ts`:

```ts
describe("group name validation allows uppercase", () => {
  const mk = (name: string) => JSON.stringify({ version: 1, groups: [{ name, path: "{configDir}/x.json", type: "file", devices: "all" }] });
  it("accepts a mixed-case plugin id", () => {
    expect(() => parseSyncManifest(mk("plugin-DEVONlink-obsidian"))).not.toThrow();
  });
  it("still rejects a leading punctuation name with the reworded message", () => {
    expect(() => parseSyncManifest(mk("-bad"))).toThrow(
      'rule "-bad" has an invalid name — use only letters, digits, "-" or "_", starting with a letter or digit, e.g. "my-plugin"'
    );
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/manifest.test.ts` → FAIL (uppercase rejected; old message).
- [ ] **Step 3: Implement** — in `src/core/manifest.ts`, change the regex and message:

```ts
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new ManifestValidationError(
      `rule "${name}" has an invalid name — use only letters, digits, "-" or "_", starting with a letter or digit, e.g. "my-plugin"`
    );
  }
```

- [ ] **Step 4: Run gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 5: Commit** — `git commit -m "fix: allow uppercase letters in sync group names"`

---

### Task 2: `SyncGroup.label` field — parse, write, round-trip

**Files:**
- Modify: `src/core/types.ts:10-19` (SyncGroup), `src/core/manifest.ts` (parseSyncGroup ~line 124-131), `src/core/catalog.ts:307-311` (groupForItem)
- Test: `tests/manifest.test.ts`, `tests/catalog.test.ts`

**Interfaces:**
- Produces: `SyncGroup` gains `label?: string`; `parseSyncGroup` reads a trimmed non-empty string `label`; `writeGroups` round-trips it; `groupForItem(name, path, type, description, label?)` accepts an optional label.

- [ ] **Step 1: Write failing tests** — append to `tests/manifest.test.ts`:

```ts
describe("group label field", () => {
  it("round-trips a label through parse", () => {
    const raw = JSON.stringify({ version: 1, groups: [{ name: "plugin-x", label: "Xtension", path: "{configDir}/plugins/x/data.json", type: "file", devices: "all" }] });
    expect(parseSyncManifest(raw).groups[0]?.label).toBe("Xtension");
  });
  it("ignores an empty/whitespace label", () => {
    const raw = JSON.stringify({ version: 1, groups: [{ name: "plugin-x", label: "  ", path: "{configDir}/plugins/x/data.json", type: "file", devices: "all" }] });
    expect(parseSyncManifest(raw).groups[0]?.label).toBeUndefined();
  });
});
```

Append to `tests/catalog.test.ts`:

```ts
import { groupForItem } from "../src/core/catalog"; // merge into existing import
it("groupForItem records a label when given", () => {
  expect(groupForItem("plugin-x", "{configDir}/plugins/x/data.json", "file", null, "Xtension").label).toBe("Xtension");
  expect(groupForItem("plugin-x", "{configDir}/plugins/x/data.json", "file", null).label).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/manifest.test.ts tests/catalog.test.ts` → FAIL.
- [ ] **Step 3: Implement**

`src/core/types.ts` — add to `SyncGroup` (after `description?`):

```ts
  label?: string; // display name recorded at capture/enable; falls back through the resolver chain
```

`src/core/manifest.ts` — in `parseSyncGroup`, destructure `label` from the input and validate/attach after the description block (before `return group`):

```ts
  if (label !== undefined && typeof label !== "string") {
    throw new ManifestValidationError(`rule "${name}" has a "label" that isn't text — use a plain string, e.g. "label": "BRAT"`);
  }
  const trimmedLabel = typeof label === "string" ? label.trim() : "";
  if (trimmedLabel !== "") group.label = trimmedLabel;
```

(Add `label` to the object destructure at the top of `parseSyncGroup` alongside `name, path, type, devices, mode, fields, description, origin`.)

`src/core/catalog.ts` — widen `groupForItem`:

```ts
export function groupForItem(name: string, path: string, type: "file" | "dir", description: string | null, label?: string): SyncGroup {
  const group: SyncGroup = { name, path, type, devices: "all" };
  if (description !== null) group.description = description;
  if (label !== undefined && label.trim() !== "") group.label = label.trim();
  return group;
}
```

- [ ] **Step 4: Run gate** — green (`writeGroups` uses `validateSyncManifest`, which now preserves `label`; verify the round-trip test covers write by parsing the output — the parse test suffices).
- [ ] **Step 5: Commit** — `git commit -m "feat: optional label field on sync groups"`

---

### Task 3: `displayLabelForGroup` consults the stored label

**Files:**
- Modify: `src/core/catalog.ts:354-364`
- Modify callers: `src/main.ts` (`displayName`)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `SyncGroup.label` (Task 2).
- Produces: `displayLabelForGroup(name, plugins, storedLabel?)` — new optional third arg inserted at priority 4 (after runtime names, before raw-id fallback). `main.ts`'s `displayName(group)` resolves the stored label from the loaded manifest and passes it.

- [ ] **Step 1: Write failing test** — append to `tests/catalog.test.ts`:

```ts
import { displayLabelForGroup } from "../src/core/catalog"; // merge into existing import
describe("displayLabelForGroup label priority", () => {
  const noPlugins = { getInstalledPluginName: () => null, getCorePluginName: () => null } as unknown as import("../src/core/ConfigSyncCore").PluginHost;
  it("uses the stored label when no runtime name resolves", () => {
    expect(displayLabelForGroup("plugin-obsidian42-brat", noPlugins, "BRAT")).toBe("BRAT");
  });
  it("prefers the runtime plugin name over the stored label", () => {
    const p = { getInstalledPluginName: (id: string) => (id === "obsidian42-brat" ? "BRAT live" : null), getCorePluginName: () => null } as unknown as import("../src/core/ConfigSyncCore").PluginHost;
    expect(displayLabelForGroup("plugin-obsidian42-brat", p, "BRAT stale")).toBe("BRAT live");
  });
  it("falls back to the raw id when neither resolves", () => {
    expect(displayLabelForGroup("plugin-obsidian42-brat", noPlugins)).toBe("obsidian42-brat");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/catalog.test.ts` → FAIL (3-arg signature).
- [ ] **Step 3: Implement** — `src/core/catalog.ts`:

```ts
export function displayLabelForGroup(name: string, plugins: PluginHost, storedLabel?: string): string {
  for (const file of Object.keys(OPTION_LABELS)) {
    if (optionReservedName(file) === name) return OPTION_LABELS[file]?.label ?? name;
  }
  if (CORE_SETTINGS_IDS.includes(name)) return plugins.getCorePluginName(name) ?? storedLabel ?? name;
  if (name.startsWith("plugin-")) {
    const id = name.slice("plugin-".length);
    return plugins.getInstalledPluginName(id) ?? storedLabel ?? id;
  }
  return storedLabel ?? name;
}
```

`src/main.ts` — `displayName` must supply the stored label. It currently is
`displayName(group) { return displayLabelForGroup(group, this.pluginHost()); }`. Make it
read the group's label from a cached manifest. Add a lightweight lookup: keep the last
loaded groups on the plugin (the Sync Center's `computeStatuses` and settings already load
them). Simplest correct approach — resolve from the in-memory groups the caller has:

```ts
  displayName(group: string, storedLabel?: string): string {
    return displayLabelForGroup(group, this.pluginHost(), storedLabel);
  }
```

Then update the call sites that have the `SyncGroup` in hand to pass `group.label`:
- `SyncCenterView` host `displayName`: the view holds `this.groups`; change the host
  `displayName(name)` to look up the group and pass its label. In `main.ts`
  `syncCenterHost().displayName`, resolve via the groups loaded in `computeStatuses` — store
  them on the plugin (`this.lastGroups`) during `computeStatuses` and read here:

```ts
      displayName: (g) => this.displayName(g, this.lastGroups?.find((x) => x.name === g)?.label),
```

  Add `private lastGroups: SyncGroup[] | null = null;` and set `this.lastGroups = groups;`
  inside `computeStatuses` right after `groupsForDevice`.
- `ReportModal` `labelFor`: the report has `GroupResult.group` (name only), no label. Pass
  `main.ts`'s `(g) => this.displayName(g, this.lastGroups?.find((x) => x.name === g)?.label)`
  at the 5 ReportModal call sites (capture/apply/pull/push/revert) — they already use an
  arrow; swap the arrow body.
- `SettingTab` `displayName`: it has `this.groups`; where it calls `this.host.displayName(g.name)`
  (renderRuleCard, buildSearchIndex), pass the group's label:
  `this.host.displayName(g.name, findGroupByName(this.groups, g.name)?.label)`.
  Update the `SettingsHost.displayName` signature to `(group: string, storedLabel?: string)`.

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: display-name resolver consults the stored label"`

---

### Task 4: Capture backfills a missing label

**Files:**
- Modify: `src/main.ts` (capture host)
- Test: none new (host-level; covered by smoke). Add a focused unit if a pure seam exists — it does not (label resolution is UI-side), so **no test**; state this in the report.

**Interfaces:**
- Consumes: `displayName` (Task 3), `readGroups`/`writeGroups`.
- Produces: after a successful capture, any processed group lacking a `label` whose resolved display name differs from its raw name gets the label written back to `config-sync.json`. Must never throw into the capture flow.

- [ ] **Step 1: Implement** — in `main.ts`'s `captureItems` host method, after `capture(...)` succeeds and before `refreshLocalStatus`, backfill:

```ts
        try {
          const groups = await readGroups(ctx);
          let changed = false;
          for (const g of groups) {
            if (g.label !== undefined) continue;
            const resolved = this.displayName(g.name, g.label);
            if (resolved !== g.name && resolved !== g.name.replace(/^plugin-/, "")) {
              g.label = resolved;
              changed = true;
            }
          }
          if (changed) await writeGroups(ctx, groups);
        } catch (e) {
          console.error("Config Sync: label backfill skipped", e);
        }
```

(Place inside the existing `try` of `captureItems`, after the ReportModal-less results are
in hand — note post-0.20.0 `captureItems` returns results; insert before `return results`.)

- [ ] **Step 2: Verify build + lint** — `npm run build && npm run lint` green (no new test).
- [ ] **Step 3: Full suite** — `npm test` green (unchanged count).
- [ ] **Step 4: Commit** — `git commit -m "feat: backfill display-name labels on capture"`

---

### Task 5: `workspaces` core plugin + drop Not-recommended sections + device-specific classification

**Files:**
- Modify: `src/core/catalog.ts` (CORE_PLUGIN_FILES ~49, WORKSPACE_RE ~26, listOptionSections ~159, listCoreSections ~216)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Produces: `CORE_PLUGIN_FILES.workspaces = "workspaces.json"`; `listOptionSections` no longer emits a `notRecommended` section and no longer first-classes `workspace*.json` (they reach `listDiscovered`); `listCoreSections` no longer emits `notRecommended` — `sync`/`publish` return to Enabled/Disabled with `cautionReason` still set.

- [ ] **Step 1: Write failing tests** — append to `tests/catalog.test.ts` (harness: MemFS seeded with config files; check existing tests for the exact setup helper and reuse it):

```ts
describe("workspaces reclassification and section dissolution", () => {
  it("lists workspaces.json as a core plugin item, not a discovered file", async () => {
    const io = new MemFS();
    io.seed({ ".obs/workspaces.json": "{}", ".obs/graph.json": "{}" });
    const cores = [{ id: "workspaces", name: "Workspaces", enabled: true }, { id: "graph", name: "Graph view", enabled: true }];
    const secs = await listCoreSections(io, ".obs", cores, []);
    const names = secs.flatMap((s) => s.items.map((i) => i.name));
    expect(names).toContain("workspaces");
    expect(secs.map((s) => s.heading)).not.toContain("Not recommended");
    const disc = await listDiscovered(io, ".obs", []);
    expect(disc.map((d) => d.name)).not.toContain("workspaces");
  });
  it("keeps volatile workspace.json out of the Obsidian sections and lets it reach discovered", async () => {
    const io = new MemFS();
    io.seed({ ".obs/workspace.json": "{}", ".obs/app.json": "{}" });
    const secs = await listOptionSections(io, ".obs", []);
    const names = secs.flatMap((s) => s.items.map((i) => i.name));
    expect(names).not.toContain("workspace");
    expect(secs.map((s) => s.heading)).not.toContain("Not recommended");
    const disc = await listDiscovered(io, ".obs", []);
    expect(disc.map((d) => d.name)).toContain("workspace");
  });
  it("returns sync/publish to Enabled/Disabled with a cautionReason", async () => {
    const io = new MemFS();
    io.seed({ ".obs/sync.json": "{}", ".obs/publish.json": "{}" });
    const cores = [{ id: "sync", name: "Sync", enabled: true }, { id: "publish", name: "Publish", enabled: false }];
    const secs = await listCoreSections(io, ".obs", cores, []);
    const enabled = secs.find((s) => s.heading === "Enabled")?.items ?? [];
    const disabled = secs.find((s) => s.heading === "Disabled")?.items ?? [];
    expect(enabled.find((i) => i.name === "sync")?.cautionReason).not.toBeNull();
    expect(disabled.find((i) => i.name === "publish")?.cautionReason).not.toBeNull();
  });
});
```

(Ensure `listDiscovered`, `listOptionSections`, `listCoreSections`, `MemFS` are imported in the test file.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/catalog.test.ts` → FAIL.
- [ ] **Step 3: Implement** — `src/core/catalog.ts`:

Add to `CORE_PLUGIN_FILES` (any position): `workspaces: "workspaces.json",`.

`listOptionSections`: delete the `notRecommended` array, the `WORKSPACE_RE` branch that
pushes into it (lines ~187-200 — remove the whole `if (WORKSPACE_RE.test(b)) {...}` block so
those files fall through to "unclassified → discovered"), and the `notRecommended` section
from the return. The `for (const b of files)` loop body becomes: skip covered/hidden/switch/core,
otherwise do nothing (comment: unclassified json → discovered). Return only `available` +
`notPresent`.

`listCoreSections`: delete the `notRecommended` array and its section from the return; in the
item loop, always push to `enabled`/`disabled` by `core.enabled` (keep setting
`cautionReason` from `CORE_NOT_RECOMMENDED`). Drop `notRecommended.sort`.

`WORKSPACE_RE`: it's now only referenced in `listDiscovered:151` to EXCLUDE workspace files
from discovery. But the spec wants `workspace.json`/`workspace-mobile.json` to APPEAR in
discovered, while `workspaces.json` is excluded (it's core now, caught by `CORE_FILE_SET`).
So **remove `WORKSPACE_RE.test(b)` from the `listDiscovered` skip condition** (line 151) —
`workspaces.json` is already excluded via `CORE_FILE_SET`, and `workspace.json`/
`workspace-mobile.json` should now be discoverable. After this, `WORKSPACE_RE` and
`WORKSPACE_CAUTION` are unused — delete both constants (verify with
`grep -n "WORKSPACE_RE\|WORKSPACE_CAUTION" src/`).

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: workspaces core plugin; dissolve Not-recommended into device-specific classification"`

---

### Task 6: `commitGroups` mutate-write-rollback helper + inline save error

**Files:**
- Modify: `src/ui/SettingTab.ts` (replace `saveGroups` ~around its definition; add `saveErrorFor` field; route all mutation call sites)
- Test: `tests/settingtab-commit.test.ts` (new — pure helper extraction)

**Interfaces:**
- Consumes: `writeGroupsFile` (throwing on invalid).
- Produces: `commitGroups(mutator, culprit?): Promise<boolean>` — applies `mutator` to a deep clone, writes, commits `this.groups` only on success; on failure leaves `this.groups` unchanged, sets `groupsErrorMsg` + `saveErrorFor`, returns false. All groups-mutating handlers route through it.

To make this testable without an Obsidian DOM, extract the pure decision into a free
function and have the method delegate:

- [ ] **Step 1: Write failing test** — create `tests/settingtab-commit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { commitDraft } from "../src/ui/commitGroups";
import { SyncGroup } from "../src/core/types";

const base: SyncGroup[] = [{ name: "a", path: "{configDir}/a.json", type: "file", devices: "all" }];

describe("commitDraft", () => {
  it("returns the mutated draft on a successful write", async () => {
    const res = await commitDraft(base, (d) => d.push({ name: "b", path: "{configDir}/b.json", type: "file", devices: "all" }), async () => {});
    expect(res.ok).toBe(true);
    expect(res.groups.map((g) => g.name)).toEqual(["a", "b"]);
    expect(base.map((g) => g.name)).toEqual(["a"]); // original untouched
  });
  it("returns the original groups and the error on a failed write", async () => {
    const res = await commitDraft(base, (d) => d.push({ name: "bad", path: "", type: "file", devices: "all" }), async () => { throw new Error("boom"); });
    expect(res.ok).toBe(false);
    expect(res.groups).toBe(base); // same reference — unchanged
    expect(res.error).toBe("boom");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/settingtab-commit.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** — create `src/ui/commitGroups.ts`:

```ts
import { SyncGroup } from "../core/types";

export interface CommitResult {
  ok: boolean;
  groups: SyncGroup[]; // on success: the mutated draft; on failure: the original reference
  error: string;
}

// Applies mutator to a deep clone of `groups`, persists via write, and returns the draft only
// when the write succeeds. On failure the original array reference is returned unchanged so the
// caller's state and the disk stay in agreement.
export async function commitDraft(
  groups: SyncGroup[],
  mutator: (draft: SyncGroup[]) => void,
  write: (groups: SyncGroup[]) => Promise<void>
): Promise<CommitResult> {
  const draft = structuredClone(groups) as SyncGroup[];
  mutator(draft);
  try {
    await write(draft);
  } catch (e) {
    return { ok: false, groups, error: (e as Error).message };
  }
  return { ok: true, groups: draft, error: "" };
}
```

In `src/ui/SettingTab.ts`, add field `private saveErrorFor = "";`, and replace `saveGroups`
with a `commitGroups` method delegating to `commitDraft`:

```ts
  private async commitGroups(mutator: (draft: SyncGroup[]) => void, culprit?: string): Promise<boolean> {
    const res = await commitDraft(this.groups, mutator, (g) => this.host.writeGroupsFile(g));
    if (res.ok) {
      this.groups = res.groups;
      this.groupsErrorMsg = "";
      this.saveErrorFor = "";
    } else {
      this.groupsErrorMsg = res.error;
      this.saveErrorFor = culprit ?? "";
    }
    this.groupsErrorEl?.setText(this.groupsErrorMsg);
    return res.ok;
  }
```

Route every existing `mutate(this.groups); await this.saveGroups(); this.refresh();` site
through `commitGroups`. The mutators now operate on the draft parameter, not `this.groups`
directly. Convert each handler; representative conversions:

Toggle (renderItemInto):
```ts
      t.onChange(async (v) => {
        if (v && item.cautionReason !== null) {
          const ok = await confirmWarnings(this.app, "Sync a device-specific file?", [item.cautionReason]);
          if (!ok) { this.refresh(); return; }
        }
        await this.commitGroups((draft) => {
          if (v) draft.push(groupForItem(item.name, item.path, item.type, item.description, item.label));
          else {
            const idx = draft.findIndex((g) => g.name === item.name);
            if (idx >= 0) draft.splice(idx, 1);
          }
        }, item.name);
        this.refresh();
      });
```

Devices dropdown, mode segment, fields editor edits, discovered-row toggle, custom-rule
name/path/type/devices/mode/description edits, reset (single + all): each wraps its mutation
in `commitGroups((draft) => {...}, culprit?)`. For mutations that today mutate `group`
(a reference into `this.groups`), rewrite to find the group **in the draft** by name and
mutate that:
```ts
await this.commitGroups((draft) => {
  const g = draft.find((x) => x.name === group.name);
  if (g !== undefined) g.devices = v as DeviceClass;
}, group.name);
```
Bulk reset-all uses `commitGroups` with no culprit (page-level error).

Note: `renderModeSegment`/`renderFieldsEditor` take an `afterChange` callback and today call
`saveGroups()` internally — change them to accept a `commit: (mutator, culprit?) => Promise<boolean>`
or have them call `this.commitGroups`. Simplest: make them methods that call
`this.commitGroups` directly (they already are methods) and mutate via draft-find. Keep
`afterChange` for the re-render.

- [ ] **Step 4: Inline error rendering** — in `renderItemInto` and `renderRuleCard`, after
building the row, if `this.saveErrorFor === item.name` (or `group.name`), append:
```ts
    if (this.saveErrorFor === item.name) {
      wrap.createDiv({ cls: "config-sync-save-error mod-warning", text: `couldn't save this change — ${this.groupsErrorMsg}. The change was reverted.` });
    }
```
Add `.config-sync-save-error { color: var(--text-error); font-size: var(--font-ui-smaller); margin-top: 4px; }` to `styles.css`. Clear `saveErrorFor` on tab switch (in the tab-click handler / `refresh` entry when `activeTab` changes).

- [ ] **Step 5: Run gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 6: Commit** — `git commit -m "fix: roll back settings mutations when the write fails"`

---

### Task 7: Detect on every catalog item + sensitive-first ordering + drop Detected text

**Files:**
- Modify: `src/ui/SettingTab.ts` (renderChecklistRow/renderItemInto detection, applyDetection ~404, renderSections ~295, add sortSectionItems)
- Test: `tests/panelModel.test.ts` or new `tests/sensitive-sort.test.ts` (pure comparator)

**Interfaces:**
- Consumes: `detectSensitive`, `groupForItem`, `this.detections` map.
- Produces: badge on unsynced rows; `sortSectionItems(items)` sensitive-first stable comparator; description no longer carries "Detected: …".

- [ ] **Step 1: Write failing test** — create `tests/sensitive-sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sortBySensitiveFirst } from "../src/ui/sensitiveSort";

const item = (name: string, label: string) => ({ name, label });

describe("sortBySensitiveFirst", () => {
  it("floats sensitive items to the top, alphabetical within each group, count-independent", () => {
    const items = [item("a", "Alpha"), item("z", "Zeta"), item("m", "Mike"), item("b", "Bravo")];
    const sensitive = new Set(["z", "b"]); // z has 1 hit, b has 9 — order must not depend on count
    const out = sortBySensitiveFirst(items, (i) => sensitive.has(i.name)).map((i) => i.label);
    expect(out).toEqual(["Bravo", "Zeta", "Alpha", "Mike"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/sensitive-sort.test.ts` → FAIL.
- [ ] **Step 3: Implement** — create `src/ui/sensitiveSort.ts`:

```ts
export function sortBySensitiveFirst<T extends { label: string }>(items: T[], isSensitive: (i: T) => boolean): T[] {
  return [...items].sort((a, b) => {
    const sa = isSensitive(a) ? 0 : 1;
    const sb = isSensitive(b) ? 0 : 1;
    return sa !== sb ? sa - sb : a.label.localeCompare(b.label);
  });
}
```

In `SettingTab.ts`:
- Add `private sortedSections = new Set<string>();` (guards one-time re-sort per section on
  async detection resolve).
- In `renderSections`, sort each `sec.items` before rendering:
  ```ts
  const items = sortBySensitiveFirst(sec.items, (i) => {
    const s = this.detections.get(i.name);
    return (s?.keys.length ?? 0) > 0 || (s?.blob ?? false);
  });
  for (const item of items) this.renderChecklistRow(listEl, item);
  ```
- Detection for unsynced rows: `renderChecklistRow` → `renderItemInto` currently only calls
  `renderDetection` when `group !== undefined`. Change so detection runs for any item whose
  file can exist (`item.disabledReason === null && item.exists`), building a probe group when
  no real one exists: `const probe = group ?? groupForItem(item.name, item.path, item.type, null);`
  and pass that to `renderDetection`. Keep the cache keyed by `item.name`.
- When a detection resolves and newly marks a section item sensitive, trigger a one-time
  re-render of that tab so ordering settles: in `renderDetection`'s resolve callback, if the
  scan is sensitive and `!this.sortedSections.has(this.activeTab)`, add the tab to the set
  and call `this.refresh()`. (Reset `sortedSections` on tab switch and on `refresh` entry so
  each tab settles once per visit.)
- `applyDetection` (~404): remove the `Detected: {keys}` description append (delete the
  `if (scan.keys.length > 0) { const current = ...; row.setDesc(...) }` block). Change badge
  text to `⚠ ${scan.keys.length} keys` / `⚠ opaque blob` and set `aria-label`:
  ```ts
  const badge = row.nameEl.createSpan({ cls: "config-sync-detect-badge", text: scan.blob ? "⚠ opaque blob" : `⚠ ${scan.keys.length} keys` });
  badge.setAttribute("aria-label", scan.blob ? "opaque encrypted blob" : `${scan.keys.length} sensitive-looking keys`);
  ```

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: detect sensitive keys before enabling and float them to the top"`

---

### Task 8: Unified row expansion (fields / View data.json / Advanced) + customized badge

**Files:**
- Modify: `src/ui/SettingTab.ts` (renderItemInto → add chevron + expansion; move fields editor in; add View-json; add Advanced segment; customized badge)
- Modify: `src/main.ts` (host: add a `readItemFile(group): Promise<string | null>` or reuse existing IO exposure for View data.json)
- Test: `tests/json-view.test.ts` (pure key-classification helper)

**Interfaces:**
- Consumes: `detectSensitive`, `keyMatchesAny`, `SENSITIVE_ENCRYPT_RE`/`defaultFieldsFromDetection`, `expectedPathForName`, `defaultGroupForName`.
- Produces: `classifyJsonKeys(rawJson, fields, detectedKeys)` returning per-key state for coloring; `SettingsHost.readItemFile(group)` for the JSON view.

- [ ] **Step 1: Write failing test** — create `tests/json-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyJsonKeys } from "../src/ui/jsonView";

describe("classifyJsonKeys", () => {
  it("labels each top-level key by rule/detection state", () => {
    const raw = JSON.stringify({ apiKey: "x", customEndpoint: "y", theme: "dark" });
    const out = classifyJsonKeys(raw, [{ pattern: "apiKey", action: "encrypt" }], ["apiKey", "customEndpoint"]);
    expect(out.find((k) => k.key === "apiKey")?.state).toBe("encrypt");
    expect(out.find((k) => k.key === "customEndpoint")?.state).toBe("detected");
    expect(out.find((k) => k.key === "theme")?.state).toBe("none");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/json-view.test.ts` → FAIL.
- [ ] **Step 3: Implement** — create `src/ui/jsonView.ts`:

```ts
import { FieldRule } from "../core/types";
import { keyMatchesAny } from "../core/sanitize";

export type KeyState = "encrypt" | "strip" | "detected" | "none";
export interface KeyClass { key: string; state: KeyState; }

// Classifies each top-level object key by its rule/detection state for the read-only viewer.
export function classifyJsonKeys(raw: string, fields: FieldRule[], detectedKeys: string[]): KeyClass[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const enc = fields.filter((f) => f.action === "encrypt").map((f) => f.pattern);
  const strip = fields.filter((f) => f.action === "strip").map((f) => f.pattern);
  return Object.keys(parsed).map((key) => {
    let state: KeyState = "none";
    if (keyMatchesAny(key, enc)) state = "encrypt";
    else if (keyMatchesAny(key, strip)) state = "strip";
    else if (detectedKeys.includes(key)) state = "detected";
    return { key, state };
  });
}
```

In `main.ts`, add host method `readItemFile`:
```ts
      readItemFile: async (group: SyncGroup): Promise<string | null> => {
        const io = this.app.vault.adapter;
        const real = groupRealPath(group.path, this.app.vault.configDir);
        if (group.type !== "file" || !(await io.exists(real))) return null;
        try { return await io.read(real); } catch { return null; }
      },
```
(Add `readItemFile(group: SyncGroup): Promise<string | null>;` to `SettingsHost`.)

In `SettingTab.ts` `renderItemInto`:
- Add a chevron span at the row's start **only when `group !== undefined`**; toggling adds/removes
  `item.name` from `this.expanded` and re-renders the row (in-place via `renderItemInto(wrap, item)`).
- Add the **customized badge**: after the name, when synced and customized, append
  `⚠→⚙`: compute `isCustomized(group)`:
  ```ts
  private isCustomized(group: SyncGroup): boolean {
    const expected = expectedPathForName(group.name);
    if (expected !== null && group.path !== expected) return true;
    const def = defaultGroupForName(group.name);
    if (def === null) return false;
    return (group.mode ?? "plain") !== (def.mode ?? "plain")
      || group.devices !== def.devices
      || JSON.stringify(group.fields ?? []) !== JSON.stringify(def.fields ?? []);
  }
  ```
  Render `<span class="config-sync-cust">⚙ customized</span>` when true (replaces the old
  path-only badge at :337-338).
- **Expansion region** (when `group !== undefined && this.expanded.has(group.name)`):
  build `const exp = wrap.createDiv({ cls: "config-sync-item-exp" })` and render segments:
  - **Fields to protect** (only `group.mode === "fields"`): `exp.createDiv({cls:"config-sync-explabel", text:"Fields to protect"})` then `this.renderFieldsEditor(exp.createDiv(), group, () => this.renderItemInto(wrap, item))`. Remove the old below-card fields-editor render (:378-380).
  - **Data file**: label + a `View data.json ▾` toggle; on expand, `await this.host.readItemFile(group)` → if null show "no local file to preview" → else render a `<pre>` where each top-level key from `classifyJsonKeys(raw, group.fields ?? [], this.detections.get(group.name)?.keys ?? [])` is a clickable span colored by state (`config-sync-json-encrypt|strip|detected`). Clicking a key with state ≠ encrypt/strip adds a rule:
    ```ts
    const action = /apikey|api_key|token|secret|password|credential/i.test(key) ? "encrypt" : "strip";
    await this.commitGroups((draft) => {
      const g = draft.find((x) => x.name === group.name);
      if (g === undefined) return;
      if ((g.mode ?? "plain") !== "fields") g.mode = "fields";
      g.fields = [...(g.fields ?? []), { pattern: key, action }];
    }, group.name);
    this.renderItemInto(wrap, item);
    ```
    (Reuse `SENSITIVE_ENCRYPT_RE` already defined at top of file instead of re-inlining.)
  - **Advanced**: label + a Store-path text input bound to `group.path` (commit via
    `commitGroups` draft-find), and — for managed items (`reservedNames`) — a
    `↺ Reset this item to its default rule` link calling `defaultGroupForName` via
    `commitGroups`.
- When the mode segment switches to `fields`, auto-open the row: in `renderModeSegment`'s
  `fields` branch, `this.expanded.add(group.name)` before `afterChange()`.

- [ ] **Step 4: Run gate** — green.
- [ ] **Step 5: Commit** — `git commit -m "feat: unified row expansion with fields, data.json view, and advanced options"`

---

### Task 9: Advanced tab redesign — remove Synced-items mirror, add customized banner

**Files:**
- Modify: `src/ui/SettingTab.ts` (`renderAdvanced` ~812-866; drop `renderRuleCard`/`renderRuleForm` for managed; keep custom + discovered; add banner; search-anchor + buildSearchIndex updates)
- Test: none new (UI structure; smoke-covered) — state in report.

**Interfaces:**
- Consumes: `isCustomized` (Task 8), `this.host.displayName`, `defaultGroupForName`, `reservedNames`.
- Produces: Advanced tab = customized banner (conditional) + Custom rules + Discovered files. Managed items no longer mirrored here.

- [ ] **Step 1: Implement** — rewrite `renderAdvanced`:
  - Compute `const reserved = reservedNames(this.host.installedPluginIds());` and
    `const managed = this.groups.filter((g) => reserved.has(g.name) && g.origin === undefined);`
    and `const customized = managed.filter((g) => this.isCustomized(g));`
  - **Banner** (only when `customized.length > 0`): a `Setting` (or a div styled to match) with
    name `${customized.length} items use a customized rule`, desc
    `${customized.map((g) => this.host.displayName(g.name, g.label)).join(", ")} — edit each on its own tab.`,
    and a button `Reset all to defaults` that runs the existing bulk reset via `commitGroups`
    (no culprit): for each managed customized group, replace with `defaultGroupForName(g.name)`.
  - **Custom rules** heading + `custom` groups via a card renderer using the shared expansion
    (Task 8) — custom groups have no `CatalogItem`; render a minimal row (name/path/toggle-off=delete)
    plus the same expansion body. Keep `+ Add rule`.
  - **Discovered files** heading + `discoveredOn` + `discovered` rows — unchanged.
  - Delete the `Synced items` heading, its per-category managed mirror loop (:833-839), and the
    reset-all button that lived on that heading.
  - Remove `renderRuleForm`/`renderRuleCard` usage for managed items; if `renderRuleForm` is
    now only used by custom/discovered, keep it but drop the `"managed"` mode branch.
    (Verify usages with `grep -n "renderRuleCard\|renderRuleForm" src/ui/SettingTab.ts`.)
- **Search anchors**: managed items' anchor moves to their picker-tab row. In
  `renderItemInto`, set `row.settingEl.setAttribute("data-search-anchor", \`item-${item.name}\`)`.
  In `buildSearchIndex`, the managed-item hits already come from the picker-tab section loop
  (:517-528) — set their `anchorId` to `item-${item.name}` and drop the separate Advanced
  managed-item index entries (:531-543 keep only `origin === "discovered"` and custom
  entries). `jumpTo` for an item hit switches to the item's tab (`hit.scope`) then scrolls to
  `item-${name}`; extend `jumpTo` to open the expansion when the hit is an item (add
  `this.expanded.add(name)` before scroll for `kind === "item"`).

- [ ] **Step 2: Run gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 3: Commit** — `git commit -m "feat: slim the Advanced tab to custom rules, discovered files, and a customized-rules banner"`

---

### Task 10: Sync Center select-all alignment (CSS)

**Files:**
- Modify: `src/ui/SyncCenterView.ts` (the main-bar select-all wrapper class, if needed), `styles.css`
- Test: none (CSS; smoke-verified).

- [ ] **Step 1: Implement** — the main-bar select-all checkbox (`renderItemMode`, the
`bar.createEl("input", { type: "checkbox" ... })` after the filter pills) needs right
alignment matching the row checkbox column. Wrap it or add a class
`config-sync-selectall` and append CSS to `styles.css`:
```css
.config-sync-mainbar { display: flex; align-items: center; }
.config-sync-mainbar .config-sync-selectall { margin-left: auto; margin-right: 10px; }
```
Give the checkbox `cls: "config-sync-selectall"`. The `10px` matches the row card's inner
horizontal padding so the checkbox lands in the same column as row checkboxes (verify the
exact card padding in `styles.css` for `.config-sync-hub-row`/card and match it).

- [ ] **Step 2: Run gate** — `npm run build && npm run lint && npm test` green.
- [ ] **Step 3: Commit** — `git commit -m "fix: align Sync Center select-all with the row checkbox column"`

---

### Task 11: README + full gate

**Files:**
- Modify: `README.md`, `README.zh.md`

- [ ] **Step 1: Update READMEs** — reflect: uppercase names allowed; sensitive detection runs
before enabling and sensitive items sort to the top of each tab section; `Workspaces` is a
core-plugin item and volatile `workspace.json` lives under Advanced → Discovered; the
per-item expansion (fields, View data.json with click-to-add-rule, Advanced store-path +
reset); the Advanced tab now holds Custom rules + Discovered files + a customized-rules
summary (no full mirror); the optional `label` in `config-sync.json`. Remove any text
describing the old "Synced items" mirror or "Not recommended" section. Keep prose paths as
`~/path`, no personal identifiers, current-state (no changelog phrasing).
- [ ] **Step 2: Full gate** — `npm test && npm run build && npm run lint` green.
- [ ] **Step 3: Commit** — `git commit -m "docs: README for settings reliability, sensitive workflow, and Advanced redesign"`

---

## Self-Review Notes

- Spec §1.1→T1, §1.2/1.3→T6, §2.1/2.2/2.3→T7, §3.1/3.2/3.3→T5, §4.1/4.2/4.3/4.4→T8,
  §4.5/4.6/4.7→T9, §5.1/5.2/5.3→T2/T4/T3, §6→T10, docs→T11.
- Type consistency: `commitGroups(mutator, culprit?)` (T6) used by T7/T8/T9;
  `displayLabelForGroup(name, plugins, storedLabel?)` (T3) used by T4; `groupForItem(...label?)`
  (T2) used by T6/T8; `isCustomized` (T8) used by T9; `sortBySensitiveFirst` (T7) is the
  section sorter; `classifyJsonKeys` (T8) + `readItemFile` (T8) for the JSON view.
- Ordering rationale: core/pure tasks (T1-T5) land first so the UI tasks (T6-T9) build on
  final signatures; T6 (`commitGroups`) precedes T7-T9 because they route mutations through it.
- Deliberate no-test tasks: T4 (label backfill — UI-side resolution, no pure seam), T9/T10
  (structure/CSS) — each states this and relies on the smoke.
