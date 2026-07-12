# Per-Item Sync Modes: Plain / Fields / Encrypt (iter20)

Approved mockup: `.superpowers/brainstorm/9047-1783841141/content/iter20-sync-modes.html` (4 screens). Passphrase model: vault-level, option A. Design principle set by the user: **detection informs, the user decides** — no hard blacklist, no auto-stripping behind the user's back.

## Problem

Five plugins (`remotely-save`, `ioto-update`, `slides-rup`, `config-sync`, `obsidian-config-sync`) are hard-blacklisted ("cannot be synced"). Ground truth (structure survey, values never read):

- `remotely-save`: the whole config is one ~4.4KB encrypted blob (`d`) — field-level handling is impossible, but the user may still legitimately want the file to travel.
- `ioto-update` / `slides-rup`: 3-5 named credential/account keys (`updateAPIKey`, `userAPIKey`, `userEmail`, `userSyncSettingUrl`, `assignedNewSlideLocation`); everything else (~85 keys in slides-rup) is benign preferences the user *wants* synced.
- `config-sync` itself: only `remotes` is machine-bound (absolute `storePath`, possibly credentialed git URLs); the rest is portable preferences.

A hardcoded per-plugin blacklist is neither safe (any future plugin with a token is unprotected) nor respectful of user intent.

## Design

### 1. Per-item sync mode

Each group gains a mode (manifest schema):

```jsonc
{
  "name": "plugin-ioto-update",
  "path": "{configDir}/plugins/ioto-update/data.json",
  "type": "file",
  "mode": "fields",                    // "plain" (default) | "fields" | "encrypted"
  "fields": [                          // fields mode only
    { "pattern": "updateAPIKey", "action": "encrypt" },
    { "pattern": "userEmail",    "action": "strip" }
  ]
}
```

- **plain** — current behavior, untouched.
- **fields** — file groups only. At capture, each key matching a `pattern` (case-insensitive glob, matched against every key at every nesting depth — same matcher as today's `sanitize`) is processed per its `action`: `strip` removes it from the stored copy (apply keeps the local value, exactly like today's sanitize); `encrypt` replaces the value with a field envelope (below); apply decrypts envelopes back to plaintext and, for stripped keys, preserves the local value.
- **encrypted** — the whole file is stored as an envelope; works for `file` groups and for every file inside `dir` groups. Apply decrypts and writes plaintext locally.
- The `sanitize` field is **removed** (superseded by `mode: "fields"` with `action: "strip"`; per the standing no-migration rule, old configs with `sanitize` fail validation with a clear message telling the user to rename to `fields`). `schema/config-sync.schema.json` updated accordingly.

### 2. Crypto (core, zero dependencies)

`src/core/crypto.ts`, using `globalThis.crypto.subtle` (available in the Obsidian renderer and in Node ≥18 for vitest; `src/core` stays import-free of platform modules):

- Key derivation: PBKDF2-SHA256, 210000 iterations, per-envelope random 16-byte salt → 64 bytes split into an AES-256-GCM key and an HMAC-SHA256 key.
- Whole-file envelope (stored at the same store-relative path):
  `{"csenc":1,"salt":"<b64>","iv":"<b64>","ct":"<b64>","mac":"<b64>"}`
  where `mac = HMAC(plaintext)` under the derived HMAC key.
- Field envelope (a JSON string value): `"enc:v1:<salt_b64>:<iv_b64>:<ct_b64>:<mac_b64>"`.
- **Deterministic comparison** (fixes the random-IV problem): a file/field is "unchanged" iff `HMAC(local canonical plaintext)` under the envelope's salt equals the envelope's `mac`. Status, compare-before-write in capture, and remote deep-diff all use this rule — a re-capture with unchanged content writes nothing.
- Decrypt failures (wrong passphrase, tampered data — GCM auth) surface as clear errors naming the group and the likely cause ("passphrase mismatch on this device?"); apply never writes a partial file.

### 3. Passphrase (vault-level, device-local)

