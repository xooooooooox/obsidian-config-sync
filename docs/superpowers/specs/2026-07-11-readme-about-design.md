# README rewrite + GitHub About — design

**Status:** approved for planning
**Date:** 2026-07-11
**Scope:** docs/metadata only — no plugin code. The README is now the community-directory listing body (plugin is live as `config-sync`); it must serve strangers deciding whether to install, and several sections describe UI that no longer exists.

## 1. README.md (English, rewritten)

Structure (in order):

1. `# Config Sync` + badges (latest GitHub release; community-plugin downloads via the standard shields endpoint `https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&query=%24%5B%22config-sync%22%5D.downloads&label=downloads` style — plan pins the exact URLs) + one-paragraph pitch + language link `**English** · [中文](README.zh.md)`.
2. **Screenshots** — 2–3 images from `docs/assets/` (§3).
3. **Features** — bullets: pick exactly what syncs (options/core/community-plugin configs, snippets, themes, vault-root dotfiles); credential-safe (`sanitize` key globs; local values survive applies); explicit per-device **Apply** with one-slot backup + **Revert**; **Status** drift view (what changed where, remote freshness); transports: your existing note sync by default, git or another vault on desktop; works on mobile (capture/apply/status).
4. **Install** — Community plugins first (Settings → Community plugins → search "Config Sync"), BRAT as the beta alternative.
5. **Quick start** — 3 steps: tick items → Capture → (other device) Apply.
6. **How it works** — the two-plane section, compressed and updated to 0.11 reality (Status command, menu change counts).
7. **Settings guide** — current tabs; the Advanced description rewritten to the summary-row/expand reality (Managed: expand-to-edit + reset; Discovered: toggle on/off, name+path fixed; Custom: your own), Status/menu-count toggles under General, Remotes with Browse.
8. **Store layout** + `config-sync.json` example — kept; blacklist line lists both plugin ids (`config-sync`, `obsidian-config-sync`).
9. **Walkthroughs** — kept with copy touch-ups; **Security & privacy**, **Development**, **Releasing** — kept as-is apart from stale-term fixes.

Every claim must match 0.11.0 behavior; the stale Lock all/Unlock all and name-the-discovered-file passages are the known offenders to purge.

## 2. README.zh.md (Chinese mirror)

Full translation of the final English README, same structure and images, header link back (`[English](README.md) · **中文**`). Translation only — no divergent content. English README is canonical; zh notes at top nothing (keep it clean).

## 3. Screenshots (`docs/assets/`)

Captured from the dev vault via obsidian-cli `dev:screenshot` at current (default dark) theme:

- `settings-picker.png` — Community plugins tab with a few items toggled.
- `status-modal.png` — Status modal showing a mix of states (stage local-changed + store-newer + in-sync first, as done in the iter-12 smoke).
- `apply-picker.png` — Apply picker with a pre-selected store-newer row and the overwrite hint visible.

Referenced by relative path from both READMEs. Crop/window sizing best-effort (dev:screenshot captures the window; acceptable). Staged smoke files are cleaned up after capture (same discipline as iter-12 smoke).

## 4. GitHub About (user-approved copy)

Set via `gh repo edit`:

- Description: `Selective, on-demand sync of Obsidian settings — hotkeys, snippets, plugin configs — across devices and vaults. Rides your note sync, or git/vault remotes.`
- Topics: `obsidian`, `obsidian-plugin`, `settings-sync`, `sync`, `configuration`
- Homepage: `https://community.obsidian.md/plugins/config-sync`

## Error handling / testing

No code paths. Gate still runs per task (`npm test`/`build`/`lint` must stay green — docs-only diffs). Verification: markdown renders on GitHub (image paths resolve), badges load, both language links work, `gh repo view` reflects About fields, README claims spot-checked against the 0.11.0 UI in the dev vault.

## Non-goals

Light-theme screenshot variants; GIF/video; docs site; CHANGELOG file; any plugin code change.
