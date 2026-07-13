# Mobile Hardening (iter21)

Inputs: a very-thorough static audit of `src/` (17 findings, 3 actionable) plus a live `emulateMobile` pass in the dev vault. Both confirm the mobile posture is fundamentally sound — all Node/Electron access sits behind dynamic `import()` + `Platform.isDesktop`, remotes are gated at one accessor (`main.ts` `remotes()`), CSS keys off `body.is-phone`, and under emulation the plugin loads clean, the Sync Center opens, remotes are hidden on both surfaces, and `crypto.subtle` is present. This iteration closes the three hardening gaps the audit found.

## Changes

### 1. WebCrypto capability check (audit #10)

`src/core/crypto.ts`: if `globalThis.crypto?.subtle` is undefined (possible on unusual embedded/OEM webviews), Encrypt-mode operations currently throw a raw `TypeError` deep inside async code. Add a guard at the single key-derivation entry point that throws a clear `Error` instead, message verbatim:

`WebCrypto is unavailable in this environment — Encrypt modes cannot run on this device`

It propagates through the existing per-group error surfaces like any crypto error.

### 2. Touch targets on mobile (audit #16, measured)

Measured under emulation: staging checkbox hit area **15px**, filter pills **25px**, item rows **38px** (Obsidian's own toggle: 30px; touch guidance: ≥40px effective). Row taps expand — they do NOT toggle the checkbox — so the 15px box is the only staging target on phones.

Under `body.is-mobile` (tablets have fingers too; desktop rules unchanged):

- Staging/section checkboxes: visual box grows to 20×20px and gains an expanded hit area (transparent padding or `::before` overlay) totaling ≥36×36px.
- `.config-sync-fpill`, `.config-sync-seg-btn`, `.config-sync-side-item`, `.config-sync-switcher`, the ✓/○ fold lines and `… N more files` line: `min-height: 36px` with vertically centered content (padding, not font changes).
- Item rows: padding bump so the row itself reaches ≥44px.

Pure CSS; no markup changes beyond what a hit-area pseudo-element needs.

### 3. Settings sources-tab runtime guard (audit #7)

`src/ui/SettingTab.ts`: the Remotes tab is nav-hidden on mobile but `renderActiveTab()` trusts `activeTab` never to be `"sources"`. Add the defense-in-depth reset at the top of the render path: on mobile, an `activeTab === "sources"` falls back to `"general"`.

## Testing

- Unit: none new required beyond a crypto guard test (mock `globalThis.crypto` absent → verbatim error; restore after).
- Live: `emulateMobile(true)` round — plugin loads, Sync Center + settings behave, measured hit sizes meet the new minimums, remotes hidden; `emulateMobile(false)` restore. (True-device WKWebView behavior cannot be automated; the README already documents mobile support and nothing here changes runtime logic beyond the guard.)

## Non-goals

- No feature changes; no phone-specific redesign beyond hit areas; no change to the desktop look; no remotes-on-mobile work.