- Stored via `app.saveLocalStorage("config-sync-passphrase")` — **never in any file**, so it can never enter the store or ride note-sync; each device enters it once in Settings → General.
- Cross-device contract: same passphrase on both ends is sufficient (salt/iv travel in the envelope).
- Settings → General gains a password field + Set/Clear, with status text ("set on this device" / "not set").
- Missing passphrase with encrypted content in play: capture/apply of affected items fail with `passphrase not set on this device — Settings → General`; their status becomes a new `GroupState` `"locked"` (icon `🔒`, tooltip `encrypted — set the passphrase in settings to compare`), bucketed into `none` (nothing actionable), expand note verbatim: `encrypted — set the passphrase in Settings → General to compare or apply`.
- Changing the passphrase: old envelopes stay decryptable only by the old one; the settings description says re-capture after changing it.

### 4. Detection — informs, never decides

- A pure scanner in core: key-pattern hits (`apikey`, `api_key`, `token`, `secret`, `password`, `credential`, `auth`, `cookie`, `email` — case-insensitive substring on key names, recursive) and opaque-blob detection (a single string value ≥1024 chars making up >80% of the file).
- Settings panel: detected items show a warning badge (`⚠ N sensitive-looking keys`, listing them in the description; `⚠ opaque encrypted blob` for the blob case) on every item row regardless of mode. Suggestions only: when the user first switches a detected item's mode to `fields`, the detected keys are prefilled as rules (credential-patterned keys default `encrypt`, others `strip`), all editable. Blob-detected items suggest `encrypted`.
- Capture never blocks or auto-modifies plain-mode items.

### 5. Blacklist removal

- `BLACKLISTED_PLUGIN_DIRS`, its manifest validation error, and the plugins "Not recommended" section are deleted. All five plugins become normal, toggleable items (with detection badges doing the informing).
- The **workspace-file** "Not recommended" section (device-specific layout) is unrelated and stays.

### 6. Settings UI

Per mockup ① / ②:
- Each item row gains a three-segment mode control `Plain | Fields | Encrypt` (visible when the item is enabled; `dir`-type items offer `Plain | Encrypt` only).
- `Fields` selected → inline editor under the row: one row per rule (`pattern` + `Strip | Encrypt` two-segment + remove ✕), `detected` tag on prefilled ones, an add-pattern input + Add button.
- Mode and rules persist into `config-sync.json` (the manifest is the single source of truth, as today).

### 7. Sync Center & reports

Per mockup ④:
- Item rows show a mode badge after the name: `🔒` (encrypted) / `▤` (fields). Expanded file lines annotate `(encrypted)` or `(N encrypted · M stripped)`.
- Capture reports state per item what was done, verbatim style: `encrypted updateAPIKey, userAPIKey · stripped userEmail, updateIDs` or `whole file encrypted`.
- `locked` rows: no checkbox action (disabled like in-sync), note per §3.

## Copy strings (verbatim)

| Context | String |
|---|---|
| Mode segments | `Plain` / `Fields` / `Encrypt` |
| Field actions | `Strip` / `Encrypt` |
| Detection badges | `⚠ {n} sensitive-looking keys` / `⚠ opaque encrypted blob` |
| Passphrase setting name/desc | `Passphrase` / `Needed for Encrypt modes. Enter the same passphrase on each device; it is never stored in the store or synced.` |
| Missing-passphrase error | `passphrase not set on this device — Settings → General` |
| Mismatch error | `cannot decrypt "{group}" — wrong passphrase on this device?` |
| locked expand note | `encrypted — set the passphrase in Settings → General to compare or apply` |
| Add pattern placeholder | `Add key pattern… e.g. *Token*` |

## Testing

- Core (vitest, real crypto): round-trip whole-file and field envelopes; deterministic compare (same plaintext → unchanged across captures; changed plaintext → detected); wrong passphrase → clean error; fields mode strip+encrypt+apply restores exact original JSON; scanner detection (keys + blob); manifest validation of `mode`/`fields`, rejection of legacy `sanitize`.
- Live smoke: passphrase set/unset flows, encrypt a real plugin config end-to-end (capture → wipe local → apply → byte-identical restore), fields mode on a staged file, `locked` state without passphrase, detection badges in settings, blacklist gone (all five items toggleable), Sync Center badges + report annotations.

## Non-goals

- No passphrase strength meter, no key rotation tooling (re-capture is the rotation story), no per-item passphrases, no encryption of the store lock/manifest.
- No change to remotes/transport, awareness, or the Sync Center layout beyond the badges.
