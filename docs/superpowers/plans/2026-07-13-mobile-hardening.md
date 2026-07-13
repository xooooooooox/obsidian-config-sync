# Mobile Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three mobile-audit gaps: a clear WebCrypto-unavailable error, ≥36px touch targets under `body.is-mobile`, and a runtime guard for the desktop-only Remotes settings tab.

**Architecture:** One code task (crypto guard + SettingTab guard + CSS block, with a crypto guard unit test), then a controller-run `emulateMobile` smoke. No behavior changes beyond the guard error.

**Tech Stack:** TypeScript, CSS, vitest, obsidian-cli (`app.emulateMobile`).

**Spec:** `docs/superpowers/specs/2026-07-13-mobile-hardening-design.md`.

## Global Constraints

- Gate: `npm test && npm run build && npm run lint` — 0 lint errors (64-warning baseline acceptable).
- Verbatim error: `WebCrypto is unavailable in this environment — Encrypt modes cannot run on this device`.
- Touch CSS only under `body.is-mobile`; desktop rules unchanged; no markup changes except hit-area pseudo-elements need none (use padding).
- **Vault-identity guard for any obsidian-cli use:** run `/Applications/Obsidian.app/Contents/MacOS/obsidian-cli eval vault=vault code="app.vault.getName()"` AS ITS OWN COMMAND, require `=> vault`; on mismatch `open "obsidian://open?vault=vault"`, wait ~8 s, re-check. NEVER chain the guard with `&&`.
- Commits: plain conventional style, no Claude attribution / no Claude-Session trailer.

---

### Task 1: Guards + touch CSS

**Files:**
- Modify: `src/core/crypto.ts` (~line 37 `deriveKeys`), `src/ui/SettingTab.ts` (~line 196 `renderActiveTab`), `styles.css`
- Test: `tests/crypto.test.ts`

**Interfaces:** none new; the crypto guard error propagates through existing error paths.

- [ ] **Step 1: Failing test** — append to `tests/crypto.test.ts`:

```ts
describe("webcrypto capability guard", () => {
  it("throws the verbatim error when crypto.subtle is unavailable", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      await expect(encryptFile("pw", "x")).rejects.toThrowError(
        "WebCrypto is unavailable in this environment — Encrypt modes cannot run on this device"
      );
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});
```

(`encryptFile` is already imported in this file.)

- [ ] **Step 2: Verify failure** — `npx vitest run tests/crypto.test.ts` → the new test FAILS (a raw TypeError, not the verbatim message).

- [ ] **Step 3: Implement crypto guard** — in `src/core/crypto.ts`. Note the call order: `encryptRaw` calls `crypto.getRandomValues` BEFORE it reaches `deriveKeys`, so the check must run first in both entry points. Add one helper and call it as the first line of BOTH `encryptRaw` and `deriveKeys`:

```ts
function requireWebCrypto(): void {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("WebCrypto is unavailable in this environment — Encrypt modes cannot run on this device");
  }
}
```

`requireWebCrypto();` as the first line of `encryptRaw` AND `deriveKeys`.

- [ ] **Step 4: SettingTab guard** — in `src/ui/SettingTab.ts`, at the top of `renderActiveTab` (line ~196), before the switch:

```ts
    if (this.activeTab === "sources" && Platform.isMobile) this.activeTab = "general";
```

(`Platform` is already imported in this file — verify, add if not.)

- [ ] **Step 5: Touch CSS** — append to `styles.css` next to the existing `body.is-phone` block, with this exact block:

```css
/* Touch targets — Obsidian sets body.is-mobile on phones and tablets */
body.is-mobile .config-sync-hub-row { min-height: 44px; }

body.is-mobile .config-sync-hub-row input[type="checkbox"],
body.is-mobile .config-sync-mainbar input[type="checkbox"],
body.is-mobile .config-sync-sect input[type="checkbox"] {
  width: 20px;
  height: 20px;
  padding: 8px;
  background-clip: content-box;
  box-sizing: content-box;
}

body.is-mobile .config-sync-fpill,
body.is-mobile .config-sync-seg-btn,
body.is-mobile .config-sync-side-item,
body.is-mobile .config-sync-switcher,
body.is-mobile .config-sync-unchanged,
body.is-mobile .config-sync-more-files {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
}

body.is-mobile .config-sync-side-item,
body.is-mobile .config-sync-switcher,
body.is-mobile .config-sync-unchanged {
  display: flex;
}
```

Then verify the custom-checkbox `::after` glyph still centers with the padding/content-box change (the ✓ pseudo positions against the border box — if it drifts, adjust the `::after` `top`/`left` inside a `body.is-mobile` override rather than touching desktop rules).

- [ ] **Step 6: Gate + commit**

Run: `npm test && npm run build && npm run lint`

```bash
git add src/core/crypto.ts src/ui/SettingTab.ts styles.css tests/crypto.test.ts
git commit -m "fix: webcrypto guard, mobile touch targets, remotes-tab runtime guard"
```

---

### Task 2: emulateMobile smoke (controller)

No file changes. Guard first (standalone), then:
1. `npm run smoke:install`; reload plugin.
2. `app.emulateMobile(true)` (the eval connection may drop during the UI reload — reconnect and re-guard).
3. Verify: plugin loaded; Sync Center opens; remotes absent (sidebar + settings nav); measured sizes meet minimums — checkbox hit (content+padding) ≥ 36px, fpill/seg/side-item/fold-lines ≥ 36px, row ≥ 44px; checkbox ✓ glyph visually centered (screenshot one row).
4. `app.emulateMobile(false)`; verify desktop restored (sizes back to compact); `dev:errors` no new entries.
5. Ledger the evidence.

---

## Verification after all tasks

1. Full gate; desktop CSS unchanged (`git diff` on styles.css touches only the new `body.is-mobile` block).
2. Smoke evidence in ledger. Merge --no-ff + cut 0.17.1 are pre-authorized.
